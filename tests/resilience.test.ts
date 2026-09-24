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

async function session(options: { beforeWrite?: () => void } = {}): Promise<{ client: Client; journal: Journal; router: Router; runId: string; store: ToyCrmStore }> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-probe-"));
  const journal = openJournal(join(dir, "journal.db"));
  cleanups.push(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = new ToyCrmStore({
    now: () => "2026-01-01T00:00:00.000Z",
    ...(options.beforeWrite === undefined ? {} : { beforeWrite: options.beforeWrite }),
  });
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

describe("two undos racing for the same run", () => {
  it("sends each inverse once, however many are running", async () => {
    let writes = 0;
    const { client, journal, router, runId } = await session({
      beforeWrite: () => {
        writes += 1;
      },
    });
    await client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free" },
    });
    const afterAgent = writes;

    // Two terminals, or a key leaned on. Both read the action as applied and
    // both send its inverse: the write lands twice, and for a compensating
    // call rather than a restore that is a second real change.
    const reports = await Promise.all([
      rollback({ journal, router, runId }),
      rollback({ journal, router, runId }),
    ]);

    expect(writes - afterAgent).toBe(1);
    const reverted = reports.flatMap((report) =>
      report.steps.filter((step) => step.kind === "revert"),
    );
    expect(reverted).toHaveLength(1);
    const halted = reports.flatMap((report) =>
      report.steps.filter((step) => step.kind === "halt"),
    );
    expect(halted.some((step) => step.reason.includes("another undo"))).toBe(true);
  });
});

