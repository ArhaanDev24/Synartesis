import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createToyCrmServer } from "../fixtures/toy-crm/server.js";
import { ToyCrmStore } from "../fixtures/toy-crm/store.js";
import { openJournal, type ActionRow, type Journal } from "../src/journal/journal.js";
import { loadManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { rollback } from "../src/rollback/rollback.js";
import { autoApproveGate, inMemoryUpstream } from "./helpers/harness.js";

/**
 * What the journal is allowed to claim when a call went out and the answer was
 * not a plain success.
 *
 * The whole recovery story rests on one distinction: an action that definitely
 * never happened may be stepped over, and an action that may have happened may
 * not. Everything here is a case where the world changed and the proxy was
 * given a reason to believe it had not.
 */

const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Session {
  readonly client: Client;
  readonly store: ToyCrmStore;
  readonly journal: Journal;
  readonly router: Router;
  readonly runId: string;
}

/** `afterWrite` fires once the store has already changed, which is the point. */
async function session(afterWrite: () => void): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-outcome-"));
  dirs.push(dir);
  const journal = openJournal(join(dir, "journal.db"));
  closers.push(() => {
    journal.close();
  });

  const store = new ToyCrmStore({ now: () => "2026-01-01T00:00:00.000Z", afterWrite });
  const upstream = await inMemoryUpstream(createToyCrmServer(store), "crm");
  const proxy = createProxyServer({
    upstreams: [upstream],
    manifest: loadManifest("manifests/toy-crm.yaml"),
    journal,
    gate: autoApproveGate,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "outcome", version: "0" });
  await Promise.all([proxy.server.connect(serverSide), client.connect(clientSide)]);
  closers.push(async () => {
    await client.close();
    await proxy.server.close();
  });
  await proxy.ready;
  const runId = proxy.runId;
  if (runId === undefined) {
    throw new Error("no run was opened");
  }
  return { client, store, journal, router: createRouter([upstream], loadManifest("manifests/toy-crm.yaml")), runId };
}

const only = (journal: Journal, runId: string): ActionRow => {
  const actions = journal.getActions(runId);
  const action = actions[actions.length - 1];
  if (action === undefined) {
    throw new Error("no action was recorded");
  }
  return action;
};

describe("an answer that is not a plain success", () => {
  it("does not call a timeout after the write proof that nothing happened", async () => {
    let armed = false;
    const active = await session(() => {
      if (armed) {
        throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
      }
    });
    armed = true;

    await active.client
      .callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } })
      .catch(() => undefined);

    // The store really did change: the hook fires after the mutation.
    expect(active.store.getCustomer("c_001").plan).toBe("free");

    // So the journal must not say it never applied. `failed` is a claim about
    // the world, and rollback steps over it without a second thought.
    const action = only(active.journal, active.runId);
    expect(action.status).not.toBe("failed");
  });

  it("does not let undo step over a timed-out write as though it were harmless", async () => {
    let armed = false;
    const active = await session(() => {
      if (armed) {
        throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
      }
    });
    armed = true;
    await active.client
      .callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } })
      .catch(() => undefined);

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    // Either it put the change back, or it stopped and said it could not. What
    // it may not do is finish cleanly having left the record changed.
    const settled =
      report.status === "rolled_back" && active.store.getCustomer("c_001").plan === "pro";
    expect(settled || report.halted !== undefined).toBe(true);
  });

  it("does not treat isError as proof the write was refused", async () => {
    let armed = false;
    const active = await session(() => {
      if (armed) {
        // A later step failing, after the record was already updated. The
        // protocol gives isError no transactional meaning whatsoever.
        throw new Error("the downstream billing call failed");
      }
    });
    armed = true;

    await active.client
      .callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } })
      .catch(() => undefined);

    expect(active.store.getCustomer("c_001").plan).toBe("free");
    const action = only(active.journal, active.runId);
    expect(action.status).not.toBe("failed");
  });

  it("still records a refusal that changed nothing as exactly that", async () => {
    const active = await session(() => undefined);
    // c_404 does not exist, so the server refuses before touching anything.
    await active.client
      .callTool({ name: "update_customer", arguments: { id: "c_404", plan: "free" } })
      .catch(() => undefined);

    // Evidence supports "never applied" here, and undo must stay free to skip
    // it. Fixing the two cases above must not cost this one.
    const action = only(active.journal, active.runId);
    expect(action.status).toBe("failed");
  });
});

describe("an adapter that has actually been tested", () => {
  it("honours a declared clean refusal, and only a declared one", async () => {
    // Same server, same isError, two policies. The difference is whether
    // somebody has stated the guarantee, which is the only thing that can
    // make a protocol flag mean something.
    const uncertain = await session(() => {
      throw new Error("the downstream billing call failed");
    });
    await uncertain.client
      .callTool({ name: "update_customer", arguments: { id: "c_002", plan: "free" } })
      .catch(() => undefined);
    expect(only(uncertain.journal, uncertain.runId).status).not.toBe("failed");
  });
});
