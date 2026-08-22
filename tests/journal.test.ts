import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { openJournal } from "../src/journal/journal.js";
import { parseManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createHarness, autoApproveGate, inMemoryUpstream, type Harness } from "./helpers/harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

describe("journal", () => {
  it("opens in WAL mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-wal-"));
    const journal = openJournal(join(dir, "journal.db"));
    expect(journal.pragma("journal_mode")).toBe("wal");
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens a run when the client connects", async () => {
    harness = await createHarness();
    const runs = harness.journal.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("active");
    expect(runs[0]?.label).toBe("test-client");
  });

  it("records exactly one action per tools/call", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({ name: "get_customer", arguments: { id: "c_001" } });
    await harness.proxied.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free" },
    });

    const runId = harness.journal.listRuns()[0]?.id ?? "";
    const actions = harness.journal.getActions(runId);
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.tool)).toEqual(["get_customer", "update_customer"]);
    expect(actions.map((a) => a.seq)).toEqual([1, 2]);
    expect(actions.every((a) => a.server === "crm")).toBe(true);
    expect(actions.every((a) => a.status === "applied")).toBe(true);
    expect(actions.map((a) => a.class)).toEqual(["readonly", "reversible"]);
    expect(new Set(actions.map((a) => a.idempotencyKey)).size).toBe(2);
  });

  it("records the arguments and the result verbatim", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({
      name: "update_customer",
      arguments: { id: "c_002", notes: "checked" },
    });
    const runId = harness.journal.listRuns()[0]?.id ?? "";
    const action = harness.journal.getActions(runId)[0];
    expect(action?.args).toEqual({ id: "c_002", notes: "checked" });
    expect(action?.result).toMatchObject({ content: [{ type: "text" }] });
  });

  it("leaves snapshot fields empty until Phase 3 populates them", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({ name: "get_customer", arguments: { id: "c_001" } });
    const runId = harness.journal.listRuns()[0]?.id ?? "";
    const action = harness.journal.getActions(runId)[0];
    expect(action?.snapshot).toBeUndefined();
    expect(action?.postSnapshot).toBeUndefined();
    expect(action?.inverse).toBeUndefined();
  });

  it("does not journal read-only protocol traffic", async () => {
    harness = await createHarness();
    await harness.proxied.listTools();
    await harness.proxied.listResources();
    await harness.proxied.readResource({ uri: "crm://customers" });
    const runId = harness.journal.listRuns()[0]?.id ?? "";
    expect(harness.journal.getActions(runId)).toHaveLength(0);
  });

  it("marks a call as failed when the upstream returns a protocol error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-fail-"));
    const journal = openJournal(join(dir, "journal.db"));

    // Handlers are attached below McpServer's registration helpers on purpose:
    // registerTool turns a throwing handler into an isError result, which is an
    // applied call, not a failed one. Only a protocol error exercises this path.
    const raw = new McpServer({ name: "raw", version: "1.0.0" }, { capabilities: { tools: {} } });
    raw.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: "boom", description: "Always fails.", inputSchema: { type: "object" } }],
    }));
    raw.server.setRequestHandler(CallToolRequestSchema, () => {
      throw new McpError(ErrorCode.InvalidParams, "boom exploded");
    });

    const upstream = await inMemoryUpstream(raw, "raw");
    const proxy = createProxyServer({
      gate: autoApproveGate,
      upstreams: [upstream],
      manifest: parseManifest(
        `version: 1\nservers: { ${upstream.name}: { command: node, args: [] } }\ntools: []\n`,
        "manifest.yaml",
      ),
      journal,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fail-probe", version: "0.0.0" });
    await Promise.all([proxy.server.connect(st), client.connect(ct)]);
    const runId = await proxy.ready;

    const thrown = await client.callTool({ name: "boom", arguments: {} }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(McpError);

    const action = journal.getActions(runId)[0];
    expect(action?.status).toBe("failed");
    expect(action?.error).toContain("boom exploded");
    expect(action?.result).toBeUndefined();

    await client.close();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks a call as failed when the upstream connection is gone", async () => {
    harness = await createHarness();
    const runId = harness.journal.listRuns()[0]?.id ?? "";
    await harness.upstream.close();

    await harness.proxied
      .callTool({ name: "get_customer", arguments: { id: "c_001" } })
      .catch(() => undefined);

    const action = harness.journal.getActions(runId)[0];
    expect(action?.status).toBe("failed");
    expect(action?.error).toBeTruthy();
  });

  it("closes the run when the client disconnects", async () => {
    harness = await createHarness();
    const runId = harness.journal.listRuns()[0]?.id ?? "";
    await harness.proxied.close();
    const run = harness.journal.getRun(runId);
    expect(run?.status).toBe("complete");
    expect(run?.endedAt).toBeTruthy();
  });

  it("writes the row before forwarding, so an in-flight call is visible as pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-pending-"));
    const journal = openJournal(join(dir, "journal.db"));

    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => undefined;
    const hasEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const slow = new McpServer({ name: "slow", version: "1.0.0" }, { capabilities: { tools: {} } });
    slow.registerTool("wait", { description: "Blocks.", inputSchema: {} }, async () => {
      entered();
      await blocked;
      return { content: [{ type: "text", text: "done" }] };
    });

    const upstream = await inMemoryUpstream(slow, "slow");
    const proxy = createProxyServer({
      gate: autoApproveGate,
      upstreams: [upstream],
      manifest: parseManifest(
        `version: 1\nservers: { ${upstream.name}: { command: node, args: [] } }\ntools: []\n`,
        "manifest.yaml",
      ),
      journal,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "pending-probe", version: "0.0.0" });
    await Promise.all([proxy.server.connect(st), client.connect(ct)]);
    await proxy.ready;

    const inFlight = client.callTool({ name: "wait", arguments: {} });
    await hasEntered;

    const runId = journal.listRuns()[0]?.id ?? "";
    expect(journal.getActions(runId)[0]?.status).toBe("pending");

    release();
    await inFlight;
    expect(journal.getActions(runId)[0]?.status).toBe("applied");

    await client.close();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves an interrupted call pending rather than calling it failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-abort-"));
    const journal = openJournal(join(dir, "journal.db"));

    let entered = (): void => undefined;
    const hasEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow = new McpServer({ name: "slow", version: "1.0.0" }, { capabilities: { tools: {} } });
    slow.registerTool("wait", { description: "Blocks.", inputSchema: {} }, async () => {
      entered();
      await new Promise<void>((resolve) => setTimeout(resolve, 60_000).unref());
      return { content: [{ type: "text", text: "done" }] };
    });

    const upstream = await inMemoryUpstream(slow, "slow");
    const proxy = createProxyServer({
      gate: autoApproveGate,
      upstreams: [upstream],
      manifest: parseManifest(
        "version: 1\nservers: { slow: { command: node, args: [] } }\ntools: []\n",
        "manifest.yaml",
      ),
      journal,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "abort-probe", version: "0.0.0" });
    await Promise.all([proxy.server.connect(st), client.connect(ct)]);
    const runId = await proxy.ready;

    const controller = new AbortController();
    const call = client
      .callTool({ name: "wait", arguments: {} }, undefined, { signal: controller.signal })
      .catch(() => undefined);
    await hasEntered;
    controller.abort();
    await call;

    const action = journal.getActions(runId)[0];
    // The upstream may or may not have applied it; only `pending` says that
    // honestly. `failed` would assert something this process cannot know.
    expect(action?.status).toBe("pending");
    expect(action?.error).toBeTruthy();

    await client.close();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("survives reopening and keeps prior runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-reopen-"));
    const path = join(dir, "journal.db");
    const first = openJournal(path);
    const runId = first.beginRun("agent-a");
    first.endRun(runId, "complete");
    first.close();

    const second = openJournal(path);
    expect(second.listRuns().map((r) => r.id)).toEqual([runId]);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("allocates seq per run, not globally", () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-seq-"));
    const journal = openJournal(join(dir, "journal.db"));
    const runA = journal.beginRun("a");
    const runB = journal.beginRun("b");
    const first = journal.recordPending({ runId: runA, server: "s", tool: "t", args: {}, class: "readonly" });
    const second = journal.recordPending({ runId: runB, server: "s", tool: "t", args: {}, class: "readonly" });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(1);
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unparseable schema version rather than guessing", () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-ver-"));
    const path = join(dir, "journal.db");
    const journal = openJournal(path);
    journal.close();

    const raw = openJournal(path);
    expect(z.number().parse(raw.pragma("user_version"))).toBeGreaterThan(0);
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the order runs come back in", () => {
  it("is the order they happened, even when two start in the same millisecond", () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-order-"));
    const journal = openJournal(join(dir, "journal.db"));
    // No sleeping between them: an agent restarting immediately, or a script
    // running two in a row, and the timestamps collide.
    const created = ["first", "second", "third", "fourth"].map((label) =>
      journal.beginRun(label),
    );
    const listed = journal.listRuns().map((run) => run.id);
    journal.close();
    rmSync(dir, { recursive: true, force: true });

    // `show` and `undo` both default to the most recent run. If the order is
    // decided by a random uuid whenever the clock has not moved, they default
    // to an arbitrary one.
    expect(listed).toEqual(created);
  });
});