describe("several proxies sharing one journal", () => {
  it("waits its turn rather than failing the call", () => {
    // WAL allows one writer at a time, and SQLite does not wait by default:
    // a contended write returns "database is locked" straight away. Six agents
    // on one journal lost two of their calls to it -- and sharing a journal is
    // the arrangement this tool recommends.
    const dir = mkdtempSync(join(tmpdir(), "synartesis-busy-"));
    const path = join(dir, "journal.db");

    const writers = Array.from({ length: 8 }, () => openJournal(path));
    try {
      const runs = writers.map((journal, index) => journal.beginRun(`agent-${String(index)}`));
      // Interleaved on purpose, so the writes actually contend.
      for (let round = 0; round < 20; round += 1) {
        for (const [index, journal] of writers.entries()) {
          journal.recordPending({
            runId: runs[index] ?? "",
            server: "fs",
            tool: "write_file",
            args: { round },
            class: "reversible",
          });
        }
      }
      const counted = writers[0]?.getActions(runs[0] ?? "").length;
      expect(counted).toBe(20);
    } finally {
      for (const journal of writers) {
        journal.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The states a person could reach and not get back out of.
 *
 * Each of these was a guard written correctly with no exit built behind it:
 * undo stopped, for the right reason, and then stopped for ever. The promise
 * this whole tool makes is that you can always get back, so a halt that
 * nothing can answer is a worse failure than the one it was protecting
 * against.
 */
describe("the ways out of a halt", () => {
  it("settles an unknown outcome on a person's word, and undoes the rest", async () => {
    const { client, journal, router, runId, store } = await session();
    const before = store.__snapshot();
    await client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await client.callTool({ name: "update_customer", arguments: { id: "c_002", plan: "free" } });

    // The newest call went out and nobody can say whether it landed.
    const interrupted = journal.recordPending({
      runId,
      server: "crm",
      tool: "send_email",
      args: { to: "a@b.c" },
      class: "irreversible",
    });
    journal.markUnknown(interrupted.actionId, "the client gave up waiting");

    // Which stops everything older than it, and stopped it permanently.
    const blocked = await rollback({ journal, router, runId });
    expect(blocked.status).toBe("partial");
    expect(blocked.halted?.seq).toBe(interrupted.seq);

    // A person looks, and says what they found.
    const settled = journal.settleByHand(
      interrupted.actionId,
      "failed",
      "resolved as failed by arhaan: no mail was sent",
    );
    expect(settled).toBe(true);

    const after = await rollback({ journal, router, runId });
    expect(after.halted).toBeUndefined();
    // And the two writes underneath it are actually put back, which is the
    // whole point of being able to answer the question.
    expect(store.__snapshot()).toEqual(before);
  });

  it("does not invent an undo for an action resolved as applied", async () => {
    const { client, journal, router, runId } = await session();
    await client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    const unknown = journal.recordPending({
      runId,
      server: "crm",
      tool: "send_email",
      args: { to: "a@b.c" },
      class: "irreversible",
    });
    journal.markUnknown(unknown.actionId, "the client gave up waiting");

    journal.settleByHand(unknown.actionId, "applied", "resolved as applied by arhaan: it arrived");

    const report = await rollback({ journal, router, runId });
    // No inverse was ever resolved for it, so it is reported as something
    // that cannot be put back rather than quietly skipped or falsely
    // reversed -- and the run says partial because of it.
    const step = report.steps.find((one) => one.seq === unknown.seq);
    expect(step?.kind).toBe("permanent");
    expect(report.status).toBe("partial");
  });

  it("lets the proxy's own answer win over a person's", async () => {
    const { journal, runId } = await session();
    const action = journal.recordPending({
      runId,
      server: "crm",
      tool: "send_email",
      args: { to: "a@b.c" },
      class: "irreversible",
    });
    // The proxy came back and recorded what it actually saw.
    journal.markFailed(action.actionId, "upstream refused");
    // The person's guess arrives second and must not overwrite it.
    expect(journal.settleByHand(action.actionId, "applied", "resolved by arhaan")).toBe(false);
    expect(journal.getAction(action.actionId)?.status).toBe("failed");
  });

  it("stops an undo between actions when asked, leaving nothing half applied", async () => {
    const { client, journal, router, runId } = await session();
    await client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await client.callTool({ name: "update_customer", arguments: { id: "c_002", plan: "free" } });

    const stopping = new AbortController();
    stopping.abort();
    const report = await rollback({ journal, router, runId, interrupt: stopping.signal });

    expect(report.status).toBe("partial");
    expect(report.halted?.reason).toMatch(/interrupted/);
    // Not one row claimed and abandoned: the stop was taken before the claim,
    // which is the difference between a run that can be resumed and the one
    // state this tool has no way back from.
    for (const action of journal.getActions(runId)) {
      expect(action.status).not.toBe("rolling_back");
    }
    // And running it again finishes the job.
    const resumed = await rollback({ journal, router, runId });
    expect(resumed.halted).toBeUndefined();
  });

  it("does not let a client disconnecting erase that a run was undone", async () => {
    const { client, journal, router, runId } = await session();
    await client.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await rollback({ journal, router, runId });
    expect(journal.getRun(runId)?.status).toBe("rolled_back");

    // The agent's client goes away afterwards. A disconnect says this client
    // has gone, which is not news about whether the session was put back --
    // and it used to stamp `complete` straight over the fact that it had
    // been, so a session somebody had just reversed came back looking
    // untouched in `list`.
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(journal.getRun(runId)?.status).toBe("rolled_back");
  });

  it("does not let a disconnect overwrite how a session ended", () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-ended-"));
    const journal = openJournal(join(dir, "journal.db"));
    try {
      const runId = journal.beginRun("an-agent");
      journal.endRun(runId, "rolled_back");

      // What the proxy does when its client goes away. It says nothing about
      // whether the session was put back, and unrestricted it erased the only
      // record that it had been.
      journal.endRun(runId, "complete", ["active"]);
      expect(journal.getRun(runId)?.status).toBe("rolled_back");
    } finally {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pruning a session that recorded how its servers started", () => {
  it("removes that record along with the session instead of refusing", () => {
    // run_servers references the run, and foreign keys are on. Deleting the
    // run while that row existed is refused, so without this every session
    // that recorded its servers -- which is every session -- would become
    // impossible to prune.
    const dir = mkdtempSync(join(tmpdir(), "synartesis-prune-servers-"));
    const journal = openJournal(join(dir, "journal.db"));
    try {
      const runId = journal.beginRun("an-agent");
      journal.recordRunServer(runId, "crm", "/work", { CRM_TOKEN: "f00d" });
      journal.endRun(runId, "complete");

      const far = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const stale = journal.prunableRuns(far).map((run) => run.id);
      expect(stale).toContain(runId);
      expect(() => journal.deleteRuns(stale)).not.toThrow();
      expect(journal.getRun(runId)).toBeUndefined();
      expect(journal.runServer(runId, "crm")).toBeUndefined();
    } finally {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
