#!/usr/bin/env node
/**
 * better-sqlite3 requires Node 22, and on Node 20 it does not fail politely:
 * it segfaults the moment a database is opened. Saying so is better than
 * letting somebody meet exit code 139.
 */
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 22) {
  process.stderr.write(
    `synartesis: needs Node 22 or newer, and this is ${process.version}.\n`,
  );
  process.exit(2);
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { ManifestError, SynartesisError, describe } from "./errors.js";
import { draftManifest } from "./init/draft.js";
import { loadManifest, parseManifest } from "./manifest/load.js";
import { labelFor, openJournal, wasRefused, type ActionClass, type ActionRow, type Journal } from "./journal/journal.js";
import { verifyAgainstServers } from "./manifest/verify.js";
import { createRouter } from "./proxy/routing.js";
import { connectStdioUpstream, type Upstream } from "./proxy/upstream.js";
import { rollback, type RollbackReport } from "./rollback/rollback.js";
import { banner, rule, style } from "./style.js";
import { findJournal, findManifest } from "./locate.js";
import { watch } from "./watch.js";
import { openConsole } from "./console.js";
import { cliCommand, proxyCommand } from "./invocation.js";

const COMMANDS = `
  synartesis                                      the screen; everything below,
                                                  driven with the arrow keys
  synartesis init <server> -- <command> [args...]  [--manifest <path>]
  synartesis check [--manifest <path>]
  synartesis list [--journal <path>]
  synartesis show <runId> [--journal <path>]
  synartesis gates [--journal <path>]
  synartesis close [runId] [--journal <path>]
  synartesis proxy --manifest <path> [--journal <path>]   what your agent runs
  synartesis watch [--by <name>] [--journal <path>]
  synartesis approve [actionId|--all] [--by <name>] [--journal <path>]
  synartesis deny [actionId|--all] [--by <name>] [--reason <text>] [--journal <path>]
  synartesis undo [runId] [--to <seq>] [--dry-run] [--replan]
                          [--manifest <path>] [--journal <path>]

close ends a run left active by a proxy that was killed; nothing guesses at
that, since several proxies can share one journal.

Ids may be shortened to any unambiguous prefix. show and undo default to the
most recent run; approve and deny default to the only request waiting. init
adds to an existing manifest rather than replacing it.

watch is the one to leave running. Anything held for approval appears there,
and a and d answer it without a second terminal or an id to copy.

  --manifest  synartesis.yaml, looked for here and upwards, then in the home
  --journal   beside the manifest, or the one in the home
  --to        lowest sequence to undo; earlier actions are left alone
  --by        who is deciding; defaults to the logged-in user
  --all       approve or deny everything currently waiting
  --once      watch prints the current state and exits
  --json      machine-readable output for list, show and gates
  --dry-run   read current state and print the plan without changing anything
  --replan    rebuild each undo from the current manifest, for a run recorded
              under a policy that turned out to be wrong

Neither path usually needs giving. A policy that belongs to a project sits in
it and is found from any directory inside it, the way a version control tool
finds its root; anything else lives in ~/.synartesis, which is where the
journal is too. Set SYNARTESIS_HOME to put that somewhere else.

Exit codes: 0 complete, 1 halted or partial, 2 bad usage or configuration.
`;

class UsageError extends Error {}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at === -1) {
    return undefined;
  }
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${name} needs a value`);
  }
  return value;
}

function positional(argv: readonly string[]): string[] {
  const skip = new Set(["--manifest", "--journal", "--to", "--by", "--reason", "--gate-timeout"]);
  const values: string[] = [];
  // Everything after `--` belongs to the wrapped command, not to us.
  const end = argv.indexOf("--");
  const ours = end === -1 ? argv : argv.slice(0, end);
  for (let i = 0; i < ours.length; i += 1) {
    const token = ours[i] ?? "";
    if (skip.has(token)) {
      i += 1;
      continue;
    }
    if (!token.startsWith("--")) {
      values.push(token);
    }
  }
  return values;
}

/**
 * Loads a manifest and checks it against the servers it names, without
 * touching a journal or serving anything. This is what you run before wiring
 * a policy into a client, rather than finding out from a client that will not
 * start.
 */
async function runCheck(argv: readonly string[]): Promise<number> {
  const path = findManifest(flag(argv, "--manifest"));
  const manifest = loadManifest(path);

  const upstreams: Upstream[] = [];
  try {
    for (const [name, spec] of Object.entries(manifest.servers)) {
      upstreams.push(
        await connectStdioUpstream({
          name,
          command: spec.command,
          args: spec.args,
          stderr: "capture",
          ...(spec.env === undefined ? {} : { env: spec.env }),
        }),
      );
    }
    await verifyAgainstServers(upstreams, manifest);
  } finally {
    for (const upstream of upstreams) {
      await upstream.close();
    }
  }

  const counts = new Map<string, number>();
  for (const policy of manifest.tools) {
    counts.set(policy.class, (counts.get(policy.class) ?? 0) + 1);
  }
  const gated = manifest.tools.filter((policy) => policy.gate !== "never").length;

  out("");
  out(`  ${style.label("policy")}  ${style.strong(path)}`);
  out(`  ${rule(54)}`);
  out("");
  out(`  ${style.quiet("servers ")} ${Object.keys(manifest.servers).join(", ")}`);
  out(`  ${style.quiet("policies")} ${[...counts].map(([k, v]) => `${String(v)} ${k}`).join(", ")}`);
  out(`  ${style.quiet("guarded ")} ${style.accent(String(gated))}`);
  out("");
  out(`  ${style.quiet("Anything not mentioned here is treated as irreversible and guarded.")}`);
  out("");
  return 0;
}

async function runInit(argv: readonly string[]): Promise<number> {
  const name = positional(argv)[1];
  const separator = argv.indexOf("--");
  const command = separator === -1 ? undefined : argv[separator + 1];
  if (name === undefined || command === undefined) {
    throw new UsageError("init needs a server name and a command, as: init crm -- npx -y some-mcp-server");
  }
  if (name.includes(".") || name.includes("__")) {
    throw new UsageError(`server name ${name} may not contain "." or "__"; both qualify tool names`);
  }

  // The home unless a project already has one above where you are standing.
  // Setting a server up should not mean choosing a directory to keep it in.
  const path = findManifest(flag(argv, "--manifest"));
  const force = argv.includes("--force");
  const present = existsSync(path);
  if (present && force) {
    throw new UsageError(
      `--force would discard ${path}. Delete it yourself if that is what you want; init will otherwise add to it.`,
    );
  }

  const draft = await draftManifest({
    name,
    command,
    args: argv.slice(separator + 2),
    ...(present ? { existing: readFileSync(path, "utf8") } : {}),
  });

  // Never write a manifest that would not start: a drafted policy that fails
  // to load is worse than no policy, because it looks finished.
  parseManifest(draft.yaml, path);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, draft.yaml);

  out("");
  out(`  ${style.label(present ? "extended" : "wrote")}  ${style.strong(path)}`);
  out(`  ${rule(54)}`);
  out("");
  if (draft.adopted === undefined) {
    out(`  ${style.quiet("Every tool is guarded until you say how to undo it.")}`);
    out(`  ${style.quiet("Work through the TODOs, then point your MCP client at:")}`);
  } else {
    out(
      `  ${style.quiet(`Recognised ${String(draft.adopted.tools)} tools, so the policy that ships for`)} ` +
        `${style.strong(draft.adopted.server)} ${style.quiet("was used.")}`,
    );
    out(`  ${style.quiet("Read it before you trust it, then point your MCP client at:")}`);
  }
  out("");
  out(`  ${style.accent(`${proxyCommand()} --manifest ${resolve(path)}`)}`);
  out("");
  return 0;
}

/**
 * Ids are uuids, and copying one between two terminals is the clunkiest part
 * of using this. Any unambiguous prefix will do, and where there is only one
 * sensible answer, no id is needed at all.
 */
interface Noun {
  readonly one: string;
  readonly many: string;
}

/**
 * `newest` is for the commands whose default is a run rather than the only
 * candidate. show and undo have always been documented as defaulting to the
 * most recent run; without this that held only until a second run existed,
 * after which both refused and listed every id -- offering --all, which
 * neither of them takes. approve and deny stay strict: "the only one waiting"
 * is a different promise, and guessing which of several to allow is not a
 * guess anything should make.
 */
function pick<T extends { id: string }>(
  candidates: readonly T[],
  given: string | undefined,
  noun: Noun,
  newest = false,
): T {
  const listed = (items: readonly T[]): string =>
    items.map((item) => `  ${item.id}`).join("\n");

  if (given === undefined) {
    const [only, ...rest] = candidates;
    if (only === undefined) {
      throw new UsageError(`there is no ${noun.one} to act on`);
    }
    if (rest.length > 0 && !newest) {
      throw new UsageError(
        `there are ${String(candidates.length)} ${noun.many}; name one, or use --all:\n${listed(candidates)}`,
      );
    }
    return only;
  }

  const exact = candidates.find((item) => item.id === given);
  if (exact !== undefined) {
    return exact;
  }
  const matches = candidates.filter((item) => item.id.startsWith(given));
  const [first, ...rest] = matches;
  if (first === undefined) {
    throw new UsageError(`no ${noun.one} matches ${given}`);
  }
  if (rest.length > 0) {
    throw new UsageError(
      `${given} matches ${String(matches.length)} ${noun.many}:\n${listed(matches)}`,
    );
  }
  return first;
}

const RUN: Noun = { one: "run", many: "runs" };
const WAITING: Noun = { one: "action awaiting approval", many: "actions awaiting approval" };

// Piping into head or less closes the pipe early. That is the reader saying it
// has seen enough, not an error, and a stack trace there is pure noise.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function runList(journal: Journal, asJson: boolean): number {
  // Most recent first: the run someone wants to undo is nearly always the last
  // thing that happened.
  const runs = [...journal.listRuns()].reverse();
  if (asJson) {
    out(JSON.stringify(runs.map((run) => ({ ...run, actions: journal.getActions(run.id).length }))));
    return 0;
  }
  if (runs.length === 0) {
    out("no runs recorded");
    return 0;
  }
  out("");
  out(`  ${style.label("runs")}  ${style.quiet("most recent first")}`);
  out(`  ${rule(96)}`);
  out("");
  out(
    style.quiet(
      `  ${"run".padEnd(36)}  ${"started".padEnd(24)}  ${"status".padEnd(12)}  actions  agent`,
    ),
  );
  for (const run of runs) {
    const actions = journal.getActions(run.id);
    const unknown = actions.filter((action) => action.status === "pending").length;
    const waiting = actions.filter((action) => action.status === "gated").length;
    const notes = [
      unknown === 0 ? "" : `${String(unknown)} of unknown outcome`,
      waiting === 0 ? "" : `${String(waiting)} awaiting approval`,
    ].filter((note) => note !== "");
    const note =
      notes.length === 0 ? "" : `  ${style.accent(`(${notes.join("; ")})`)}`;
    out(
      `  ${style.strong(run.id)}  ${style.quiet(run.startedAt)}  ${run.status.padEnd(12)}  ` +
        `${String(actions.length).padStart(7)}  ${run.label ?? "-"}${note}`,
    );
  }
  out("");
  return 0;
}

function runShow(argv: readonly string[], journal: Journal, asJson: boolean): number {
  const runs = [...journal.listRuns()].reverse();
  const run = pick(runs, positional(argv)[1], RUN, true);
  const runId = run.id;

  if (asJson) {
    out(JSON.stringify({ run, actions: journal.getActions(runId) }));
    return 0;
  }

  out("");
  out(`  ${style.label("run")}  ${style.strong(run.id)}`);
  out(`  ${rule(54)}`);
  out("");
  out(`  ${style.quiet("agent  ")} ${run.label ?? "-"}`);
  out(`  ${style.quiet("started")} ${run.startedAt}`);
  out(
    `  ${style.quiet("status ")} ${run.status}` +
      (run.endedAt === undefined ? "" : style.quiet(`  ended ${run.endedAt}`)),
  );

  const actions = journal.getActions(runId);
  if (actions.length === 0) {
    out("");
    out("no actions recorded");
    return 0;
  }

  out("");
  out("");
  out(`  ${style.label("timeline")}`);
  out(`  ${rule(72)}`);
  out("");
  for (const action of actions) {
    out(
      `  ${style.quiet(String(action.seq).padStart(3))}  ${badgeOf(action)} ` +
        `${statusOf(action)}  ${style.strong(`${action.server}.${action.tool}`)}`,
    );
    out(`       ${style.quiet(truncate(JSON.stringify(action.args), 96))}`);
    if (action.approvedAt !== undefined) {
      const verb = action.status === "denied" ? "denied" : "approved";
      out(
        `       ${style.accent(`${verb} by ${action.approvedBy ?? "nobody"}`)} ${style.quiet(`at ${action.approvedAt}`)}`,
      );
    }
    if (action.error !== undefined) {
      out(`       ${style.quiet(`note: ${truncate(action.error, 200)}`)}`);
    }
    if (action.inverse !== undefined) {
      out(`       ${style.quiet("undo:")} ${truncate(JSON.stringify(action.inverse), 200)}`);
    }
  }

  out("");
  out(`  ${summarise(actions)}`);
  out("");
  return 0;
}

const CLASS_MARK: Record<ActionClass, string> = {
  readonly: "\u00b7",
  reversible: "\u2190",
  compensable: "\u2248",
  irreversible: "!",
  unclassified: "?",
};

/** Wide enough for the longest class name plus its marker. */
const BADGE_WIDTH = "irreversible".length + 2;

/** Padded before it is coloured: escape codes are not printable width. */
function badgeOf(action: ActionRow): string {
  const plain = `${CLASS_MARK[action.class]} ${action.class}`.padEnd(BADGE_WIDTH);
  return action.class === "irreversible" ? style.accent(plain) : style.quiet(plain);
}

function statusOf(action: ActionRow): string {
  const text = labelFor(action).padEnd(13);
  if (wasRefused(action)) {
    return style.accent(text);
  }
  if (action.status === "gated") {
    return style.strong(text);
  }
  return style.quiet(text);
}

/**
 * Broken over lines rather than cut off. The reason a call is being held ends
 * with the server's own words, so truncating it removes the only part that
 * says anything the tool name did not already.
 */
function wrapped(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function summarise(actions: readonly ActionRow[]): string {
  const counts = new Map<string, number>();
  for (const action of actions) {
    counts.set(action.status, (counts.get(action.status) ?? 0) + 1);
  }
  const parts = [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${String(v)} ${k}`);
  const undoable = actions.filter((a) => a.inverse !== undefined).length;
  return `${String(actions.length)} actions: ${parts.join(", ")} | ${String(undoable)} with a recorded undo`;
}

