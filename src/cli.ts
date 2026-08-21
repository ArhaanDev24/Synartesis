#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ManifestError, SynartesisError, describe } from "./errors.js";
import { draftManifest } from "./init/draft.js";
import { loadManifest, parseManifest } from "./manifest/load.js";
import { openJournal, type ActionClass, type ActionRow, type Journal } from "./journal/journal.js";
import { verifyAgainstServers } from "./manifest/verify.js";
import { createRouter } from "./proxy/routing.js";
import { connectStdioUpstream, type Upstream } from "./proxy/upstream.js";
import { rollback, type RollbackReport } from "./rollback/rollback.js";
import { banner, rule, style } from "./style.js";
import { findJournal, findManifest } from "./locate.js";
import { cliCommand } from "./invocation.js";

const COMMANDS = `
  synartesis init <server> -- <command> [args...]  [--manifest <path>]
  synartesis check [--manifest <path>]
  synartesis list [--journal <path>]
  synartesis show <runId> [--journal <path>]
  synartesis gates [--journal <path>]
  synartesis approve [actionId|--all] [--by <name>] [--journal <path>]
  synartesis deny [actionId|--all] [--by <name>] [--reason <text>] [--journal <path>]
  synartesis undo [runId] [--to <seq>] [--dry-run] [--replan]
                          [--manifest <path>] [--journal <path>]

Ids may be shortened to any unambiguous prefix. show and undo default to the
most recent run; approve and deny default to the only request waiting.

  --manifest  default synartesis.yaml
  --journal   default .synartesis/journal.db
  --to        lowest sequence to undo; earlier actions are left alone
  --by        who is making the decision; recorded in the journal
  --force     let init overwrite an existing manifest
  --all       approve or deny everything currently waiting
  --json      machine-readable output for list, show and gates
  --dry-run   read current state and print the plan without changing anything
  --replan    rebuild each undo from the current manifest, for a run recorded
              under a policy that turned out to be wrong

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
          stderr: "ignore",
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

  const path = flag(argv, "--manifest") ?? "synartesis.yaml";
  const force = argv.includes("--force");
  const present = existsSync(path);
  if (present && force) {
    throw new UsageError(
      `--force would discard ${path}. Delete it yourself if that is what you want; init will otherwise add to it.`,
    );
  }

  const yaml = await draftManifest({
    name,
    command,
    args: argv.slice(separator + 2),
    ...(present ? { existing: readFileSync(path, "utf8") } : {}),
  });

  // Never write a manifest that would not start: a drafted policy that fails
  // to load is worse than no policy, because it looks finished.
  parseManifest(yaml, path);
  writeFileSync(path, yaml);

  out("");
  out(`  ${style.label(present ? "extended" : "wrote")}  ${style.strong(path)}`);
  out(`  ${rule(54)}`);
  out("");
  out(`  ${style.quiet("Every tool is guarded until you say how to undo it.")}`);
  out(`  ${style.quiet("Work through the TODOs, then point your MCP client at:")}`);
  out("");
  out(`  ${style.accent(`${cliCommand().replace(/cli\.js$/, "proxy.js")} --manifest ${path}`)}`);
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

function pick<T extends { id: string }>(
  candidates: readonly T[],
  given: string | undefined,
  noun: Noun,
): T {
  const listed = (items: readonly T[]): string =>
    items.map((item) => `  ${item.id}`).join("\n");

  if (given === undefined) {
    const [only, ...rest] = candidates;
    if (only === undefined) {
      throw new UsageError(`there is no ${noun.one} to act on`);
    }
    if (rest.length > 0) {
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
  const run = pick(runs, positional(argv)[1], RUN);
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
  const text = action.status.padEnd(13);
  if (action.status === "denied" || action.status === "unrecoverable") {
    return style.accent(text);
  }
  if (action.status === "gated") {
    return style.strong(text);
  }
  return style.quiet(text);
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
  const by = flag(argv, "--by") ?? "unknown";
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
  for (const step of result.steps) {
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

async function runUndo(argv: readonly string[], journal: Journal): Promise<number> {
  // Defaults to the most recent run: the thing anyone wants to undo is
  // almost always the last thing that happened.
  const runId = pick([...journal.listRuns()].reverse(), positional(argv)[1], RUN).id;

  const rawTo = flag(argv, "--to");
  const toSeq = rawTo === undefined ? undefined : Number(rawTo);
  if (toSeq !== undefined && (!Number.isInteger(toSeq) || toSeq < 1)) {
    throw new UsageError("--to needs a positive whole number");
  }

  const manifest = loadManifest(findManifest(flag(argv, "--manifest")));
  const upstreams: Upstream[] = [];
  try {
    for (const [name, spec] of Object.entries(manifest.servers)) {
      upstreams.push(
        await connectStdioUpstream({
          name,
          command: spec.command,
          args: spec.args,
          stderr: "ignore",
          ...(spec.env === undefined ? {} : { env: spec.env }),
        }),
      );
    }
    const result = await rollback({
      journal,
      router: createRouter(upstreams, manifest),
      runId,
      ...(toSeq === undefined ? {} : { toSeq }),
      dryRun: argv.includes("--dry-run"),
      ...(argv.includes("--replan") ? { replanWith: manifest } : {}),
    });
    return report(result);
  } finally {
    for (const upstream of upstreams) {
      await upstream.close();
    }
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const command = positional(argv)[0];
  const askedForHelp = argv.includes("--help") || argv.includes("-h");
  if (askedForHelp || command === undefined) {
    process.stdout.write(`${banner()}\n${COMMANDS}`);
    // Asking for help is not a mistake; being invoked with nothing at all is.
    return askedForHelp ? 0 : 2;
  }

  // Neither of these needs a journal, and neither should create one.
  if (command === "init") {
    return await runInit(argv);
  }
  if (command === "check") {
    return await runCheck(argv);
  }

  const asJson = argv.includes("--json");
  const given = flag(argv, "--journal");
  const journalPath = findJournal(given, findManifest(flag(argv, "--manifest")));
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
    process.stderr.write(`synartesis: ${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`synartesis: ${describe(error)}\n`);
    process.exitCode = 1;
  }
}
