#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { ManifestError, SynartesisError, describe } from "./errors.js";
import { draftManifest } from "./init/draft.js";
import { parseManifest } from "./manifest/load.js";
import { openJournal, type ActionClass, type ActionRow, type Journal } from "./journal/journal.js";
import { loadManifest } from "./manifest/load.js";
import { createRouter } from "./proxy/routing.js";
import { connectStdioUpstream, type Upstream } from "./proxy/upstream.js";
import { rollback, type RollbackReport } from "./rollback/rollback.js";

const USAGE = `synartesis - an undo layer for AI agents

  synartesis init <server> -- <command> [args...]  [--manifest <path>]
  synartesis list [--journal <path>]
  synartesis show <runId> [--journal <path>]
  synartesis gates [--journal <path>]
  synartesis approve <actionId> [--by <name>] [--journal <path>]
  synartesis deny <actionId> [--by <name>] [--reason <text>] [--journal <path>]
  synartesis undo <runId> [--to <seq>] [--dry-run]
                          [--manifest <path>] [--journal <path>]

  --manifest  default synartesis.yaml
  --journal   default .synartesis/journal.db
  --to        lowest sequence to undo; earlier actions are left alone
  --by        who is making the decision; recorded in the journal
  --force     let init overwrite an existing manifest
  --json      machine-readable output for list, show and gates
  --dry-run   read current state and print the plan without changing anything

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
  const runId = positional(argv)[1];
  if (runId === undefined) {
    throw new UsageError("show needs a run id");
  }
  const run = journal.getRun(runId);
  if (run === undefined) {
    throw new UsageError(`no run with id ${runId}`);
  }

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
  const actionId = positional(argv)[1];
  if (actionId === undefined) {
    throw new UsageError(`${approving ? "approve" : "deny"} needs an action id`);
  }
  const action = journal.getAction(actionId);
  if (action === undefined) {
    throw new UsageError(`no action with id ${actionId}`);
  }

  const by = flag(argv, "--by") ?? "unknown";
  const changed = approving
    ? journal.approve(actionId, by)
    : journal.deny(actionId, by, flag(argv, "--reason") ?? "denied by operator");

  if (!changed) {
    // A decision that arrives after a timeout must not silently look like it
    // took effect.
    const now = journal.getAction(actionId);
    process.stderr.write(
      `synartesis: ${actionId} is no longer awaiting approval (it is ${now?.status ?? "gone"})\n`,
    );
    return 1;
  }
  out(`${approving ? "approved" : "denied"} ${action.server}.${action.tool} (${actionId})`);
  return 0;
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
      const verb = result.dryRun ? "would call" : "called";
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
  const runId = positional(argv)[1];
  if (runId === undefined) {
    throw new UsageError("undo needs a run id; run `synartesis list` to see them");
  }
  if (journal.getRun(runId) === undefined) {
    throw new UsageError(`no run with id ${runId}`);
  }

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

  if (command === "init") {
    // The only command that runs before a journal could exist.
    return await runInit(argv);
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