/**
 * Repeated back in any command this prints, because whoever copies the line may
 * well be in a different directory than the one it was printed from.
 */
let journalArg = "";

function runClose(argv: readonly string[], journal: Journal): number {
  // Left active by a proxy that was killed rather than disconnected. Nothing
  // can tell that apart from a run still going, so this is asked for, never
  // guessed: several proxies can share one journal.
  const active = journal.listRuns().filter((candidate) => candidate.status === "active");
  const run = pick([...active].reverse(), positional(argv)[1], RUN, true);
  const closed = journal.closeAbandonedRun(run.id);
  out("");
  out(
    closed
      ? `  ${style.label("closed")}  ${style.strong(run.id)}`
      : `  ${style.quiet(`${run.id} was not active.`)}`,
  );
  out("");
  return closed ? 0 : 1;
}

function runGates(journal: Journal, asJson: boolean): number {
  const waiting = journal.listGated();
  if (asJson) {
    out(JSON.stringify(waiting));
    return 0;
  }
  if (waiting.length === 0) {
    out("");
    out(`  ${style.quiet("Nothing is waiting for a decision.")}`);
    out("");
    return 0;
  }
  out("");
  out(`  ${style.label("awaiting approval")}`);
  out(`  ${rule(72)}`);
  out("");
  for (const action of waiting) {
    out(`  ${style.strong(action.id)}  ${style.quiet(action.ts)}`);
    out(`  ${style.accent(`${action.server}.${action.tool}`)}  ${style.quiet(truncate(JSON.stringify(action.args), 88))}`);
    // The reason, because approving is the decision this screen exists for and
    // it was being made on a tool name and a bag of arguments alone.
    for (const [at, line] of wrapped(action.error ?? "held by policy", 76).entries()) {
      out(`  ${at === 0 ? style.quiet(action.class) : " ".repeat(action.class.length)}  ${style.quiet(line)}`);
    }
    out("");
  }
  const self = cliCommand();
  out(
    `  ${style.quiet(`${self} approve`)} ${style.accent(waiting[0]?.id.slice(0, 8) ?? "<id>")} ${style.quiet(`--by <name>${journalArg}`)}`,
  );
  out(`  ${style.quiet(`${self} approve --all --by <name>${journalArg}`)}`);
  out("");
  return 0;
}

