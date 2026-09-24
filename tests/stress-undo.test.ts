import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createToyCrmServer } from "../fixtures/toy-crm/server.js";
import { ToyCrmStore, type ToyCrmState } from "../fixtures/toy-crm/store.js";
import { openJournal, type Journal } from "../src/journal/journal.js";
import { loadManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { rollback } from "../src/rollback/rollback.js";
import { autoApproveGate, inMemoryUpstream } from "./helpers/harness.js";

/**
 * The promise, attacked with sessions nobody wrote by hand.
 *
 * Every other test in this suite is a scenario somebody thought of. These are
 * generated: a seeded random agent makes a random sequence of creates,
 * updates, deletes and reads -- against ids that exist and ids that do not,
 * with values chosen to be awkward -- and then the same three things are
 * asked of every session.
 *
 *   1. Undoing all of it puts the store back exactly, byte for byte, even when
 *      the undo is cut off part way and run again, more than once.
 *   2. Undoing down to any step leaves the store exactly as it was at that
 *      step.
 *   3. A change a person made afterwards is never written over.
 *
 * A failure prints its seed; the session it names can be replayed exactly.
 */

const MANIFEST = loadManifest("manifests/toy-crm.yaml");
const SESSIONS = Number(process.env["SYNARTESIS_STRESS_SESSIONS"] ?? "60");

/** One seed to replay, from SYNARTESIS_STRESS_SEED, or all of them. */
function seeds(): number[] {
  const one = process.env["SYNARTESIS_STRESS_SEED"];
  return one === undefined ? Array.from({ length: SESSIONS }, (_, i) => i + 1) : [Number(one)];
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) {
    await clean();
  }
});

/** mulberry32: small, fast, and the same sequence for the same seed everywhere. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Values chosen to break naive handling: empty, unicode, quotes, long, JSON-ish. */
const AWKWARD = [
  "",
  "plain",
  "Zoë — naïve café ☕",
  "emoji 🧪🔥 and 中文",
  'quotes " and \\ backslashes',
  "{\"looks\": \"like json\"}",
  "line one\nline two\r\nline three",
  "x".repeat(5000),
  "$.id",
  "$snapshot.notes",
  "__proto__",
  "   padded   ",
];

const PLANS = ["free", "pro", "enterprise"] as const;

interface Session {
  readonly client: Client;
  readonly store: ToyCrmStore;
  readonly journal: Journal;
  readonly router: Router;
  readonly runId: string;
  readonly path: string;
  /** Throw on the write this many writes from now; undefined to stop. */
  crash: { before?: number | undefined; after?: number | undefined };
}

