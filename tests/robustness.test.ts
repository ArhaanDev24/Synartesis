import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createToyCrmServer } from "../fixtures/toy-crm/server.js";
import { ToyCrmStore } from "../fixtures/toy-crm/store.js";
import { openJournal, type Journal } from "../src/journal/journal.js";
import { loadManifest, parseManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { rollback } from "../src/rollback/rollback.js";
import { createHarness, autoApproveGate, inMemoryUpstream, type Harness } from "./helpers/harness.js";

const cleanups: (() => Promise<void> | void)[] = [];
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const MANIFEST = loadManifest("manifests/toy-crm.yaml");

interface Session {
  readonly client: Client;
  readonly journal: Journal;
  readonly router: Router;
  readonly runId: string;
}

async function session(): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-robust-"));
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

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([proxy.server.connect(serverTransport), client.connect(clientTransport)]);
  const runId = await proxy.ready;
  cleanups.push(async () => {
    await client.close();
  });

  return { client, journal, router, runId };
}

describe("a dry run", () => {
  it("does not write to the journal, even where a real undo would halt", async () => {
    const { client, journal, router, runId } = await session();
    await client.callTool({ name: "create_customer", arguments: { name: "Ada", email: "a@b.c" } });

    // An inverse went out and the process died before the reply: the one state
    // undo cannot resolve without a pre-read to consult.
    const [action] = journal.getActions(runId);
    if (action === undefined) {
      throw new Error("expected an action");
    }
    journal.markUnknownInverse(action.id, "the process died mid-inverse");

    const report = await rollback({ journal, router, runId, dryRun: true });

    expect(report.halted?.seq).toBe(action.seq);
    expect(journal.getAction(action.id)?.status).toBe("rolling_back");
  });
});

describe("an approval", () => {
  it("is found again when the agent re-emits the same arguments in another order", () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-approval-"));
    const journal = openJournal(join(dir, "journal.db"));
    cleanups.push(() => {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const runId = journal.beginRun("test");
    const pending = journal.recordPending({
      runId,
      server: "crm",
      tool: "send_email",
      args: { to: "a@b.c", subject: "hello", body: "hi" },
      class: "irreversible",
    });
    journal.markGated(pending.actionId);
    expect(journal.approve(pending.actionId, "arhaan")).toBe(true);

    // Key order carries no meaning in json, and nothing obliges an agent to
    // serialise the retry exactly as it serialised the first attempt.
    const found = journal.findApproval({
      server: "crm",
      tool: "send_email",
      args: { body: "hi", subject: "hello", to: "a@b.c" },
      notBefore: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(found?.id).toBe(pending.actionId);
  });
});

describe("a held call", () => {
  it("does not open a second request when the agent tries again", async () => {
    harness = await createHarness({ gate: "retry" });
    const email = { to: "a@b.c", subject: "hello", body: "hi" };

    await expect(
      harness.proxied.callTool({ name: "send_email", arguments: email }),
    ).rejects.toThrow(/holding this call for approval/);
    await expect(
      harness.proxied.callTool({ name: "send_email", arguments: email }),
    ).rejects.toThrow(/holding this call for approval/);

    // Two rows for one decision means `approve` refuses to act without an id,
    // and whichever one is approved leaves the other waiting forever.
    expect(harness.journal.listGated()).toHaveLength(1);
  });
});

describe("an unverified revert", () => {
  it("says the post-state is missing rather than blaming a pre-read that exists", async () => {
    const { client, journal, router, runId } = await session();
    await client.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free" },
    });

    const [action] = journal.getActions(runId);
    if (action === undefined) {
      throw new Error("expected an action");
    }
    // The write applied and the post-read did not, which markApplied records by
    // leaving post_snapshot_json null.
    journal.markApplied(action.id, {
      result: action.result,
      inverse: action.inverse,
      verify: action.verify,
      warning: "post-state could not be captured",
    });

    const report = await rollback({ journal, router, runId, dryRun: true });

    const [step] = report.steps;
    expect(step?.kind).toBe("revert");
    expect(step?.verified).toBe(false);
    expect(step?.reason).not.toMatch(/no pre-read declared/);
    expect(step?.reason).toMatch(/post-state/);
  });
});

describe("a call the upstream refuses", () => {
  it("is not recorded as something that happened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-refused-"));
    const journal = openJournal(join(dir, "journal.db"));
    cleanups.push(() => {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    });

    // A tool-level error is a normal result carrying isError, not a thrown
    // protocol error, so nothing on the forward path notices it by accident.
    const server = new McpServer({ name: "orders", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.registerTool(
      "place_order",
      { description: "Place an order.", inputSchema: { id: z.string() } },
      () => ({ content: [{ type: "text", text: "payment declined" }], isError: true }),
    );
    server.registerTool(
      "cancel_order",
      { description: "Cancel an order.", inputSchema: { id: z.string() } },
      () => ({ content: [{ type: "text", text: "cancelled" }] }),
    );

    const upstream = await inMemoryUpstream(server, "orders");
    const proxy = createProxyServer({
      upstreams: [upstream],
      manifest: parseManifest(
        [
          "version: 1",
          "servers:",
          "  orders:",
          "    command: node",
          "    args: []",
          "tools:",
          '  - match: "orders.place_order"',
          "    class: compensable",
          "    inverse:",
          '      tool: "orders.cancel_order"',
          "      args:",
          '        id: "$.id"',
          '  - match: "orders.cancel_order"',
          "    class: irreversible",
          "    gate: never",
        ].join("\n"),
        "manifest.yaml",
      ),
      journal,
      gate: autoApproveGate,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([proxy.server.connect(serverTransport), client.connect(clientTransport)]);
    const runId = await proxy.ready;
    cleanups.push(async () => {
      await client.close();
    });

    const result = await client.callTool({ name: "place_order", arguments: { id: "o_1" } });
    // The agent still has to see the refusal.
    expect(result.isError).toBe(true);

    const [action] = journal.getActions(runId);
    expect(action?.status).toBe("failed");
    // An inverse here would cancel an order that was never placed.
    expect(action?.inverse).toBeUndefined();
  });
});
