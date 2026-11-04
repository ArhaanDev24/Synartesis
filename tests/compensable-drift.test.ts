import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createToyCrmServer } from "../fixtures/toy-crm/server.js";
import { ToyCrmStore } from "../fixtures/toy-crm/store.js";
import { openJournal, type Journal } from "../src/journal/journal.js";
import { loadManifest, parseManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { rollback } from "../src/rollback/rollback.js";
import { autoApproveGate, inMemoryUpstream } from "./helpers/harness.js";
import type { Manifest } from "../src/manifest/types.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** The shipped policy, which now declares a verify read on create_customer. */
const WITH_VERIFY = loadManifest("manifests/toy-crm.yaml");

/** The same policy as it was before: compensable, and nothing to check against. */
const WITHOUT_VERIFY = parseManifest(
  `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.get_customer"
    class: readonly
  - match: "crm.create_customer"
    class: compensable
    inverse:
      tool: "crm.delete_customer"
      args: { id: "$result.id" }
  - match: "crm.delete_customer"
    class: reversible
    snapshot:
      tool: "crm.get_customer"
      args: { id: "$.id" }
      absent_when: "not found"
    inverse:
      tool: "crm.restore_customer"
      args:
        id: "$snapshot.id"
        name: "$snapshot.name"
        email: "$snapshot.email"
        plan: "$snapshot.plan"
        notes: "$snapshot.notes"
`,
  "before.yaml",
);

interface Session {
  readonly client: Client;
  readonly store: ToyCrmStore;
  readonly journal: Journal;
  readonly router: Router;
  readonly runId: string;
}

async function session(manifest: Manifest): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-compensable-"));
  const journal = openJournal(join(dir, "journal.db"));
  cleanups.push(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const store = new ToyCrmStore({ now: () => "2026-01-01T00:00:00.000Z" });
  const upstream = await inMemoryUpstream(createToyCrmServer(store), "crm");
  const router = createRouter([upstream], manifest);
  const proxy = createProxyServer({ upstreams: [upstream], manifest, journal, gate: autoApproveGate });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "0.0.0" });
  await Promise.all([proxy.server.connect(st), client.connect(ct)]);
  const runId = await proxy.ready;
  cleanups.push(async () => {
    await client.close();
    await upstream.close();
  });
  return { client, store, journal, router, runId };
}

async function createOne(active: Session): Promise<string> {
  const made = await active.client.callTool({
    name: "create_customer",
    arguments: { name: "Made", email: "made@example.com", plan: "pro" },
  });
  const text = JSON.stringify(made);
  const id = /(c_\d+)/.exec(text)?.[1];
  expect(id).toBeTypeOf("string");
  return id ?? "";
}

describe("drift on a compensable action", () => {
  it("captures a post-state for a record that did not exist before the call", async () => {
    const active = await session(WITH_VERIFY);
    await createOne(active);

    // The pre-read is impossible here -- the record is created by the call --
    // so this is the only way the action gets anything to compare against.
    const [created] = active.journal
      .getActions(active.runId)
      .filter((row) => row.tool === "create_customer");
    expect(created?.postSnapshot).toBeDefined();
    expect(created?.verify).toBeDefined();
  });

  it("reports the compensation as verified rather than [unverified]", async () => {
    const active = await session(WITH_VERIFY);
    await createOne(active);

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    const step = report.steps.find((entry) => entry.tool === "create_customer");
    expect(step?.kind).toBe("revert");
    expect(step?.verified).toBe(true);
  });

  it("halts instead of compensating away somebody else's edit", async () => {
    const active = await session(WITH_VERIFY);
    const id = await createOne(active);

    // A person edits the new record by hand, outside the proxy. Compensating
    // now would delete work the agent never saw.
    active.store.updateCustomer(id, { notes: "mine, edited by hand" });

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.halted?.reason).toBe("drift detected");
    expect(report.halted?.conflict).toBe(true);
    // The record is still there: the edit survived.
    expect(active.store.__snapshot().customers[id]).toBeDefined();
  });

  it("went through silently before the verify read existed", async () => {
    const active = await session(WITHOUT_VERIFY);
    const id = await createOne(active);
    active.store.updateCustomer(id, { notes: "mine, edited by hand" });

    // The behaviour this closes: no post-state, so nothing to compare, so the
    // hand edit is compensated away and the run reports success.
    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.halted).toBeUndefined();
    expect(active.store.__snapshot().customers[id]).toBeUndefined();
  });

  it("still compensates normally when nobody has touched it", async () => {
    const active = await session(WITH_VERIFY);
    const id = await createOne(active);

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.status).toBe("rolled_back");
    expect(active.store.__snapshot().customers[id]).toBeUndefined();
  });

  it("overwrites the edit when forced, and says so", async () => {
    const active = await session(WITH_VERIFY);
    const id = await createOne(active);
    active.store.updateCustomer(id, { notes: "mine, edited by hand" });

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      force: true,
    });
    expect(report.halted).toBeUndefined();
    expect(active.store.__snapshot().customers[id]).toBeUndefined();
  });
});