async function open(): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-stress-"));
  const path = join(dir, "journal.db");
  const journal = openJournal(path);
  const control: Session["crash"] = {};
  const store = new ToyCrmStore({
    now: () => "2026-01-01T00:00:00.000Z",
    // A crash before a write: the write never happens.
    beforeWrite: () => {
      if (control.before !== undefined) {
        control.before -= 1;
        if (control.before < 0) {
          control.before = undefined;
          throw new Error("injected: the process died before this write");
        }
      }
    },
    // A crash after a write: it landed, and the answer was lost. The hardest
    // case for a resumed undo, which must not apply it a second time.
    afterWrite: () => {
      if (control.after !== undefined) {
        control.after -= 1;
        if (control.after < 0) {
          control.after = undefined;
          throw new Error("injected: the process died after this write, before answering");
        }
      }
    },
  });
  const upstream = await inMemoryUpstream(createToyCrmServer(store), "crm");
  const router = createRouter([upstream], MANIFEST);
  const proxy = createProxyServer({ upstreams: [upstream], manifest: MANIFEST, journal, gate: autoApproveGate });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "random-agent", version: "0" });
  await Promise.all([proxy.server.connect(st), client.connect(ct)]);
  const runId = await proxy.ready;
  cleanups.push(async () => {
    await client.close();
    await upstream.close();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { client, store, journal, router, runId, path, crash: control };
}

type Call = { readonly name: string; readonly arguments: Record<string, unknown> };

function nextCall(pick: () => number, known: readonly string[]): Call {
  const one = <T,>(items: readonly T[], otherwise: T): T => items[Math.floor(pick() * items.length)] ?? otherwise;
  // Mostly ids that exist; sometimes one that never did.
  const id = pick() < 0.12 ? "c_999" : one(known, "c_001");
  const roll = pick();
  if (roll < 0.15) {
    return { name: "get_customer", arguments: { id } };
  }
  if (roll < 0.35) {
    return {
      name: "create_customer",
      arguments: {
        name: one(AWKWARD, "") || "n",
        email: `${one(AWKWARD, "").slice(0, 20)}@e.x`,
        plan: one(PLANS, "free"),
        notes: one(AWKWARD, ""),
      },
    };
  }
  if (roll < 0.8) {
    const patch: Record<string, unknown> = { id };
    for (const field of ["name", "email", "notes"] as const) {
      if (pick() < 0.5) {
        patch[field] = one(AWKWARD, "");
      }
    }
    if (pick() < 0.4) {
      patch["plan"] = one(PLANS, "free");
    }
    return { name: "update_customer", arguments: patch };
  }
  return { name: "delete_customer", arguments: { id } };
}

/** Runs a random session and returns the store as it was after each recorded step. */
async function agent(active: Session, seed: number): Promise<Map<number, ToyCrmState>> {
  const pick = random(seed);
  const after = new Map<number, ToyCrmState>();
  const steps = 1 + Math.floor(pick() * 14);
  for (let i = 0; i < steps; i += 1) {
    const known = Object.keys(active.store.__snapshot().customers);
    await active.client.callTool(nextCall(pick, known)).catch(() => undefined);
    const last = active.journal.getActions(active.runId).at(-1);
    if (last !== undefined) {
      after.set(last.seq, active.store.__snapshot());
    }
  }
  return after;
}

/** Undo to `toSeq`, resuming through injected crashes, as a person would by running it again. */
async function undoThroughCrashes(active: Session, pick: () => number, toSeq?: number): Promise<string> {
  let status = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // Half the attempts are cut off, at a random write, one way or the other.
    if (attempt < 3 && pick() < 0.5) {
      if (pick() < 0.5) {
        active.crash.before = Math.floor(pick() * 4);
      } else {
        active.crash.after = Math.floor(pick() * 4);
      }
    }
    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
      ...(toSeq === undefined ? {} : { toSeq }),
    }).catch((error: unknown) => ({ status: `threw: ${String(error)}`, halted: undefined }));
    active.crash.before = undefined;
    active.crash.after = undefined;
    status = report.status;
    if (process.env["SYNARTESIS_STRESS_TRACE"] !== undefined) {
      console.log(JSON.stringify({ attempt, status: report.status, halted: report.halted }));
    }
    if (report.status === "rolled_back" || (toSeq !== undefined && report.status === "partial" && report.halted === undefined)) {
      return "done";
    }
  }
  return status;
}

