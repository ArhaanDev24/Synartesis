import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";

import { createToyCrmServer } from "../fixtures/toy-crm/server.js";
import { ToyCrmStore, type ToyCrmState } from "../fixtures/toy-crm/store.js";
import { openJournal, type Journal } from "../src/journal/journal.js";
import { loadManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { rollback } from "../src/rollback/rollback.js";
import { parseManifest } from "../src/manifest/load.js";
import type { Manifest } from "../src/manifest/types.js";
import { autoApproveGate, inMemoryUpstream } from "./helpers/harness.js";

/** A pid that is certainly nobody: a process we started and watched exit. */
async function exited(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid ?? 0;
}

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
  /** So a test can construct history no api should offer to construct. */
  readonly journalPath: string;
}

async function session(
  options: { beforeWrite?: () => void; realGate?: boolean; manifest?: Manifest } = {},
): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-rollback-"));
  const journalPath = join(dir, "journal.db");
  const journal = openJournal(journalPath);
  cleanups.push(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const store = new ToyCrmStore({
    now: () => "2026-01-01T00:00:00.000Z",
    ...(options.beforeWrite === undefined ? {} : { beforeWrite: options.beforeWrite }),
  });
  const before = store.__snapshot();

  const policy = options.manifest ?? MANIFEST;
  const upstream = await inMemoryUpstream(createToyCrmServer(store), "crm");
  const router = createRouter([upstream], policy);
  const proxy = createProxyServer({
    upstreams: [upstream],
    manifest: policy,
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

  return { client, store, journal, router, runId, before, journalPath };
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
    expect(second.halted?.detail ?? "").toMatch(/last time|when it halted/i);
    // And it is marked as somebody's decision rather than a fault, which is
    // what puts the ways past it in front of them.
    expect(second.halted?.conflict).toBe(true);
  });

  it("says what undoing anyway would write over, not only what changed", async () => {
    const active = await session();
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free", notes: "agent edit" },
    });
    active.store.updateCustomer("c_001", { notes: "a human wrote this" });

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.halted?.conflict).toBe(true);
    // The half a person deciding actually needs: their own line is the one
    // that would go.
    expect(report.halted?.overwrites ?? "").toContain("a human wrote this");
  });

  it("undoes over a change when a person asks for it in so many words", async () => {
    const active = await session();
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free", notes: "agent edit" },
    });
    active.store.updateCustomer("c_001", { notes: "a human wrote this" });

    const refused = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(refused.status).toBe("partial");

    // Same conflict, same checks; the difference is who decides. Note this
    // also has to get past the unrecoverable the refusal just recorded.
    const forced = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      force: true,
    });
    expect(forced.status).toBe("rolled_back");
    expect(active.store.getCustomer("c_001").notes).toBe("founding customer");
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

