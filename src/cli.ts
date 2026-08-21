#!/usr/bin/env node
import { ManifestError, SynartesisError, describe } from "./errors.js";
import { openJournal, type Journal } from "./journal/journal.js";
import { loadManifest } from "./manifest/load.js";
import { createRouter } from "./proxy/routing.js";
import { connectStdioUpstream, type Upstream } from "./proxy/upstream.js";
import { rollback, type RollbackReport } from "./rollback/rollback.js";

const USAGE = `synartesis - an undo layer for AI agents

  synartesis list [--journal <path>]
  synartesis undo <runId> [--to <seq>] [--dry-run]
                          [--manifest <path>] [--journal <path>]

  --manifest  default synartesis.yaml
  --journal   default .synartesis/journal.db
  --to        lowest sequence to undo; earlier actions are left alone
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
  const skip = new Set(["--manifest", "--journal", "--to"]);
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
