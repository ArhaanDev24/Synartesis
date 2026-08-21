import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

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

/**
 * Anything on the proxy's stderr that is not a structured log below error
 * level. A stray plain line would mean something wrote outside the logger.
 */
function problems(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      const parsed = z
        .looseObject({ level: z.number() })
        .safeParse(((): unknown => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return undefined;
          }
        })());
      return !parsed.success || parsed.data.level >= 50;
    });
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
  expect(problems(result.stderr)).toEqual([]);
}

const runsSchema = z.array(z.looseObject({ id: z.string(), actions: z.number() }));

async function runs(journalPath: string): Promise<z.infer<typeof runsSchema>> {
  const listed = await run("node", [CLI, "list", "--json", "--journal", journalPath]);
  expect(listed.code).toBe(0);
  return runsSchema.parse(JSON.parse(listed.stdout));
}

async function onlyRunId(journalPath: string): Promise<string> {
  const all = await runs(journalPath);
  const first = all[0];
  if (first === undefined) {
    throw new Error("no runs recorded");
  }
  return first.id;
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
    expect(listed.stdout).toContain("complete");
    expect(await runs(space.journal)).toMatchObject([{ label: "agent", actions: 3 }]);
  });

  it("undoes a run against state left behind by a process that has exited", async () => {
    const space = workspace();
    await damage(space);
    const damagedText = readFileSync(space.state, "utf8");
    const damaged = readState(space.state);
    expect(damaged.customers["c_001"]?.plan).toBe("free");
    expect(damaged.customers["c_002"]).toBeUndefined();

    const runId = await onlyRunId(space.journal);

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

    const undone = await run("node", [
      CLI, "undo", await onlyRunId(space.journal), "--manifest", space.manifest, "--journal", space.journal,
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

describe("the gate, driven from a second process", () => {
  async function agentAgainst(space: Workspace): Promise<Client> {
    const client = new Client({ name: "rogue-agent", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "node",
        args: [PROXY, "--manifest", space.manifest, "--journal", space.journal, "--gate-timeout", "30"],
        stderr: "ignore",
      }),
    );
    return client;
  }

  async function waitForGate(journalPath: string): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const journal = openJournal(journalPath);
      const gated = journal.listGated()[0]?.id;
      journal.close();
      if (gated !== undefined) {
        return gated;
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new Error("nothing reached the gate");
  }

  const email = {
    name: "send_email",
    arguments: { to: "ada@example.com", subject: "Hi", body: "Automated" },
  };

  it("blocks an email until a human approves it in another terminal", async () => {
    const space = workspace();
    const client = await agentAgainst(space);
    const call = client.callTool(email).catch((error: unknown) => error);

    const actionId = await waitForGate(space.journal);
    const listed = await run("node", [CLI, "gates", "--journal", space.journal]);
    expect(listed.stdout).toContain("crm.send_email");

    const approved = await run("node", [
      CLI, "approve", actionId, "--by", "arhaan", "--journal", space.journal,
    ]);
    expect(approved.code).toBe(0);

    const result = await call;
    expect(result).not.toBeInstanceOf(McpError);
    await client.close();

    const shown = await run("node", [
      CLI, "show", await onlyRunId(space.journal), "--journal", space.journal,
    ]);
    expect(shown.stdout).toContain("approved by arhaan");
  });

  it("returns a readable error on denial and leaves the agent able to continue", async () => {
    const space = workspace();
    const client = await agentAgainst(space);
    const call = client.callTool(email).catch((error: unknown) => error);

    const actionId = await waitForGate(space.journal);
    await run("node", [
      CLI, "deny", actionId, "--by", "arhaan", "--reason", "we do not email customers", "--journal", space.journal,
    ]);

    const thrown = await call;
    expect(thrown).toBeInstanceOf(McpError);
    expect(String(thrown)).toContain("we do not email customers");

    // The session survives the refusal; the agent keeps working.
    const after = await client.callTool({ name: "get_customer", arguments: { id: "c_001" } });
    expect(after.isError).toBeFalsy();
    await client.close();
  });

  it("denies anything still suspended when the proxy exits", async () => {
    const space = workspace();
    const client = await agentAgainst(space);
    const call = client.callTool(email).catch(() => undefined);
    const actionId = await waitForGate(space.journal);

    // Nobody is left to answer once the proxy is gone. Left alone these linger
    // in `synartesis gates` forever with no one waiting on them.
    await client.close();
    await call;

    const journal = openJournal(space.journal);
    expect(journal.listGated()).toEqual([]);
    const settled = journal.getAction(actionId);
    expect(settled?.status).toBe("denied");
    expect(settled?.error).toContain("proxy exited");
    journal.close();
  });

  it("reports a decision that arrives after the action is settled", async () => {
    const space = workspace();
    const client = await agentAgainst(space);
    const call = client.callTool(email).catch(() => undefined);
    const actionId = await waitForGate(space.journal);
    await run("node", [CLI, "approve", actionId, "--journal", space.journal]);
    await call;

    const late = await run("node", [CLI, "deny", actionId, "--journal", space.journal]);
    expect(late.code).toBe(1);
    expect(late.stderr).toContain("no longer awaiting approval");
    await client.close();
  });
});
