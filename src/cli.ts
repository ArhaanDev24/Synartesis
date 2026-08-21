#!/usr/bin/env node
import { ManifestError, SynartesisError, describe } from "./errors.js";
import { openJournal, type Journal } from "./journal/journal.js";
import { loadManifest } from "./manifest/load.js";
import { createRouter } from "./proxy/routing.js";
import { connectStdioUpstream, type Upstream } from "./proxy/upstream.js";
import { rollback, type RollbackReport } from "./rollback/rollback.js";

const USAGE = `synartesis - an undo layer for AI agents

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
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
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

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function runList(journal: Journal): number {
  const runs = journal.listRuns();
  if (runs.length === 0) {
    out("no runs recorded");
    return 0;
  }
  for (const run of runs) {
    const actions = journal.getActions(run.id);
    const pending = actions.filter((action) => action.status === "pending").length;
    const note = pending === 0 ? "" : `  ${String(pending)} of unknown outcome`;
    out(
      `${run.id}  ${run.startedAt}  ${run.status.padEnd(12)} ${String(actions.length).padStart(4)} actions  ${run.label ?? "-"}${note}`,
    );
  }
  return 0;
}

function runShow(argv: readonly string[], journal: Journal): number {
  const runId = positional(argv)[1];
  if (runId === undefined) {
    throw new UsageError("show needs a run id");
  }
  const run = journal.getRun(runId);
  if (run === undefined) {
    throw new UsageError(`no run with id ${runId}`);
  }

  out(`run     ${run.id}`);
  out(`label   ${run.label ?? "-"}`);
  out(`started ${run.startedAt}`);
  out(`status  ${run.status}${run.endedAt === undefined ? "" : `  ended ${run.endedAt}`}`);
  out("");
  for (const action of journal.getActions(runId)) {
    out(
      `${String(action.seq).padStart(4)}  ${action.class.padEnd(13)} ${action.status.padEnd(13)} ` +
        `${action.server}.${action.tool}  ${JSON.stringify(action.args)}`,
    );
    if (action.approvedBy !== undefined || action.approvedAt !== undefined) {
      const verb = action.status === "denied" ? "denied" : "approved";
      out(`        ${verb} by ${action.approvedBy ?? "timeout"} at ${action.approvedAt ?? "-"}`);
    }
    if (action.error !== undefined) {
      out(`        note: ${action.error}`);
    }
    if (action.inverse !== undefined) {
      out(`        undo: ${JSON.stringify(action.inverse)}`);
    }
  }
  return 0;
}

function runGates(journal: Journal): number {
  const waiting = journal.listGated();
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
  if (command === undefined || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }

  const journal = openJournal(flag(argv, "--journal") ?? ".synartesis/journal.db");
  try {
    switch (command) {
      case "list":
        return runList(journal);
      case "show":
        return runShow(argv, journal);
      case "gates":
        return runGates(journal);
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