function runDecision(argv: readonly string[], journal: Journal, approving: boolean): number {
  const waiting = journal.listGated();
  const given = positional(argv)[1];
  // "unknown" is a poor thing to find in an audit trail when the machine knows
  // perfectly well who is logged in. --by still wins, for approving on behalf
  // of someone else.
  const by =
    flag(argv, "--by") ?? process.env["USER"] ?? process.env["LOGNAME"] ?? "unknown";
  const reason = flag(argv, "--reason") ?? "denied by operator";

  // Looked up among everything first, so an action that has already been
  // settled gets told what became of it rather than "no such action".
  if (given !== undefined) {
    const settled = journal.getAction(given);
    if (settled !== undefined && settled.status !== "gated") {
      process.stderr.write(
        `synartesis: ${given} is no longer awaiting approval (it is ${settled.status})\n`,
      );
      return 1;
    }
  }

  const targets = argv.includes("--all")
    ? waiting
    : [pick(waiting, given, WAITING)];
  if (targets.length === 0) {
    out("nothing is awaiting approval");
    return 0;
  }

  let failed = 0;
  for (const action of targets) {
    const changed = approving
      ? journal.approve(action.id, by)
      : journal.deny(action.id, by, reason);
    if (!changed) {
      // A decision that lands after the action settled must not look like it
      // took effect.
      const now = journal.getAction(action.id);
      process.stderr.write(
        `synartesis: ${action.id} is no longer awaiting approval (it is ${now?.status ?? "gone"})\n`,
      );
      failed += 1;
      continue;
    }
    out(
      `  ${style.accent(approving ? "approved" : "denied")} ${style.strong(`${action.server}.${action.tool}`)} ${style.quiet(action.id)}`,
    );
  }
  return failed === 0 ? 0 : 1;
}