describe("when the drift check itself cannot run", () => {
  /** A server that has gone away between the run and the undo. */
  async function unreachable(active: Session): Promise<void> {
    for (const upstream of active.router.upstreams) {
      await upstream.close();
    }
  }

  it("leaves an applied action applied, so the next attempt needs no flag", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await unreachable(active);

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });

    expect(report.status).toBe("partial");
    expect(report.halted?.reason).toMatch(/could not read current state/);
    // The read never happened, so nothing was learned about the resource.
    // Recording `unrecoverable` here made the next plain undo refuse with
    // "halted here on an earlier attempt" and demand --replan or --force --
    // a server that was briefly down turning a working undo into one that
    // needs the flag that writes over other people's changes.
    expect(active.journal.getActions(active.runId)[0]?.status).toBe("applied");
  });

  it("keeps the drift it recorded earlier instead of overwriting it", async () => {
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
    const recorded = active.journal.getActions(active.runId)[0]?.error ?? "";
    expect(recorded).toContain("a human wrote this");

    // Tried again the way the halt itself recommends -- put the resource
    // back, then --replan -- while the server happens to be unreachable.
    // Without the replan this stops at "halted here on an earlier attempt"
    // and never reaches the read, which is why the first version of this
    // test passed against the bug it was written for. The stored conflict is
    // the evidence the person deciding is shown; a transport error must not
    // take its place.
    await unreachable(active);
    await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      replanWith: MANIFEST,
    });

    expect(active.journal.getActions(active.runId)[0]?.error).toBe(recorded);
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

    // A process that dies mid-call leaves the row where recordPending put it:
    // pending, outcome unknown. Marking an applied row unknown afterwards
    // describes a state nothing can produce, so it is written directly here
    // rather than through an api that should refuse it.
    const first = active.journal.getActions(active.runId)[0];
    const db = new Database(active.journalPath);
    db.prepare("UPDATE actions SET status = 'pending', error = ? WHERE id = ?").run(
      "process died mid-call",
      first?.id ?? "",
    );
    db.close();

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
    // A compensable policy that declares neither a pre-read nor a `verify`
    // read. Nothing can rule out drift on it, so undo compensates and admits
    // it did so blind. The shipped toy-crm policy declares a verify read now,
    // which is why this one is written out here rather than reusing it.
    const blind = parseManifest(
      `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.create_customer"
    class: compensable
    inverse:
      tool: "crm.delete_customer"
      args: { id: "$result.id" }
`,
      "blind.yaml",
    );
    const active = await session({ manifest: blind });
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
    expect(step?.verified).toBe(false);
    expect(step?.reason).toContain("drift could not be ruled out");
    expect(active.store.__snapshot().customers["c_004"]).toBeUndefined();
  });

  it("verifies the same action once its policy declares a verify read", async () => {
    // The shipped policy, for contrast: same call, same compensation, but the
    // resource is read back afterwards so drift can be ruled out.
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
    expect(report.steps[0]?.verified).toBe(true);
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

describe("planning with --to", () => {
  it("shows what it is leaving behind, not only what it will touch", async () => {
    // A dry run listed the actions above the floor and said nothing at all
    // about the ones below it, so the one thing --to is for -- deciding where
    // to stop -- was the one thing you could not see.
    const active = await session();
    for (const notes of ["first", "second", "third"]) {
      await active.client.callTool({
        name: "update_customer",
        arguments: { id: "c_001", notes },
      });
    }

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      toSeq: 3,
      dryRun: true,
    });

    const kept = report.steps.filter((step) => step.kind === "kept");
    expect(kept.map((step) => step.seq).sort()).toEqual([1, 2]);
    expect(kept[0]?.reason).toMatch(/below --to/i);
    // And the ones it would act on are still there.
    expect(report.steps.filter((step) => step.kind === "revert").map((s) => s.seq)).toEqual([3]);
  });
});

describe("two people forcing the same undo at once", () => {
  it("sends the inverse once, not once per caller", async () => {
    const active = await session();
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free", notes: "agent edit" },
    });
    active.store.updateCustomer("c_001", { notes: "a human wrote this" });

    // The refusal, which is what leaves the row unrecoverable.
    await rollback({ journal: active.journal, router: active.router, runId: active.runId });

    // Count what actually reaches the store rather than what the reports say:
    // a double-apply is invisible for an idempotent write and ruinous for a
    // compensable one, and the reports would look identical either way.
    let writes = 0;
    const store = active.store;
    const real = store.updateCustomer.bind(store);
    store.updateCustomer = (id: string, patch: Record<string, unknown>) => {
      writes += 1;
      return real(id, patch);
    };

    const both = await Promise.all([
      rollback({ journal: active.journal, router: active.router, runId: active.runId, force: true }),
      rollback({ journal: active.journal, router: active.router, runId: active.runId, force: true }),
    ]);

    expect(writes).toBe(1);
    expect(both.filter((report) => report.status === "rolled_back")).toHaveLength(1);
  });
});