describe("a declared verify read never displaces a working pre-read", () => {
  /**
   * update_customer already has a snapshot, so its drift check rides on that.
   * This policy also declares a verify read pointing somewhere else entirely.
   * If the declared one won, the post-state would describe a different record
   * from the snapshot, and every comparison undo makes would be between two
   * unrelated things -- which reads as drift on an untouched resource, or as
   * agreement on a changed one.
   */
  const BOTH = parseManifest(
    `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.update_customer"
    class: reversible
    snapshot:
      tool: "crm.get_customer"
      args: { id: "$.id" }
    inverse:
      tool: "crm.update_customer"
      args:
        id: "$.id"
        name: "$snapshot.name"
        email: "$snapshot.email"
        plan: "$snapshot.plan"
        notes: "$snapshot.notes"
    verify:
      tool: "crm.get_customer"
      args: { id: "c_003" }
`,
    "both.yaml",
  );

  it("keeps the snapshot's read when the policy declares both", async () => {
    const active = await session(BOTH);
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free" },
    });

    const [row] = active.journal
      .getActions(active.runId)
      .filter((entry) => entry.tool === "update_customer");
    // c_001, the record actually written -- not c_003, which the declared
    // verify names.
    expect(JSON.stringify(row?.verify)).toContain("c_001");
    expect(JSON.stringify(row?.verify)).not.toContain("c_003");
  });

  it("still detects drift on the record that was written", async () => {
    const active = await session(BOTH);
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free" },
    });
    active.store.updateCustomer("c_001", { notes: "touched by hand" });

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.halted?.reason).toBe("drift detected");
  });
});

describe("a crash part-way through compensating", () => {
  async function crashed(manifest: Manifest) {
    const active = await session(manifest);
    await createOne(active);
    const row = active.journal.getActions(active.runId)[0];
    if (row === undefined) {
      throw new Error("expected an action");
    }
    active.journal.markRollingBack(row.id);
    active.journal.markUnknownInverse(row.id, "the process died mid-inverse");
    return active;
  }

  it("halts, because an unknown inverse is not something a read can settle", async () => {
    const active = await crashed(WITH_VERIFY);
    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.halted?.seq).toBe(1);
  });

  it("lets a dry run re-check rather than repeat the stale halt", async () => {
    // Deliberate, and documented where classify() handles `unrecoverable`: a
    // dry run is not an attempt, so it passes that halt and runs every real
    // check instead. Before a verify read existed there was nothing for it to
    // check on a compensable action, so it had nothing to say but the old
    // message. Now it can read the world and report what is true today.
    const active = await crashed(WITH_VERIFY);
    const preview = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      dryRun: true,
    });

    expect(preview.halted).toBeUndefined();
    expect(preview.steps[0]?.kind).toBe("revert");
    expect(preview.steps[0]?.verified).toBe(true);
    // And it wrote nothing: the action is still where the crash left it.
    expect(active.journal.getActions(active.runId)[0]?.status).toBe("rolling_back");
  });
});

describe("a compensation that may already have landed, replanned", () => {
  it("is not sent again on --replan; only --force takes that risk", async () => {
    // Halted once as "already sent, and nothing to check it by", written down
    // as unrecoverable -- and --replan, which may claim such rows, sent it a
    // second time.
    const active = await session(WITHOUT_VERIFY);
    await createOne(active);
    const row = active.journal.getActions(active.runId)[0];
    if (row === undefined) {
      throw new Error("expected an action");
    }
    // As an earlier undo leaves it after stopping there: unrecoverable, with
    // the reason it stopped.
    active.journal.markRollingBack(row.id);
    active.journal.markUnrecoverable(
      row.id,
      "an inverse was already sent before an interruption and no pre-read is declared, so whether it applied cannot be determined",
    );

    let deletes = 0;
    const real = active.store.deleteCustomer.bind(active.store);
    active.store.deleteCustomer = (id: string) => {
      deletes += 1;
      return real(id);
    };
    const replanned = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      replanWith: WITHOUT_VERIFY,
    });
    expect(replanned.halted?.reason).toMatch(/already sent/);
    expect(deletes).toBe(0);
  });
});

describe("previewing an undo below one it cannot foresee", () => {
  it("does not read the live world in its place and call the older one already undone", async () => {
    // Delete a customer, then restore them. The preview of undoing the delete
    // compared against the world as it is -- restored -- and said the delete
    // was already undone; the real undo deletes and then restores.
    const active = await session(WITH_VERIFY);
    const before = active.store.__snapshot().customers["c_001"];
    await active.client.callTool({ name: "delete_customer", arguments: { id: "c_001" } });
    await active.client.callTool({
      name: "restore_customer",
      arguments: {
        id: "c_001",
        name: before?.name,
        email: before?.email,
        plan: before?.plan,
        notes: before?.notes,
      },
    });

    const preview = await rollback({ journal: active.journal, router: active.router, runId: active.runId, dryRun: true });
    const deleted = preview.steps.find((step) => step.tool === "delete_customer");
    expect(deleted?.kind).toBe("revert");
    expect(deleted?.reason).toMatch(/cannot foresee/);
  });
});