function report(result: RollbackReport): number {
  out("");
  out(`  ${style.label(result.dryRun ? "dry run" : "undo")}  ${style.strong(result.runId)}`);
  out(`  ${rule(72)}`);
  out("");
  let separated = false;
  for (const step of result.steps) {
    // Set apart by a rule rather than mixed in: these are the ones --to is
    // leaving alone, and reading them as part of the plan would invert what
    // they mean.
    if (step.kind === "kept" && !separated) {
      separated = true;
      out("");
      out(`  ${style.quiet("left alone")}`);
    }
    const unverified =
      step.kind === "revert" && !step.verified ? `  ${style.accent("[unverified]")}` : "";
    const kind =
      step.kind === "halt" || step.kind === "permanent"
        ? style.accent(step.kind.padEnd(16))
        : step.kind.padEnd(16);
    out(
      `  ${style.quiet(String(step.seq).padStart(3))}  ${kind} ` +
        `${style.strong(`${step.server}.${step.tool}`)}  ${style.quiet(step.reason)}${unverified}`,
    );
    if (step.plan !== undefined && step.kind === "revert") {
      const verb = `${step.replanned === true ? "replanned, " : ""}${result.dryRun ? "would call" : "called"}`;
      out(
        `       ${style.quiet(verb)} ${step.plan.server}.${step.plan.tool} ` +
          style.quiet(truncate(JSON.stringify(step.plan.args), 120)),
      );
    }
  }
  if (result.halted !== undefined) {
    out("");
    out(
      `  ${style.accent("halted")} ${style.quiet(`at sequence ${String(result.halted.seq)}`)}  ${result.halted.reason}`,
    );
    if (result.halted.detail !== "") {
      for (const line of result.halted.detail.split("\n")) {
        out(`  ${style.quiet(line)}`);
      }
    }
  }
  const permanent = result.steps.filter((step) => step.kind === "permanent");
  if (permanent.length > 0) {
    out("");
    out(
      `  ${style.quiet(`${String(permanent.length)} action${permanent.length === 1 ? "" : "s"} could not be undone and ${permanent.length === 1 ? "was" : "were"} left in place.`)}`,
    );
  }
  out("");
  out(
    `  ${style.label("result")}  ${result.status === "rolled_back" ? result.status : style.accent(result.status)}`,
  );
  out("");
  return result.status === "rolled_back" ? 0 : 1;
}

