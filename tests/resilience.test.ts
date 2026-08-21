import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createToyCrmServer } from "../fixtures/toy-crm/server.js";
import { ToyCrmStore } from "../fixtures/toy-crm/store.js";
import { openJournal, type Journal } from "../src/journal/journal.js";
import { loadManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { rollback } from "../src/rollback/rollback.js";
import { autoApproveGate, inMemoryUpstream } from "./helpers/harness.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MANIFEST = loadManifest("manifests/toy-crm.yaml");

async function session(): Promise<{ client: Client; journal: Journal; router: Router; runId: string; store: ToyCrmStore }> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-probe-"));
  const journal = openJournal(join(dir, "journal.db"));
  cleanups.push(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = new ToyCrmStore({ now: () => "2026-01-01T00:00:00.000Z" });
  const upstream = await inMemoryUpstream(createToyCrmServer(store), "crm");
  const router = createRouter([upstream], MANIFEST);
  const proxy = createProxyServer({ upstreams: [upstream], manifest: MANIFEST, journal, gate: autoApproveGate });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([proxy.server.connect(st), client.connect(ct)]);
  const runId = await proxy.ready;
  cleanups.push(async () => { await client.close(); });
  return { client, journal, router, runId, store };
}

describe("holding up under interruption", () => {
  it("undo behaves the same the second time as the first", async () => {
    const { client, journal, router, runId, store } = await session();
    await client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await client.callTool({ name: "update_customer", arguments: { id: "c_002", plan: "free" } });

    // A third call went out and the client gave up before the reply came, so
    // it never reached markApplied and has no inverse. This is what an
    // interrupted call really looks like in the journal.
    const interrupted = journal.recordPending({
      runId,
      server: "crm",
      tool: "send_email",
      args: { to: "a@b.c" },
      class: "irreversible",
    });
    journal.markUnknown(interrupted.actionId, "the client gave up waiting");
    const newest = { seq: interrupted.seq };

    const first = await rollback({ journal, router, runId });
    const afterFirst = store.__snapshot();
    const second = await rollback({ journal, router, runId });

    expect(first.halted?.seq).toBe(newest.seq);
    expect(second.halted?.seq).toBe(newest.seq);
    expect(second.halted?.reason).toBe(first.halted?.reason);
    expect(store.__snapshot()).toEqual(afterFirst);
  });

  it("carries arguments with newlines and non-latin text through undo unchanged", async () => {
    const { client, journal, router, runId, store } = await session();
    const notes = "ligne un\nδεύτερη γραμμή\t\"quoted\" \\ backslash";
    await client.callTool({ name: "update_customer", arguments: { id: "c_001", notes } });
    expect(store.__snapshot().customers["c_001"]?.notes).toBe(notes);
    const report = await rollback({ journal, router, runId });
    expect(report.status).toBe("rolled_back");
    expect(store.__snapshot().customers["c_001"]?.notes).not.toBe(notes);
  });

  it("halts rather than throwing when the inverse names a server that is not connected", async () => {
    const { client, journal, router, runId } = await session();
    await client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    const [action] = journal.getActions(runId);
    if (action === undefined) throw new Error("expected an action");
    journal.markApplied(action.id, {
      result: action.result,
      inverse: { server: "gone", tool: "put_back", args: { id: "c_001" } },
      verify: action.verify,
      postSnapshot: action.postSnapshot,
    });
    const report = await rollback({ journal, router, runId });
    expect(report.status).toBe("partial");
    expect(report.halted?.reason).toMatch(/inverse failed/);
  });
});
