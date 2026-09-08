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
import { inspect, verdict } from "../src/rollback/inspect.js";
import { rollback } from "../src/rollback/rollback.js";
import { autoApproveGate, inMemoryUpstream } from "./helpers/harness.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const MANIFEST = loadManifest("manifests/toy-crm.yaml");

interface Session {
  readonly client: Client;
  readonly store: ToyCrmStore;
  readonly journal: Journal;
  readonly router: Router;
  readonly runId: string;
}

async function session(): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-inspect-"));
  const journal = openJournal(join(dir, "journal.db"));
  cleanups.push(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const store = new ToyCrmStore({ now: () => "2026-01-01T00:00:00.000Z" });
  const upstream = await inMemoryUpstream(createToyCrmServer(store), "crm");
  const router = createRouter([upstream], MANIFEST);
  const proxy = createProxyServer({
    upstreams: [upstream],
    manifest: MANIFEST,
    journal,
    gate: autoApproveGate,
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inspect-test", version: "0" });
  await Promise.all([proxy.server.connect(serverSide), client.connect(clientSide)]);
  cleanups.push(async () => {
    await client.close();
    await proxy.server.close();
  });

  const runId = proxy.runId;
  if (runId === undefined) {
    throw new Error("the proxy did not open a run");
  }
  return { client, store, journal, router, runId };
}

describe("asking what has happened since, without undoing anything", () => {
  it("says a resource nobody touched is still exactly as the run left it", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });

    const found = await inspect({ journal: active.journal, router: active.router, runId: active.runId });
    expect(found.resources.map((one) => one.condition)).toEqual(["unchanged"]);
    expect(verdict(found)).toContain("nothing has been touched since");
  });

  it("sees an edit nobody made through the proxy, which is the whole point", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    // A person, by hand. Nothing about this comes through the journal.
    active.store.updateCustomer("c_001", { notes: "a human wrote this" });

    const found = await inspect({ journal: active.journal, router: active.router, runId: active.runId });
    expect(found.resources[0]?.condition).toBe("changed");
    expect(found.resources[0]?.diff ?? "").toContain("a human wrote this");
    expect(verdict(found)).toContain("undoing would write over");
  });

  it("changes nothing: no inverse is sent and no row moves", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    active.store.updateCustomer("c_001", { notes: "a human wrote this" });
    const before = active.store.__snapshot();

    await inspect({ journal: active.journal, router: active.router, runId: active.runId });

    expect(active.store.__snapshot()).toEqual(before);
    expect(active.journal.getActions(active.runId).every((a) => a.status === "applied")).toBe(true);
  });

  it("reports every conflict, where undo stops at the first", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_002", plan: "free" } });
    active.store.updateCustomer("c_001", { notes: "one human" });
    active.store.updateCustomer("c_002", { notes: "another human" });

    const found = await inspect({ journal: active.journal, router: active.router, runId: active.runId });
    expect(found.resources.filter((one) => one.condition === "changed")).toHaveLength(2);

    // What it is better than: a dry run halts, so it can only ever name one.
    const halting = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      dryRun: true,
    });
    expect(halting.halted).toBeDefined();
  });

  it("does not call an earlier write to the same record changed", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "pro" } });

    // Only the newest write can match the world; undo walks backwards, and
    // each older one is checked against a state the one above it restores.
    const found = await inspect({ journal: active.journal, router: active.router, runId: active.runId });
    expect(found.resources.map((one) => one.condition)).toEqual(["superseded", "unchanged"]);
  });

  it("calls an undone action put back, not changed", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await rollback({ journal: active.journal, router: active.router, runId: active.runId });

    const found = await inspect({ journal: active.journal, router: active.router, runId: active.runId });
    expect(found.resources[0]?.condition).toBe("restored");
  });

  it("keeps the actions in the order they happened", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_002", plan: "free" } });

    const found = await inspect({ journal: active.journal, router: active.router, runId: active.runId });
    expect(found.resources.map((one) => one.seq)).toEqual([1, 2]);
  });
});