/**
 * Starting every server the manifest names, undoing, and shutting them down
 * again. Shared, because the console does exactly this when somebody presses
 * u and there must not be two answers to what undo means.
 */
async function performUndo(
  manifestPath: string,
  journal: Journal,
  runId: string,
  options: { dryRun: boolean; toSeq?: number; replan?: boolean },
): Promise<RollbackReport> {
  const manifest = loadManifest(manifestPath);
  const upstreams: Upstream[] = [];
  try {
    for (const [name, spec] of Object.entries(manifest.servers)) {
      upstreams.push(
        await connectStdioUpstream({
          name,
          command: spec.command,
          args: spec.args,
          stderr: "capture",
          ...(spec.env === undefined ? {} : { env: spec.env }),
        }),
      );
    }
    return await rollback({
      journal,
      router: createRouter(upstreams, manifest),
      runId,
      ...(options.toSeq === undefined ? {} : { toSeq: options.toSeq }),
      dryRun: options.dryRun,
      ...(options.replan === true ? { replanWith: manifest } : {}),
    });
  } finally {
    for (const upstream of upstreams) {
      await upstream.close();
    }
  }
}

async function runUndo(argv: readonly string[], journal: Journal): Promise<number> {
  // Defaults to the most recent run: the thing anyone wants to undo is
  // almost always the last thing that happened.
  const runId = pick([...journal.listRuns()].reverse(), positional(argv)[1], RUN, true).id;

  const rawTo = flag(argv, "--to");
  const toSeq = rawTo === undefined ? undefined : Number(rawTo);
  if (toSeq !== undefined && (!Number.isInteger(toSeq) || toSeq < 1)) {
    throw new UsageError("--to needs a positive whole number");
  }
  // Past the end, every action is below the floor, so nothing is planned and
  // the empty plan reads exactly like a run with nothing left to undo. A typed
  // digit too many looked like a result.
  if (toSeq !== undefined) {
    const highest = journal.getActions(runId).reduce((top, action) => Math.max(top, action.seq), 0);
    if (toSeq > highest) {
      throw new UsageError(
        `--to ${String(toSeq)} is past the end of this run, which goes up to ${String(highest)}`,
      );
    }
  }

  return report(
    await performUndo(findManifest(flag(argv, "--manifest")), journal, runId, {
      dryRun: argv.includes("--dry-run"),
      ...(toSeq === undefined ? {} : { toSeq }),
      replan: argv.includes("--replan"),
    }),
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const command = positional(argv)[0];
  if (command === "proxy") {
    // The proxy, run through this command rather than its own binary, so the
    // line people paste into a client config is one package and one word:
    // npx -y synartesis proxy --manifest ... . Loaded only here, and before
    // anything else in this file runs, because from this point stdout carries
    // protocol frames and a banner on it would corrupt the stream.
    await import("./proxy/stdio.js");
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${banner()}\n${COMMANDS}`);
    return 0;
  }
  // Nothing typed opens the screen. Being handed a page of eight commands is a
  // fine answer for a script and a poor one for a person, who wants to see
  // what happened rather than be told the names of the words for asking.
  if (command === undefined) {
    const manifestPath = findManifest(flag(argv, "--manifest"));
    const journalPath = findJournal(flag(argv, "--journal"), manifestPath);
    return await openConsole({
      journalPath,
      write: (text) => process.stdout.write(text),
      live: process.stdout.isTTY,
      decideAs: flag(argv, "--by") ?? process.env["USER"] ?? process.env["LOGNAME"] ?? "unknown",
      undo: async (runId, dryRun) => {
        const journal = openJournal(journalPath, { mustExist: true });
        try {
          return await performUndo(manifestPath, journal, runId, { dryRun });
        } finally {
          journal.close();
        }
      },
    });
  }

  // None of these needs an existing journal, and none should create one.
  if (command === "init") {
    return await runInit(argv);
  }
  if (command === "check") {
    return await runCheck(argv);
  }

  const asJson = argv.includes("--json");
  const given = flag(argv, "--journal");
  const journalPath = findJournal(given, findManifest(flag(argv, "--manifest")));

  // Watching is the one thing you do before anything has happened, so it opens
  // its own handle when there is one and waits when there is not.
  if (command === "watch") {
    const live = process.stdout.isTTY && !argv.includes("--once");
    return await watch({
      journalPath,
      approveWith: cliCommand(),
      write: (text) => process.stdout.write(text),
      live,
      // A decision has to be attributable, so the view can only make one when
      // it knows whose it is.
      decideAs: flag(argv, "--by") ?? process.env["USER"] ?? process.env["LOGNAME"] ?? "unknown",
    });
  }

  // Repeated back only when it was not the obvious one, so a copied command
  // works from anywhere without being cluttered when it need not be.
  journalArg = given === undefined ? "" : ` --journal ${resolve(given)}`;
  // Every remaining command reads an existing journal. Only the proxy makes one.
  const journal = openJournal(journalPath, { mustExist: true });
  try {
    switch (command) {
      case "list":
        return runList(journal, asJson);
      case "show":
        return runShow(argv, journal, asJson);
      case "close":
        return runClose(argv, journal);
      case "gates":
        return runGates(journal, asJson);
      case "approve":
        return runDecision(argv, journal, true);
      case "deny":
        return runDecision(argv, journal, false);
      case "undo":
        return await runUndo(argv, journal);
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } finally {
    journal.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error: unknown) {
  if (error instanceof UsageError) {
    process.stderr.write(`synartesis: ${error.message}\n\n${COMMANDS}`);
    process.exitCode = 2;
  } else if (error instanceof ManifestError) {
    process.stderr.write(`synartesis: ${error.message}\n`);
    process.exitCode = 2;
  } else if (error instanceof SynartesisError) {
    // Without the code. It read as synartesis: JOURNAL_ERROR: journal open
    // failed: ... -- three prefixes before the sentence that says what is
    // wrong. The exit code is the part a script reads.
    process.stderr.write(`synartesis: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`synartesis: ${describe(error)}\n`);
    process.exitCode = 1;
  }
}
