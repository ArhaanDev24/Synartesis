#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { ManifestError, SynartesisError, describe } from "./errors.js";
import { draftManifest } from "./init/draft.js";
import { loadManifest, parseManifest } from "./manifest/load.js";
import { openJournal, type ActionClass, type ActionRow, type Journal } from "./journal/journal.js";
import { verifyAgainstServers } from "./manifest/verify.js";
import { createRouter } from "./proxy/routing.js";
import { connectStdioUpstream, type Upstream } from "./proxy/upstream.js";
import { rollback, type RollbackReport } from "./rollback/rollback.js";

const USAGE = `synartesis - an undo layer for AI agents

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
  const path = flag(argv, "--manifest") ?? "synartesis.yaml";
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

  out(`${path} is valid`);
  out(`  servers:  ${Object.keys(manifest.servers).join(", ")}`);
  out(`  policies: ${[...counts].map(([k, v]) => `${String(v)} ${k}`).join(", ")}`);
  out(`  gated:    ${String(gated)}`);
  out("");
  out("Anything this manifest does not mention is treated as irreversible and gated.");
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

  out(`${present ? "extended" : "wrote"} ${path}`);
  out("");
  out("Every tool is gated until you say how to undo it. Work through the TODOs,");
  out("then point your MCP client at:");
  out(`  synartesis-proxy --manifest ${path}`);
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
  out(`${"run (most recent first)".padEnd(36)}  ${"started".padEnd(24)}  ${"status".padEnd(12)}  actions  label`);
  for (const run of runs) {
    const actions = journal.getActions(run.id);
    const unknown = actions.filter((action) => action.status === "pending").length;
    const waiting = actions.filter((action) => action.status === "gated").length;
    const notes = [
      unknown === 0 ? "" : `${String(unknown)} of unknown outcome`,
      waiting === 0 ? "" : `${String(waiting)} awaiting approval`,
    ].filter((note) => note !== "");
    out(
      `${run.id}  ${run.startedAt}  ${run.status.padEnd(12)}  ${String(actions.length).padStart(7)}  ` +
        `${run.label ?? "-"}${notes.length === 0 ? "" : `  (${notes.join("; ")})`}`,
    );
  }
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

  out(`run     ${run.id}`);
  out(`label   ${run.label ?? "-"}`);
  out(`started ${run.startedAt}`);
  out(`status  ${run.status}${run.endedAt === undefined ? "" : `  ended ${run.endedAt}`}`);

  const actions = journal.getActions(runId);
  if (actions.length === 0) {
    out("");
    out("no actions recorded");
    return 0;
  }

  out("");
  // Two extra columns of padding for the per-class marker on each row.
  out(`  seq    ${"class".padEnd(12)} ${"status".padEnd(13)} tool`);
  out(`  ---  ${"-".repeat(14)} ${"-".repeat(13)} ${"-".repeat(24)}`);
  for (const action of actions) {
    out(
      `  ${String(action.seq).padStart(3)}  ${CLASS_MARK[action.class]} ${action.class.padEnd(12)} ` +
        `${action.status.padEnd(13)} ${action.server}.${action.tool}`,
    );
    out(`       ${truncate(JSON.stringify(action.args), 96)}`);
    if (action.approvedAt !== undefined) {
      const verb = action.status === "denied" ? "denied" : "approved";
      out(`       ${verb} by ${action.approvedBy ?? "timeout"} at ${action.approvedAt}`);
    }
    if (action.error !== undefined) {
      out(`       note: ${truncate(action.error, 200)}`);
    }
    if (action.inverse !== undefined) {
      out(`       undo: ${truncate(JSON.stringify(action.inverse), 200)}`);
    }
  }

  out("");
  out(summarise(actions));
  return 0;
}

const CLASS_MARK: Record<ActionClass, string> = {
  readonly: " ",
  reversible: "<",
  compensable: "~",
  irreversible: "!",
  unclassified: "?",
};

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

function runGates(journal: Journal, asJson: boolean): number {
  const waiting = journal.listGated();
  if (asJson) {
    out(JSON.stringify(waiting));
    return 0;
  }
  if (waiting.length === 0) {
    out("nothing is awaiting approval");
    return 0;
  }
  for (const action of waiting) {
    out(`${action.id}  ${action.ts}  ${action.server}.${action.tool}  ${JSON.stringify(action.args)}`);
  }
  out("");
  out("approve with: synartesis approve <actionId> --by <name>");
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
    out(`${approving ? "approved" : "denied"} ${action.server}.${action.tool} (${action.id})`);
  }
  return failed === 0 ? 0 : 1;
}

function report(result: RollbackReport): number {
  out(result.dryRun ? `dry run for ${result.runId}` : `undo ${result.runId}`);
  for (const step of result.steps) {
    const verified = step.kind === "revert" && !step.verified ? "  [unverified]" : "";
    out(
      `  ${String(step.seq).padStart(4)}  ${step.kind.padEnd(16)} ${step.server}.${step.tool}` +
        `  ${step.reason}${verified}`,
    );
    if (step.plan !== undefined && step.kind === "revert") {
      const verb = `${step.replanned === true ? "replanned, " : ""}${result.dryRun ? "would call" : "called"}`;
      out(`        ${verb} ${step.plan.server}.${step.plan.tool} ${JSON.stringify(step.plan.args)}`);
    }
  }
  if (result.halted !== undefined) {
    out("");
    out(`halted at sequence ${String(result.halted.seq)}: ${result.halted.reason}`);
    if (result.halted.detail !== "") {
      out(result.halted.detail);
    }
  }
  out("");
  out(`status: ${result.status}`);
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

  const manifest = loadManifest(flag(argv, "--manifest") ?? "synartesis.yaml");
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
    process.stdout.write(USAGE);
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
  const journal = openJournal(flag(argv, "--journal") ?? ".synartesis/journal.db");
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
    process.stderr.write(`synartesis: ${error.message}\n\n${USAGE}`);
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
