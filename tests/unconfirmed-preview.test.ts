/**
 * A write that landed, from a server that never said so.
 *
 * Synartesis already handles this correctly -- it refuses to read `isError` as
 * a promise that nothing happened, reads the resource back, and records the
 * change as recoverable. What it did not do was say so afterwards. The undo
 * preview rendered an action established by a read-back and an action the
 * server confirmed as the same line, and the difference between those two is
 * the entire question a person has in front of them at that moment.
 *
 * So these are about what the preview says, not about what it does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createToyCrmServer } from "../fixtures/toy-crm/server.js";
import { ToyCrmStore } from "../fixtures/toy-crm/store.js";
import { openJournal, type Journal } from "../src/journal/journal.js";
import { loadManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { rollback, type RollbackStep } from "../src/rollback/rollback.js";
import { autoApproveGate, inMemoryUpstream } from "./helpers/harness.js";

const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Live {
  readonly client: Client;
  readonly store: ToyCrmStore;
  readonly journal: Journal;
  readonly router: Router;
  readonly runId: string;
  /** Make the upstream answer with a timeout *after* it has already written. */
  arm: (on: boolean) => void;
}

async function session(): Promise<Live> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-unconfirmed-"));
  dirs.push(dir);
  const journal = openJournal(join(dir, "journal.db"));
  closers.push(() => {
    journal.close();
  });

  let armed = false;
  const store = new ToyCrmStore({
    now: () => "2026-01-01T00:00:00.000Z",
    // After the store has changed, which is the whole point: the write landed
    // and the answer that came back said it had not.
    afterWrite: () => {
      if (armed) {
        throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
      }
    },
  });
  const manifest = loadManifest("manifests/toy-crm.yaml");
  const upstream = await inMemoryUpstream(createToyCrmServer(store), "crm");
  const router = createRouter([upstream], manifest);
  const proxy = createProxyServer({ upstreams: [upstream], manifest, journal, gate: autoApproveGate });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "preview", version: "0" });
  await Promise.all([proxy.server.connect(serverSide), client.connect(clientSide)]);
  const runId = await proxy.ready;
  closers.push(async () => {
    await client.close();
    await upstream.close();
  });

  return {
    client, store, journal, router, runId,
    arm: (on: boolean) => {
      armed = on;
    },
  };
}

async function preview(live: Live): Promise<readonly RollbackStep[]> {
  const plan = await rollback({ journal: live.journal, router: live.router, runId: live.runId, dryRun: true });
  return plan.steps;
}

function at(steps: readonly RollbackStep[], seq: number): RollbackStep {
  const found = steps.find((step) => step.seq === seq);
  if (found === undefined) {
    throw new Error(`no step at ${String(seq)}`);
  }
  return found;
}

describe("a write the server never confirmed", () => {
  it("is recorded as one, not just logged as one", async () => {
    const live = await session();
    live.arm(true);
    await live.client
      .callTool({ name: "update_customer", arguments: { id: "c_001", plan: "enterprise" } })
      .catch(() => undefined);
    live.arm(false);

    const row = live.journal.getActions(live.runId)[0];
    if (row === undefined) {
      throw new Error("nothing was recorded");
    }
    // The recovery itself, which came first and is not what this is about:
    // the answer said failure, the resource says otherwise, and the resource
    // wins. Without this the rest of the test is checking the wrong row.
    expect(row.status).toBe("applied");
    expect(row.inverse).toBeDefined();

    // And now the part that was missing. This used to be a log line.
    expect(row.error).toContain("reading the resource back");
    expect(row.error).toContain("nothing confirmed it");
  });

  it("does not render as a line that looks confirmed", async () => {
    const live = await session();

    // One of each, in one session, because the failure was never that the
    // caveat was wrong -- it was that the two were indistinguishable.
    await live.client.callTool({ name: "update_customer", arguments: { id: "c_002", plan: "free" } });
    live.arm(true);
    await live.client
      .callTool({ name: "update_customer", arguments: { id: "c_001", plan: "enterprise" } })
      .catch(() => undefined);
    live.arm(false);

    const steps = await preview(live);
    const confirmed = at(steps, 1);
    const inferred = at(steps, 2);

    // Both are sound reverts. Both say the same thing about what undo will do.
    expect(confirmed.kind).toBe("revert");
    expect(inferred.kind).toBe("revert");
    expect(inferred.reason).toBe(confirmed.reason);

    // The note is the only thing that separates them, so it has to be there,
    // and it has to be absent from the other one or it separates nothing.
    expect(confirmed.note).toBeUndefined();
    expect(inferred.note).toContain("nothing confirmed it");
  });

  it("says why there is no post-state rather than only that there is none", async () => {
    const live = await session();
    await live.client.callTool({ name: "update_customer", arguments: { id: "c_002", plan: "free" } });

    // The other ambiguous path: the transport failed outright, the read-back
    // proved the write had landed, and markApplied recorded it with no
    // post-state. Seeded, because a fixture cannot kill its own transport --
    // proxy.ts reaches this through `whatHappened` returning "applied" in its
    // catch, and this is the row that comes out of it.
    const seeded = live.journal.recordPending({
      runId: live.runId,
      server: "crm",
      tool: "update_customer",
      args: { id: "c_003", plan: "free" },
      class: "reversible",
    });
    live.journal.markApplied(seeded.actionId, {
      result: undefined,
      inverse: { server: "crm", tool: "update_customer", args: { id: "c_003", plan: "pro" } },
      verify: { server: "crm", tool: "get_customer", args: { id: "c_003" } },
      warning: "the call applied but its answer never arrived: MCP error -32001: Request timed out",
    });

    const plan = await rollback({
      journal: live.journal,
      router: live.router,
      runId: live.runId,
      dryRun: true,
    });

    // It still stops, which was always right.
    expect(plan.halted?.seq).toBe(seeded.seq);
    expect(plan.halted?.reason).toContain("post-state was never captured");

    // What changed is that the reason it was never captured is now printed
    // with it. Read without this, the halt says Synartesis failed to take a
    // reading; what actually happened is that the server never answered.
    expect(plan.halted?.detail).toContain("its answer never arrived");
    expect(plan.halted?.detail).toContain("Request timed out");
    expect(at(plan.steps, seeded.seq).note).toContain("its answer never arrived");
  });

  it("does not tell an outcome-unknown action how it got that way", async () => {
    const live = await session();

    // create_customer declares no pre-read -- the record does not exist until
    // the call returns -- so a timeout here leaves the outcome genuinely
    // unresolved. The row stays pending. That is a timeout, not a dead
    // process, and the halt used to name the wrong one of the two.
    live.arm(true);
    await live.client
      .callTool({ name: "create_customer", arguments: { name: "Zed", email: "z@z.test", plan: "pro" } })
      .catch(() => undefined);
    live.arm(false);
    expect(live.journal.getActions(live.runId)[0]?.status).toBe("pending");

    const plan = await rollback({
      journal: live.journal,
      router: live.router,
      runId: live.runId,
      dryRun: true,
    });
    expect(plan.halted?.reason).toContain("outcome unknown");
    expect(plan.halted?.reason).not.toContain("process died");
    // The cause it does not guess at is the cause the row knows.
    expect(plan.halted?.detail).toContain("Request timed out");
  });
});