describe("undo, against sessions nobody wrote by hand", () => {
  it(`puts the store back exactly after ${String(SESSIONS)} random sessions, crashes and all`, async () => {
    const failures: string[] = [];
    for (const seed of seeds()) {
      const active = await open();
      const before = active.store.__snapshot();
      await agent(active, seed);
      const outcome = await undoThroughCrashes(active, random(seed * 7919));
      const now = active.store.__snapshot();
      if (outcome !== "done" || JSON.stringify(now.customers) !== JSON.stringify(before.customers)) {
        failures.push(`seed ${String(seed)}: ${outcome}`);
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);

  it("leaves the store exactly as it was at whichever step it is undone to", async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SESSIONS; seed += 1) {
      const active = await open();
      const before = active.store.__snapshot();
      const after = await agent(active, seed);
      const seqs = [...after.keys()].sort((a, b) => a - b);
      if (seqs.length < 2) {
        continue;
      }
      const pick = random(seed * 104729);
      const keep = seqs[Math.floor(pick() * (seqs.length - 1))] ?? 0;
      const report = await rollback({ journal: active.journal, router: active.router, runId: active.runId, toSeq: keep + 1 });
      const expected = after.get(keep) ?? before;
      const now = active.store.__snapshot();
      if (report.halted !== undefined || JSON.stringify(now.customers) !== JSON.stringify(expected.customers)) {
        failures.push(`seed ${String(seed)} to ${String(keep + 1)}: ${report.status} ${report.halted?.reason ?? ""}`);
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);

  it("never writes over a change a person made afterwards", async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SESSIONS; seed += 1) {
      const active = await open();
      await agent(active, seed);
      const pick = random(seed * 15485863);
      const touched = active.journal
        .getActions(active.runId)
        .filter((action) => action.status === "applied" && action.class !== "readonly")
        .map((action) => z.object({ id: z.string() }).safeParse(action.args).data?.id)
        .filter((id): id is string => id !== undefined && active.store.__snapshot().customers[id] !== undefined);
      const target = touched[Math.floor(pick() * touched.length)];
      if (target === undefined) {
        continue;
      }
      // A person, outside any agent, edits one record the agent touched.
      const mark = `edited by a person, seed ${String(seed)}`;
      const human = active.store.__snapshot();
      const record = human.customers[target];
      if (record === undefined) {
        continue;
      }
      active.store.__restore({ ...human, customers: { ...human.customers, [target]: { ...record, notes: mark } } });

      await rollback({ journal: active.journal, router: active.router, runId: active.runId });
      const survived = active.store.__snapshot().customers[target]?.notes;
      if (survived !== mark) {
        failures.push(`seed ${String(seed)}: ${target} notes became ${JSON.stringify(survived)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});

describe("an inverse the server applied and then reported as failed", () => {
  it("is recognised as done, rather than called drift for ever after", async () => {
    // What the random sessions found. The undo of a create is a delete; the
    // server deleted, then failed before answering. Read as "refused", the
    // next attempt found the record gone and called that somebody else's
    // change -- and every attempt after that refused on the strength of it.
    const active = await open();
    const before = active.store.__snapshot();
    await active.client.callTool({
      name: "create_customer",
      arguments: { name: "Made", email: "m@e.x", plan: "pro", notes: "" },
    });
    active.crash.after = 0;
    const report = await rollback({ journal: active.journal, router: active.router, runId: active.runId });
    expect(report.status).toBe("rolled_back");
    expect(report.steps[0]?.note).toContain("reported an error");
    expect(active.store.__snapshot().customers).toEqual(before.customers);
  });

  it("still retries one the server really refused, which changed nothing", async () => {
    const active = await open();
    const before = active.store.__snapshot();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", notes: "agent" } });
    active.crash.before = 0;
    const first = await rollback({ journal: active.journal, router: active.router, runId: active.runId });
    expect(first.status).toBe("partial");
    expect(active.store.__snapshot().customers["c_001"]?.notes).toBe("agent");
    const second = await rollback({ journal: active.journal, router: active.router, runId: active.runId });
    expect(second.status).toBe("rolled_back");
    expect(active.store.__snapshot().customers).toEqual(before.customers);
  });
});

describe("an undo killed between claiming an action and recording who claimed it", () => {
  it("leaves no action claimed with nobody holding it", async () => {
    // The claim and the lease were two separate writes. A kill between them
    // left a row rolling_back with no owner, which no later undo could ever
    // tell from a live one. Here the lease write is made to fail, which is
    // the same moment without needing a kill: the claim must fail with it.
    const active = await open();
    await active.client.callTool({ name: "update_customer", arguments: { id: "c_001", notes: "agent" } });
    const row = active.journal.getActions(active.runId)[0];
    if (row === undefined) {
      throw new Error("nothing recorded");
    }
    const db = new Database(active.path);
    db.exec("CREATE TRIGGER no_leases BEFORE INSERT ON leases BEGIN SELECT RAISE(ABORT, 'killed here'); END");
    db.close();
    expect(() => active.journal.markRollingBack(row.id)).toThrow();
    expect(active.journal.getAction(row.id)?.status).toBe("applied");
  });
});

describe("resuming after an undo was killed mid-compensation", () => {
  /** A pid that is certainly not running: a process that has already exited. */
  function deadPid(): number {
    const child = spawnSync("node", ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    return Number(child.stdout);
  }

  async function killedDuringTheDelete(): Promise<{ active: Session; id: string; made: string }> {
    const active = await open();
    await active.client.callTool({
      name: "create_customer",
      arguments: { name: "Made", email: "m@e.x", plan: "pro", notes: "" },
    });
    const row = active.journal.getActions(active.runId)[0];
    const made =
      Object.keys(active.store.__snapshot().customers).find((id) => !["c_001", "c_002", "c_003"].includes(id)) ?? "";
    if (row === undefined) {
      throw new Error("nothing recorded");
    }
    // The undo that claimed it, and then died.
    expect(active.journal.markRollingBack(row.id)).toBe(true);
    const db = new Database(active.path);
    db.prepare("UPDATE leases SET pid = ? WHERE action_id = ?").run(deadPid(), row.id);
    db.close();
    return { active, id: row.id, made };
  }

  it("recognises the delete that landed before the kill", async () => {
    const { active, made } = await killedDuringTheDelete();
    const before = active.store.__snapshot();
    const rest = Object.fromEntries(Object.entries(before.customers).filter(([id]) => id !== made));
    active.store.__restore({ ...before, customers: rest });
    const report = await rollback({ journal: active.journal, router: active.router, runId: active.runId });
    expect(report.status).toBe("rolled_back");
  });

  it("still stops when somebody edited the record instead", async () => {
    const { active, made } = await killedDuringTheDelete();
    const before = active.store.__snapshot();
    const record = before.customers[made];
    if (record === undefined) {
      throw new Error("the created customer is missing");
    }
    active.store.__restore({ ...before, customers: { ...before.customers, [made]: { ...record, notes: "a person" } } });
    const report = await rollback({ journal: active.journal, router: active.router, runId: active.runId });
    expect(report.status).toBe("partial");
    expect(active.store.__snapshot().customers[made]?.notes).toBe("a person");
  });
});
