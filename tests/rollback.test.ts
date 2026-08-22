import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createToyCrmServer } from "../fixtures/toy-crm/server.js";
import { ToyCrmStore, type ToyCrmState } from "../fixtures/toy-crm/store.js";
import { openJournal, type Journal } from "../src/journal/journal.js";
import { loadManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { rollback } from "../src/rollback/rollback.js";
import { parseManifest } from "../src/manifest/load.js";
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
  readonly before: ToyCrmState;
}

async function session(
  options: { beforeWrite?: () => void; realGate?: boolean } = {},
): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-rollback-"));
  const journal = openJournal(join(dir, "journal.db"));
  cleanups.push(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const store = new ToyCrmStore({
    now: () => "2026-01-01T00:00:00.000Z",
    ...(options.beforeWrite === undefined ? {} : { beforeWrite: options.beforeWrite }),
  });
  const before = store.__snapshot();

  const upstream = await inMemoryUpstream(createToyCrmServer(store), "crm");
  const router = createRouter([upstream], MANIFEST);
  const proxy = createProxyServer({
    upstreams: [upstream],
    manifest: MANIFEST,
    journal,
    // The real gate refuses and waits to be retried; most tests here are about
    // rollback, not approval, so they take the instant yes.
    ...(options.realGate === true ? {} : { gate: autoApproveGate }),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "0.0.0" });
  await Promise.all([proxy.server.connect(st), client.connect(ct)]);
  const runId = await proxy.ready;
  cleanups.push(async () => {
    await client.close();
    await upstream.close();
  });

  return { client, store, journal, router, runId, before };
}

/** Twenty mutations of every reversible and compensable shape the fixture has. */
async function twentyMutations(active: Session): Promise<void> {
  const ids = ["c_001", "c_002", "c_003"];
  for (let i = 0; i < 12; i += 1) {
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: ids[i % ids.length], notes: `edit ${String(i)}`, plan: i % 2 === 0 ? "free" : "enterprise" },
    });
  }
  for (let i = 0; i < 4; i += 1) {
    await active.client.callTool({
      name: "create_customer",
      arguments: { name: `Made ${String(i)}`, email: `m${String(i)}@example.com`, plan: "pro" },
    });
  }
  await active.client.callTool({ name: "delete_customer", arguments: { id: "c_002" } });
  await active.client.callTool({ name: "delete_customer", arguments: { id: "c_003" } });
  await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", name: "Renamed" } });
  await active.client.callTool({ name: "get_customer", arguments: { id: "c_001" } });
}

describe("rollback", () => {
  it("restores the store exactly after twenty mutations", async () => {
    const active = await session();
    await twentyMutations(active);
    expect(active.store.__snapshot()).not.toEqual(active.before);

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });

    expect(report.status).toBe("rolled_back");
    expect(JSON.stringify(active.store.__snapshot())).toBe(JSON.stringify(active.before));
  });

  it("marks the run rolled_back and every reverted action with it", async () => {
    const active = await session();
    await twentyMutations(active);
    await rollback({ journal: active.journal, router: active.router, runId: active.runId });

    expect(active.journal.getRun(active.runId)?.status).toBe("rolled_back");
    const actions = active.journal.getActions(active.runId);
    const reverted = actions.filter((a) => a.status === "rolled_back");
    const readonlyActions = actions.filter((a) => a.class === "readonly");
    expect(reverted).toHaveLength(actions.length - readonlyActions.length);
  });

  it("walks in reverse sequence order", async () => {
    const active = await session();
    await twentyMutations(active);
    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    const seqs = report.steps.map((step: { seq: number }) => step.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it("changes nothing on a dry run", async () => {
    const active = await session();
    await twentyMutations(active);
    const damaged = active.store.__snapshot();

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      dryRun: true,
    });

    expect(report.steps.filter((step: { kind: string }) => step.kind === "revert").length).toBeGreaterThan(0);
    expect(active.store.__snapshot()).toEqual(damaged);
    expect(active.journal.getRun(active.runId)?.status).toBe("active");
  });

  it("stops at the requested sequence when given --to", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    const afterFirst = active.store.__snapshot();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", notes: "second" } });
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_003", plan: "pro" } });

    await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      toSeq: 2,
    });

    // Sequences 3 and 2 are undone; sequence 1 is left in place.
    expect(active.store.__snapshot()).toEqual(afterFirst);
    expect(active.journal.getRun(active.runId)?.status).toBe("partial");
  });
});