/**
 * The renderer, which is the surface the finding was actually about. A note
 * the report does not print is a note nobody reads.
 */
describe("the preview a person sees", () => {
  const FIXTURE = resolve("dist/toy-crm.js");
  const CLI = resolve("dist/cli.js");

  function run(args: readonly string[]): Promise<{ code: number; stdout: string }> {
    return new Promise((done, fail) => {
      const child = spawn("node", [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.on("error", fail);
      child.on("close", (code) => {
        done({ code: code ?? 0, stdout });
      });
    });
  }

  it("prints the caveat under the step it qualifies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-caveat-"));
    dirs.push(dir);
    const state = join(dir, "crm.json");
    const manifest = join(dir, "synartesis.yaml");
    writeFileSync(
      manifest,
      readFileSync("manifests/toy-crm.yaml", "utf8").replace(
        'args: ["dist/toy-crm.js"]',
        `args: ["${FIXTURE}", "--state", "${state}"]`,
      ),
    );

    // Seeded against the on-disk fixture, because the caveat has to survive
    // into a *reverting* step to be rendered at all -- which needs a captured
    // post-state that still matches the world, and that is the shape the
    // error-answer path above produces. The proxy's half of it is tested up
    // there; this is only whether the report prints what it is handed.
    const journalPath = join(dir, "journal.db");
    const journal = openJournal(journalPath);
    const runId = journal.beginRun("agent");
    const seeded = journal.recordPending({
      runId,
      server: "crm",
      tool: "update_customer",
      args: { id: "c_001", plan: "enterprise" },
      class: "reversible",
    });
    const before = {
      id: "c_001",
      name: "Ada Lovelace",
      email: "ada@example.com",
      plan: "pro",
      notes: "founding customer",
    };
    journal.markApplied(seeded.actionId, {
      result: undefined,
      inverse: { server: "crm", tool: "update_customer", args: before },
      verify: { server: "crm", tool: "get_customer", args: { id: "c_001" } },
      // The world has not been touched, so the post-state is what the fixture
      // starts with: the drift check passes and the step is a plain revert.
      postSnapshot: { present: true, value: before },
      warning:
        "the upstream answered with an error and the change was established by reading the " +
        "resource back, so nothing confirmed it: Request timed out",
    });
    journal.close();

    const dry = await run(["undo", runId, "--dry-run", "--manifest", manifest, "--journal", journalPath]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("revert");
    expect(dry.stdout).toContain("caveat");
    // Run together first: the caveat is wrapped to the column the rest of the
    // report uses, so asserting a phrase against the raw output would be
    // asserting where the line breaks fall rather than what it says.
    const said = dry.stdout.replace(/\s+/g, " ");
    expect(said).toContain("so nothing confirmed it: Request timed out");
  }, 30000);
});