describe("recovering from drift that has since been resolved", () => {
  it("lets an explicit replan claim the action a refusal marked unrecoverable", async () => {
    const active = await session();
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free", notes: "agent edit" },
    });

    // Somebody edits it, undo refuses, and the row is left unrecoverable.
    active.store.updateCustomer("c_001", { notes: "a human wrote this" });
    const refused = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(refused.halted?.reason).toMatch(/drift/i);

    // Then they put it back the way the run left it, which is one of the
    // three ways out the halt itself offers.
    active.store.updateCustomer("c_001", { notes: "agent edit" });

    const again = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      replanWith: MANIFEST,
    });

    // The drift check passes now, so there is nothing left to stop it. The
    // claim allowed only `applied`, so this used to report that another undo
    // held the action -- which was never true.
    expect(again.status).toBe("rolled_back");
    expect(active.store.getCustomer("c_001").notes).toBe("founding customer");
  });

  it("still halts a replan when the drift has not been resolved", async () => {
    const active = await session();
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free", notes: "agent edit" },
    });
    active.store.updateCustomer("c_001", { notes: "a human wrote this" });
    await rollback({ journal: active.journal, router: active.router, runId: active.runId });

    const again = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      replanWith: MANIFEST,
    });
    expect(again.halted).toBeDefined();
    expect(active.store.getCustomer("c_001").notes).toBe("a human wrote this");
  });
});

describe("previewing several writes to one record", () => {
  it("does not invent drift that a real undo would never hit", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "enterprise" } });

    const preview = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      dryRun: true,
    });

    // Nobody touched anything. Undo walks backwards, so by the time the first
    // write is checked the second inverse has already put `free` back -- but a
    // preview applies nothing, so the earlier action was compared against the
    // untouched `enterprise` and called drift.
    expect(preview.halted).toBeUndefined();
    expect(preview.steps.filter((step) => step.kind === "revert")).toHaveLength(2);

    // And the preview is still a preview.
    expect(active.store.getCustomer("c_001").plan).toBe("enterprise");
  });

  it("still sees drift somebody really caused", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "enterprise" } });
    active.store.updateCustomer("c_001", { notes: "a human wrote this" });

    const preview = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      dryRun: true,
    });
    expect(preview.halted).toBeDefined();
  });

  it("agrees with what the real undo then does", async () => {
    const active = await session();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "enterprise" } });

    const preview = await rollback({
      journal: active.journal, router: active.router, runId: active.runId, dryRun: true,
    });
    const real = await rollback({
      journal: active.journal, router: active.router, runId: active.runId,
    });

    expect(preview.steps.map((s) => s.kind)).toEqual(real.steps.map((s) => s.kind));
    expect(active.store.getCustomer("c_001").plan).toBe("pro");
  });
});

describe("two undos where the first is still mid-inverse", () => {
  it("does not send the inverse twice", async () => {
    const active = await session();
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free", notes: "agent edit" },
    });
    const [action] = active.journal.getActions(active.runId);
    if (action === undefined) {
      throw new Error("nothing recorded");
    }

    // The first undo has claimed the action and its inverse is in flight. The
    // row says `rolling_back`, which is also what a process that died mid
    // inverse leaves behind -- and those two need telling apart, because one
    // of them means somebody else is about to write.
    expect(active.journal.markRollingBack(action.id)).toBe(true);

    let writes = 0;
    const store = active.store;
    const real = store.updateCustomer.bind(store);
    store.updateCustomer = (id: string, patch: Record<string, unknown>) => {
      writes += 1;
      return real(id, patch);
    };

    await rollback({ journal: active.journal, router: active.router, runId: active.runId });

    // The first undo will send its own inverse when it finishes. A second one
    // is a second real change to the world for anything compensable.
    expect(writes).toBe(0);
  });

  it("resumes one whose owner died, because the world proves nothing was sent", async () => {
    const active = await session();
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free", notes: "agent edit" },
    });
    const [action] = active.journal.getActions(active.runId);
    if (action === undefined) {
      throw new Error("nothing recorded");
    }

    // An undo claimed it and was killed before it sent anything -- one Ctrl-C
    // on the command whose whole job is getting back. The row says
    // `rolling_back` and used to stay that way for ever: no flag, no command
    // and no amount of waiting could reclaim it.
    expect(active.journal.markRollingBack(action.id)).toBe(true);
    const dead = await exited();
    const db = new Database(active.journalPath);
    db.prepare("UPDATE leases SET pid = ? WHERE action_id = ?").run(dead, action.id);
    db.close();

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });

    // Reclaimed and finished. Safe because the drift check ran first: the
    // resource still matched what the run left, so the inverse provably never
    // landed and sending it cannot double-apply.
    expect(report.status).toBe("rolled_back");
    expect(report.steps[0]?.kind).toBe("revert");
    expect(active.store.__snapshot()).toEqual(active.before);
    expect(active.journal.getActions(active.runId)[0]?.status).toBe("rolled_back");
  });

  it("still refuses when the owner is alive, whatever is asked of it", async () => {
    const active = await session();
    await active.client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free", notes: "agent edit" },
    });
    const [action] = active.journal.getActions(active.runId);
    if (action === undefined) {
      throw new Error("nothing recorded");
    }
    // Claimed by this process, which is indisputably running.
    expect(active.journal.markRollingBack(action.id)).toBe(true);

    for (const extra of [{}, { force: true }, { replanWith: MANIFEST }]) {
      const report = await rollback({
        journal: active.journal,
        router: active.router,
        runId: active.runId,
        ...extra,
      });
      expect(report.status).toBe("partial");
      expect(report.halted?.reason).toMatch(/still running/);
    }
  });
});

