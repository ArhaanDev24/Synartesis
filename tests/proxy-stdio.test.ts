import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { openJournal } from "../src/journal/journal.js";

const FIXTURE = resolve("dist/toy-crm.js");
const PROXY = resolve("dist/proxy.js");

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function spawnClient(command: string, args: readonly string[]): Promise<Client> {
  const client = new Client({ name: "stdio-probe", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command, args: [...args], stderr: "inherit" }));
  cleanups.push(async () => {
    await client.close();
  });
  return client;
}

interface Workspace {
  readonly journal: string;
  readonly manifest: string;
}

/** A real manifest on disk, since that is now the only way to configure the proxy. */
function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-stdio-"));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const manifest = join(dir, "synartesis.yaml");
  writeFileSync(
    manifest,
    `version: 1
servers:
  crm:
    command: node
    args: ["${FIXTURE}"]
tools:
  - match: "crm.get_customer"
    class: readonly
  - match: "crm.update_customer"
    class: reversible
    snapshot:
      tool: "crm.get_customer"
      args: { id: "$.id" }
    inverse:
      tool: "crm.update_customer"
      args: { id: "$.id", plan: "$snapshot.plan" }
`,
  );
  return { journal: join(dir, "journal.db"), manifest };
}

function proxyArgs(space: Workspace): string[] {
  return [PROXY, "--manifest", space.manifest, "--journal", space.journal];
}

/**
 * The in-memory tests prove protocol behaviour. This one proves the thing
 * actually runs: two real processes, a real pipe, the shape a user's MCP
 * client will spawn.
 */
describe("proxy over real stdio", () => {
  it("is indistinguishable from the fixture across a real pipe", async () => {
    const space = workspace();
    const direct = await spawnClient("node", [FIXTURE]);
    const proxied = await spawnClient("node", proxyArgs(space));

    expect(proxied.getServerVersion()).toEqual(direct.getServerVersion());
    expect(proxied.getServerCapabilities()).toEqual(direct.getServerCapabilities());
    expect(proxied.getInstructions()).toEqual(direct.getInstructions());
    expect(await proxied.listTools()).toEqual(await direct.listTools());
    expect(await proxied.listResources()).toEqual(await direct.listResources());

    const args = { name: "update_customer", arguments: { id: "c_001", plan: "free" } };
    expect(await proxied.callTool(args)).toEqual(await direct.callTool(args));
  });

  it("writes the run and its actions to the journal file on disk", async () => {
    const space = workspace();
    const proxied = await spawnClient("node", proxyArgs(space));
    await proxied.callTool({ name: "update_customer", arguments: { id: "c_002", notes: "hi" } });
    await proxied.callTool({ name: "get_customer", arguments: { id: "c_002" } });

    // Opened by a second process while the proxy still holds the file: this is
    // what WAL mode buys, and what `synartesis show` will do in Phase 6.
    const journal = openJournal(space.journal);
    const run = journal.listRuns()[0];
    expect(run?.label).toBe("stdio-probe");
    const runId = run?.id ?? "";
    const actions = journal.getActions(runId);
    expect(actions.map((a) => a.tool)).toEqual(["update_customer", "get_customer"]);
    expect(actions.every((a) => a.status === "applied")).toBe(true);
    expect(actions[0]?.args).toEqual({ id: "c_002", notes: "hi" });
    journal.close();
  });

  it("answers every request that arrived before the pipe closed", async () => {
    const space = workspace();
    const proxied = await spawnClient("node", proxyArgs(space));
    // Frames delivered in the same chunk as the EOF still have to be served:
    // the pipe closing means no more are coming, not that these can be
    // dropped.
    const [tools, read, write] = await Promise.all([
      proxied.listTools(),
      proxied.callTool({ name: "get_customer", arguments: { id: "c_001" } }),
      proxied.callTool({ name: "update_customer", arguments: { id: "c_002", plan: "free" } }),
    ]);
    expect(tools.tools.length).toBeGreaterThan(0);
    expect(read.isError).toBeFalsy();
    expect(write.isError).toBeFalsy();

    const journal = openJournal(space.journal);
    const runId = journal.listRuns()[0]?.id ?? "";
    expect(journal.getActions(runId).map((a) => a.status)).toEqual(["applied", "applied"]);
    journal.close();
  });

  it("shuts down promptly when the client closes the pipe", async () => {
    const space = workspace();
    const client = new Client({ name: "stdio-probe", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({ command: "node", args: proxyArgs(space), stderr: "inherit" }),
    );

    const start = performance.now();
    await client.close();
    const elapsed = performance.now() - start;

    // The SDK waits 2s after closing stdin before escalating to SIGTERM. A
    // close anywhere near that means the proxy is not exiting on its own and
    // is being killed instead.
    expect(elapsed).toBeLessThan(500);
  });

  it("adds under 10ms at p95 over a real pipe", async () => {
    const space = workspace();
    const direct = await spawnClient("node", [FIXTURE]);
    const proxied = await spawnClient("node", proxyArgs(space));
    const args = { name: "update_customer", arguments: { id: "c_001", notes: "bench" } };

    const sample = async (client: Client, iterations: number): Promise<number[]> => {
      const samples: number[] = [];
      for (let i = 0; i < iterations; i += 1) {
        const start = performance.now();
        await client.callTool(args);
        samples.push(performance.now() - start);
      }
      return samples;
    };
    const p95 = (values: readonly number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? 0;
    };

    await sample(direct, 30);
    await sample(proxied, 30);
    const directP95 = p95(await sample(direct, 200));
    const proxiedP95 = p95(await sample(proxied, 200));
    const overhead = proxiedP95 - directP95;

    console.log(
      `stdio p95 direct ${directP95.toFixed(3)}ms, proxied ${proxiedP95.toFixed(3)}ms, ` +
        `overhead ${overhead.toFixed(3)}ms`,
    );
    // This overhead includes the extra process hop, which is inherent to being
    // a proxy, not just the journal write measured by the in-memory test.
    expect(overhead).toBeLessThan(10);
  });

  it("refuses to start when the manifest is missing", async () => {
    const client = new Client({ name: "stdio-probe", version: "0.0.0" });
    await expect(
      client.connect(
        new StdioClientTransport({
          command: "node",
          args: [PROXY, "--manifest", "/nonexistent/synartesis.yaml"],
          stderr: "ignore",
        }),
      ),
    ).rejects.toThrow();
  });
});