describe("drift detection", () => {
  it("refuses to clobber a record something else changed", async () => {
    const active = await session();
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free", notes: "agent edit" },
    });

    // Someone else edits the same record between the run and the undo.
    active.store.updateCustomer("c_001", { notes: "a human wrote this" });
    const beforeUndo = active.store.__snapshot();

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });

    expect(report.status).toBe("partial");
    expect(report.halted?.reason).toMatch(/drift/i);
    // Writing the old value back would have destroyed someone else's work.
    expect(active.store.__snapshot()).toEqual(beforeUndo);
    expect(active.journal.getActions(active.runId)[0]?.status).toBe("unrecoverable");
  });

  it("reports both values so a human can decide", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    active.store.updateCustomer("c_001", { notes: "changed elsewhere" });

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    const detail = report.halted?.detail ?? "";
    expect(detail).toContain("changed elsewhere");
    expect(detail).toContain("founding customer");
  });


  it("does not quote what it saw before as though it were the state now", async () => {
    const active = await session();
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free", notes: "agent edit" },
    });
    active.store.updateCustomer("c_001", { notes: "a human wrote this" });

    const first = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(first.halted?.reason).toMatch(/drift/i);

    // The person withdraws their edit. The world is back to what the run left,
    // and the refusal that follows still reads out the conflicting value from
    // the earlier attempt as "actual" -- a fact about a moment that has passed,
    // printed as a fact about now.
    active.store.updateCustomer("c_001", { notes: "agent edit" });

    const second = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(second.halted?.detail ?? "").toMatch(/earlier attempt|when it halted/i);
    // And it says how to carry on, which nothing did.
    expect(second.halted?.detail ?? "").toMatch(/--replan/);
  });

  it("treats an already-reverted action as done rather than as drift", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });

    // Exactly what the inverse would have produced, applied by someone else.
    active.store.updateCustomer("c_001", { plan: "pro" });

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.status).toBe("rolled_back");
    expect(report.steps[0]?.kind).toBe("already-reverted");
  });
});

describe("actions that cannot be undone", () => {
  it("steps over a permanent action and reverts everything else", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await active.client.callTool({
      name: "send_email",
      arguments: { to: "a@b.c", subject: "s", body: "b" },
    });
    const outboxAfter = active.store.__snapshot().outbox;

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });

    // The email is the newest action. Stopping at it would mean undoing
    // nothing at all, and no amount of stopping un-sends it.
    expect(report.steps[0]?.kind).toBe("permanent");
    expect(report.status).toBe("partial");
    expect(active.store.__snapshot().customers["c_001"]?.plan).toBe("pro");
    expect(active.store.__snapshot().outbox).toEqual(outboxAfter);
  });

  it("names whoever approved the permanent action it left alone", async () => {
    const active = await session({ realGate: true });
    const email = {
      name: "send_email",
      arguments: { to: "a@b.c", subject: "s", body: "b" },
    };

    // The real path: refused, approved out of band, then retried.
    await active.client.callTool(email).catch(() => undefined);
    const waiting = active.journal.listGated()[0];
    expect(waiting).toBeDefined();
    expect(active.journal.approve(waiting?.id ?? "", "arhaan")).toBe(true);
    await active.client.callTool(email);

    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });

    const permanent = report.steps.find((step) => step.kind === "permanent");
    expect(permanent?.reason).toContain("approved by arhaan");
    expect(active.store.__snapshot().customers["c_001"]?.plan).toBe("pro");
  });

  it("still halts at an applied irreversible action in the middle, reverting what came after", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await active.client.callTool({
      name: "send_email",
      arguments: { to: "a@b.c", subject: "s", body: "b" },
    });
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_003", plan: "pro" } });
    const beforeUndo = active.store.__snapshot();

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });

    expect(report.status).toBe("partial");
    // Everything reversible is undone on both sides of the email, and the
    // email itself is reported rather than treated as a wall.
    const after = active.store.__snapshot();
    expect(after.customers["c_003"]?.plan).toBe("free");
    expect(after.customers["c_001"]?.plan).toBe("pro");
    expect(after.outbox).toEqual(beforeUndo.outbox);
    expect(report.steps.map((step) => step.kind)).toEqual(["revert", "permanent", "revert"]);
  });

  it("does not stay stuck behind a permanent action an earlier run flagged", async () => {
    const active = await session();
    await active.client.callTool({
      name: "send_email",
      arguments: { to: "a@b.c", subject: "s", body: "b" },
    });
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });

    // What an older, stricter rollback left behind on a row it walled off.
    const email = active.journal.getActions(active.runId)[0];
    active.journal.markUnrecoverable(email?.id ?? "", "irreversible: this action cannot be undone");

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.halted).toBeUndefined();
    expect(active.store.__snapshot().customers["c_001"]?.plan).toBe("pro");
  });

  it("reverts the rest when something was approved but never retried", async () => {
    const active = await session({ realGate: true });
    await active.client
      .callTool({ name: "send_email", arguments: { to: "a@b.c", subject: "s", body: "b" } })
      .catch(() => undefined);
    const waiting = active.journal.listGated()[0];
    active.journal.approve(waiting?.id ?? "", "arhaan");
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });

    // Approved and never called again means it never went out. Reading that as
    // "we called it and cannot say what happened" would halt the whole undo.
    expect(report.halted).toBeUndefined();
    expect(active.store.__snapshot().customers["c_001"]?.plan).toBe("pro");
    expect(active.store.__snapshot().outbox).toEqual([]);
  });

  it("halts at an action whose outcome is unknown", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_003", plan: "pro" } });

    const first = active.journal.getActions(active.runId)[0];
    active.journal.markUnknown(first?.id ?? "", "process died mid-call");

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.status).toBe("partial");
    expect(report.halted?.seq).toBe(1);
    expect(report.halted?.reason).toMatch(/unknown/i);
  });

  it("skips readonly actions and calls nothing for them", async () => {
    const active = await session();
    await active.client.callTool({ name: "get_customer", arguments: { id: "c_001" } });
    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.steps[0]?.kind).toBe("skip");
    expect(report.status).toBe("rolled_back");
  });

  it("compensates an unverifiable action but says so", async () => {
    const active = await session();
    await active.client.callTool({
      name: "create_customer",
      arguments: { name: "Made", email: "m@example.com" },
    });
    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    const step = report.steps[0];
    expect(step?.kind).toBe("revert");
    // A compensable action declares no pre-read, so drift cannot be ruled out.
    expect(step?.verified).toBe(false);
    expect(active.store.__snapshot().customers["c_004"]).toBeUndefined();
  });
});