describe("why a call is held", () => {
  it("says a tool has no rule, rather than that it cannot be undone", async () => {
    // Two different problems shared one sentence. A tool no rule mentions is
    // held because nobody has said what it does -- and "this action cannot be
    // undone" sent people off to approve every call to it, when what it
    // needed was one line of policy.
    const uncovered = parseManifest(
      `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.send_email"
    class: irreversible
    gate: always
`,
      "manifest.yaml",
    );
    const active = await session({ realGate: true, manifest: uncovered });

    const noRule = await active.client
      .callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } })
      .then(() => "went through", (error: unknown) => String(error));
    expect(noRule).toContain("there is no rule for crm.update_customer");
    expect(noRule).not.toContain("cannot be undone");

    const permanent = await active.client
      .callTool({ name: "send_email", arguments: { to: "a@b.c", subject: "s", body: "b" } })
      .then(() => "went through", (error: unknown) => String(error));
    expect(permanent).toContain("cannot be undone");
  });
});

describe("a tool no rule mentions, that its server marks read-only", () => {
  const policy = (extra: string): Manifest =>
    parseManifest(
      `version: 1
servers:
  crm:
    command: node
    args: []
${extra}tools:
  - match: "crm.send_email"
    class: irreversible
    gate: always
`,
      "manifest.yaml",
    );
  const lookUp = { name: "get_customer", arguments: { id: "c_001" } };

  it("is read as a read instead of being held", async () => {
    const active = await session({ realGate: true, manifest: policy("") });
    await active.client.listTools();
    const read = await active.client.callTool(lookUp);
    expect(read.isError).toBeFalsy();
    const row = active.journal.getActions(active.runId).find((action) => action.tool === "get_customer");
    expect(row?.class).toBe("readonly");

    // The mark only ever loosens a read. A tool the server does not mark
    // read-only, with no rule, is held exactly as before.
    const unmarked = await active.client
      .callTool({ name: "delete_customer", arguments: { id: "c_001" } })
      .then(() => "went through", (error: unknown) => String(error));
    expect(unmarked).toContain("there is no rule for crm.delete_customer");
  });

  it("is held when the policy says not to trust the server's marks", async () => {
    const active = await session({
      realGate: true,
      manifest: parseManifest(
        "version: 1\nservers:\n  crm:\n    command: node\n    trust_annotations: false\n",
        "manifest.yaml",
      ),
    });
    await active.client.listTools();
    const held = await active.client
      .callTool(lookUp)
      .then(() => "went through", (error: unknown) => String(error));
    expect(held).toContain("holding this call");
  });

  it("is held on a pinned server, where every tool is vouched for by hand", async () => {
    const active = await session({
      realGate: true,
      manifest: policy('pins:\n  crm:\n    send_email: "sha256:any"\n'),
    });
    await active.client.listTools();
    const held = await active.client
      .callTool(lookUp)
      .then(() => "went through", (error: unknown) => String(error));
    expect(held).toContain("holding this call");
  });
});
