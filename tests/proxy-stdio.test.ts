import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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

function tempJournalPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-stdio-"));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return join(dir, "journal.db");
}

/**
 * The in-memory tests prove protocol behaviour. This one proves the thing
 * actually runs: two real processes, a real pipe, the shape a user's MCP
 * client will spawn.
 */
describe("proxy over real stdio", () => {
  it("is indistinguishable from the fixture across a real pipe", async () => {
    const journalPath = tempJournalPath();
    const direct = await spawnClient("node", [FIXTURE]);
    const proxied = await spawnClient("node", [
      PROXY,
      "--name",
      "crm",
      "--journal",
      journalPath,
      "--",
      "node",
      FIXTURE,
    ]);

    expect(proxied.getServerVersion()).toEqual(direct.getServerVersion());
    expect(proxied.getServerCapabilities()).toEqual(direct.getServerCapabilities());
    expect(proxied.getInstructions()).toEqual(direct.getInstructions());
    expect(await proxied.listTools()).toEqual(await direct.listTools());
    expect(await proxied.listResources()).toEqual(await direct.listResources());

    const args = { name: "update_customer", arguments: { id: "c_001", plan: "free" } };
    expect(await proxied.callTool(args)).toEqual(await direct.callTool(args));
  });

  it("writes the run and its actions to the journal file on disk", async () => {
    const journalPath = tempJournalPath();
    const proxied = await spawnClient("node", [
      PROXY,
      "--name",
      "crm",
      "--journal",
      journalPath,
      "--",
      "node",
      FIXTURE,
    ]);
    await proxied.callTool({ name: "update_customer", arguments: { id: "c_002", notes: "hi" } });
    await proxied.callTool({ name: "get_customer", arguments: { id: "c_002" } });

    // Opened by a second process while the proxy still holds the file: this is
    // what WAL mode buys, and what `synartesis show` will do in Phase 6.
    const journal = openJournal(journalPath);
    const runId = journal.listRuns()[0]?.id ?? "";
    const actions = journal.getActions(runId);
    expect(actions.map((a) => a.tool)).toEqual(["update_customer", "get_customer"]);
    expect(actions.every((a) => a.status === "applied")).toBe(true);
    expect(actions[0]?.args).toEqual({ id: "c_002", notes: "hi" });
    journal.close();
  });

  it("shuts down promptly when the client closes the pipe", async () => {
    const journalPath = tempJournalPath();
    const client = new Client({ name: "stdio-probe", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "node",
        args: [PROXY, "--name", "crm", "--journal", journalPath, "--", "node", FIXTURE],
        stderr: "inherit",
      }),
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
    const journalPath = tempJournalPath();
    const direct = await spawnClient("node", [FIXTURE]);
    const proxied = await spawnClient("node", [
      PROXY,
      "--name",
      "crm",
      "--journal",
      journalPath,
      "--",
      "node",
      FIXTURE,
    ]);
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

  it("exits with a usage error when no upstream command is given", async () => {
    const client = new Client({ name: "stdio-probe", version: "0.0.0" });
    await expect(
      client.connect(new StdioClientTransport({ command: "node", args: [PROXY], stderr: "ignore" })),
    ).rejects.toThrow();
  });
});