describe("an interrupted rollback", () => {
  it("resumes without applying any inverse twice", async () => {
    let failures = 0;
    let armed = false;
    const active = await session({
      beforeWrite: () => {
        if (armed) {
          failures += 1;
          if (failures === 2) {
            throw new Error("upstream died mid-rollback");
          }
        }
      },
    });

    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await active.client.callTool({
      name: "create_customer",
      arguments: { name: "Made", email: "m@example.com" },
    });
    await active.client.callTool({ name: "delete_customer", arguments: { id: "c_002" } });

    armed = true;
    const first = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(first.status).toBe("partial");

    armed = false;
    const second = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });

    expect(second.status).toBe("rolled_back");
    expect(JSON.stringify(active.store.__snapshot())).toBe(JSON.stringify(active.before));
  });

  it("does not re-run an inverse that already succeeded", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await rollback({ journal: active.journal, router: active.router, runId: active.runId });

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.steps.every((step: { kind: string }) => step.kind !== "revert")).toBe(true);
    expect(JSON.stringify(active.store.__snapshot())).toBe(JSON.stringify(active.before));
  });
});

/** A policy whose inverse is wrong: it restores the id but not the fields. */
const WRONG_POLICY = `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.update_customer"
    class: reversible
    snapshot: { tool: "crm.get_customer", args: { id: "$.id" } }
    inverse:
      tool: "crm.update_customer"
      args: { id: "$.id", plan: "$snapshot.wrong_field" }
`;

const FIXED_POLICY = WRONG_POLICY.replace("$snapshot.wrong_field", "$snapshot.plan");

describe("recovering from a policy that was wrong at the time", () => {
  it("rebuilds the inverse from a corrected manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-replan-"));
    const journal = openJournal(join(dir, "journal.db"));
    cleanups.push(() => {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const store = new ToyCrmStore({ now: () => "2026-01-01T00:00:00.000Z" });
    const before = store.__snapshot();
    const upstream = await inMemoryUpstream(createToyCrmServer(store), "crm");
    const manifest = parseManifest(WRONG_POLICY, "manifest.yaml");
    const proxy = createProxyServer({
      gate: autoApproveGate,
      upstreams: [upstream],
      manifest,
      journal,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent", version: "0.0.0" });
    await Promise.all([proxy.server.connect(st), client.connect(ct)]);
    const runId = await proxy.ready;
    cleanups.push(async () => {
      await client.close();
      await upstream.close();
    });

    await client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    const router = createRouter([upstream], manifest);

    // The inverse recorded at capture time cannot be resolved, so there is
    // nothing usable to undo with.
    const broken = await rollback({ journal, router, runId });
    expect(broken.status).toBe("partial");
    expect(store.__snapshot()).not.toEqual(before);

    // Correcting the manifest replays the captured pre-state through the fixed
    // template. No upstream state is re-read, so D5 still holds.
    const fixed = await rollback({
      journal,
      router,
      runId,
      replanWith: parseManifest(FIXED_POLICY, "manifest.yaml"),
    });
    expect(fixed.status).toBe("rolled_back");
    expect(fixed.steps[0]?.replanned).toBe(true);
    expect(JSON.stringify(store.__snapshot())).toBe(JSON.stringify(before));
  });
});
