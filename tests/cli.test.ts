import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { openJournal } from "../src/journal/journal.js";

/** Loose on purpose: this helper writes the file back, so it must not drop fields. */
const stateSchema = z.looseObject({
  customers: z.record(
    z.string(),
    z.looseObject({ id: z.string(), plan: z.string(), notes: z.string() }),
  ),
});

function readState(path: string): z.infer<typeof stateSchema> {
  return stateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

const FIXTURE = resolve("dist/toy-crm.js");
const PROXY = resolve("dist/proxy.js");
const CLI = resolve("dist/cli.js");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Workspace {
  readonly dir: string;
  readonly manifest: string;
  readonly journal: string;
  readonly state: string;
}

function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-cli-"));
  dirs.push(dir);
  const state = join(dir, "crm.json");
  const manifest = join(dir, "synartesis.yaml");
  writeFileSync(
    manifest,
    readFileSync("manifests/toy-crm.yaml", "utf8").replace(
      'args: ["dist/toy-crm.js"]',
      `args: ["${FIXTURE}", "--state", "${state}"]`,
    ),
  );
  return { dir, manifest, journal: join(dir, "journal.db"), state };
}

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], stdin?: string): Promise<Ran> {
  return new Promise<Ran>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", rejectRun);
    child.on("close", (code) => {
      resolveRun({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function frames(...calls: readonly { name: string; arguments: Record<string, unknown> }[]): string {
  const lines = [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agent", version: "0" },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ...calls.map((params, index) =>
      JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params }),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

async function damage(space: Workspace): Promise<void> {
  const result = await run(
    "node",
    [PROXY, "--manifest", space.manifest, "--journal", space.journal],
    frames(
      { name: "update_customer", arguments: { id: "c_001", plan: "free", notes: "WRONG" } },
      { name: "delete_customer", arguments: { id: "c_002" } },
      { name: "create_customer", arguments: { name: "Bogus", email: "b@e.com" } },
    ),
  );
  expect(result.stderr).toBe("");
}

function runIdFrom(listing: string): string {
  const id = listing.trim().split(/\s+/)[0];
  if (id === undefined) {
    throw new Error(`no run id in listing: ${listing}`);
  }
  return id;
}

describe("the proxy under an abrupt disconnect", () => {
  it("finishes a call whose pre-read is still in flight when stdin closes", async () => {
    const space = workspace();
    await damage(space);

    // The client's pipe closes immediately after the last frame. A shutdown
    // that counted a call as in-flight only after its pre-read would abort the
    // read and block a write the agent was entitled to make.
    const journal = openJournal(space.journal);
    const runId = journal.listRuns()[0]?.id ?? "";
    const actions = journal.getActions(runId);
    expect(actions.map((a) => a.status)).toEqual(["applied", "applied", "applied"]);
    expect(actions.every((a) => a.error === undefined)).toBe(true);
    journal.close();
  });
});

describe("the cli", () => {
  it("lists runs", async () => {
    const space = workspace();
    await damage(space);
    const listed = await run("node", [CLI, "list", "--journal", space.journal]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("agent");
    expect(listed.stdout).toContain("3 actions");
  });

  it("undoes a run against state left behind by a process that has exited", async () => {
    const space = workspace();
    await damage(space);
    const damagedText = readFileSync(space.state, "utf8");
    const damaged = readState(space.state);
    expect(damaged.customers["c_001"]?.plan).toBe("free");
    expect(damaged.customers["c_002"]).toBeUndefined();

    const listed = await run("node", [CLI, "list", "--journal", space.journal]);
    const runId = runIdFrom(listed.stdout);

    const dry = await run("node", [
      CLI, "undo", runId, "--dry-run", "--manifest", space.manifest, "--journal", space.journal,
    ]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("would call");
    // A dry run reads state but changes nothing.
    expect(readFileSync(space.state, "utf8")).toBe(damagedText);

    const undone = await run("node", [
      CLI, "undo", runId, "--manifest", space.manifest, "--journal", space.journal,
    ]);
    expect(undone.code).toBe(0);
    expect(undone.stdout).toContain("status: rolled_back");

    const restored = readState(space.state);
    expect(restored.customers["c_001"]).toMatchObject({
      plan: "pro",
      notes: "founding customer",
    });
    expect(restored.customers["c_002"]).toBeDefined();
    expect(restored.customers["c_004"]).toBeUndefined();
  });

  it("refuses and exits non-zero when the resource drifted", async () => {
    const space = workspace();
    await damage(space);

    const state = readState(space.state);
    const target = state.customers["c_001"];
    if (target === undefined) {
      throw new Error("c_001 missing");
    }
    target.notes = "a human corrected this";
    writeFileSync(space.state, JSON.stringify(state, null, 2));

    const listed = await run("node", [CLI, "list", "--journal", space.journal]);
    const undone = await run("node", [
      CLI, "undo", runIdFrom(listed.stdout), "--manifest", space.manifest, "--journal", space.journal,
    ]);

    expect(undone.code).toBe(1);
    expect(undone.stdout).toContain("drift");
    expect(undone.stdout).toContain("a human corrected this");
    // Nothing was clobbered.
    const after = readState(space.state);
    expect(after.customers["c_001"]?.notes).toBe("a human corrected this");
  });

  it("exits 2 on bad usage and on an unknown run", async () => {
    const space = workspace();
    await damage(space);
    expect((await run("node", [CLI])).code).toBe(2);
    expect((await run("node", [CLI, "wat", "--journal", space.journal])).code).toBe(2);
    const missing = await run("node", [CLI, "undo", "nope", "--journal", space.journal]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("no run with id");
  });
});
