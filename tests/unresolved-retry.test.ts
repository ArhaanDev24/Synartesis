/**
 * The retry half of an ambiguous outcome.
 *
 * A write that times out may well have landed. Undo has always refused to step
 * over an action in that state; nothing stopped the agent from simply making
 * the call again, and the idempotency key cannot help -- it is `runId:seq`, so
 * the retry goes out under a different key and no upstream can tell the two
 * attempts were one intention. What is left is the person who can go and look,
 * and this is them being asked before a second side effect exists.
 */
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
import { inMemoryUpstream } from "./helpers/harness.js";
import type { Gate } from "../src/gate/gate.js";

const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every question the gate was asked, so the wording can be read back. */
interface Asked {
  readonly why: string;
}

interface Session {
  readonly client: Client;
  readonly store: ToyCrmStore;
  readonly journal: Journal;
  readonly runId: string;
  readonly asked: Asked[];
  /** Flip to make the upstream answer with a timeout after it has written. */
  arm: (on: boolean) => void;
}

async function session(gate: Gate, asked: Asked[]): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-retry-"));
  dirs.push(dir);
  const journal = openJournal(join(dir, "journal.db"));
  closers.push(() => {
    journal.close();
  });

  let armed = false;
  const store = new ToyCrmStore({
    now: () => "2026-01-01T00:00:00.000Z",
    // Fires once the store has already changed, which is the point: the write
    // landed and the answer did not.
    afterWrite: () => {
      if (armed) {
        throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
      }
    },
  });
  const upstream = await inMemoryUpstream(createToyCrmServer(store), "crm");
  const proxy = createProxyServer({
    upstreams: [upstream],
    manifest: loadManifest("manifests/toy-crm.yaml"),
    journal,
    gate: {
      decide: async (request) => {
        asked.push({ why: request.why });
        return await gate.decide(request);
      },
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retry", version: "0" });
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
  return {
    client, store, journal, runId, asked,
    arm: (on: boolean) => {
      armed = on;
    },
  };
}

const refuse: Gate = {
  decide: async () => await Promise.resolve({ approved: false, awaiting: true, reason: "ask a person" }),
};
const allow: Gate = {
  decide: async () => await Promise.resolve({ approved: true, by: "arhaan", reason: "go ahead" }),
};

/**
 * `create_customer`, deliberately.
 *
 * It is compensable, so it declares no pre-read -- the record does not exist
 * until the call returns. That is what leaves a timeout genuinely unresolved:
 * with a pre-read the proxy re-reads the resource afterwards and can usually
 * prove which way it went, and there is then nothing for this to hold. It is
 * also ungated, so any question asked about it is one this file put there.
 */
const WRITE = { name: "Acme", email: "a@acme.test", plan: "pro" } as const;

function rows(journal: Journal, runId: string): readonly ActionRow[] {
  return journal.getActions(runId);
}

describe("a retry of a call nobody could resolve", () => {
  it("is held, and says why rather than reciting the policy", async () => {
    const asked: Asked[] = [];
    const live = await session(refuse, asked);

    // Nothing is gated on the way in: the first call is an ordinary reversible
    // write, and it is only the timeout that makes anything uncertain.
    live.arm(true);
    await live.client.callTool({ name: "create_customer", arguments: WRITE }).catch(() => undefined);
    const first = rows(live.journal, live.runId);
    expect(first).toHaveLength(1);
    expect(asked).toHaveLength(0);

    // Only meaningful if the first attempt really was left unresolved; a
    // fixture that let the read-back settle it would make this test vacuous.
    expect(first[0]?.status).toBe("pending");

    // The agent, told nothing useful, tries the identical call again.
    const again = await live.client
      .callTool({ name: "create_customer", arguments: WRITE })
      .catch((error: unknown) => error);

    expect(asked).toHaveLength(1);
    expect(asked[0]?.why).toContain("could never be established");
    expect(asked[0]?.why).toContain("action 1");
    expect(asked[0]?.why).toContain("a second time");
    expect(String(again)).toContain("holding this call for approval");
  });

  it("lets an identical call through when nothing is unresolved", async () => {
    const asked: Asked[] = [];
    const live = await session(refuse, asked);

    // Two ordinary writes, both answered. Nothing here is uncertain, so
    // nothing may be held: a hint that fires on every repeat would make the
    // proxy unusable for an agent that writes the same file twice.
    await live.client.callTool({ name: "create_customer", arguments: WRITE });
    await live.client.callTool({ name: "create_customer", arguments: WRITE });
    expect(asked).toHaveLength(0);
    expect(rows(live.journal, live.runId).every((row) => row.status === "applied")).toBe(true);
  });

  it("holds only the call that was unresolved, not a different one", async () => {
    const asked: Asked[] = [];
    const live = await session(refuse, asked);
    live.arm(true);
    await live.client.callTool({ name: "create_customer", arguments: WRITE }).catch(() => undefined);
    live.arm(false);

    // A different customer. The uncertainty is about one call, not about the
    // tool, and stopping everything the tool can do would be a far bigger
    // promise than this makes.
    await live.client.callTool({ name: "create_customer", arguments: { name: "Other", email: "o@other.test", plan: "pro" } });
    expect(asked).toHaveLength(0);
  });

  it("never holds a read, however unresolved the last one was", async () => {
    const asked: Asked[] = [];
    const live = await session(refuse, asked);

    // Seeded straight into the journal rather than produced by a timeout: the
    // fixture's hook only fires on writes, so a test that "timed out" a read
    // proved nothing at all -- removing the guard under test left it passing.
    // This puts the row in the state the guard is about and asks the one
    // question that matters.
    const seeded = live.journal.recordPending({
      runId: live.runId,
      server: "crm",
      tool: "get_customer",
      args: { id: "c_001" },
      class: "readonly",
    });
    live.journal.markUnknown(seeded.actionId, "the answer never arrived");
    expect(live.journal.getAction(seeded.actionId)?.status).toBe("pending");

    // A read that times out is left `pending` like any other: with no pre-read
    // there is nothing to ask the world afterwards. But reading a resource
    // twice costs nothing and changes nothing, and holding one would break the
    // plainest promise this makes -- an agent may look freely, and is asked
    // only before it changes something.
    const again = await live.client.callTool({ name: "get_customer", arguments: { id: "c_001" } });
    expect(asked).toHaveLength(0);
    expect(again.isError ?? false).toBe(false);
  });

  it("holds the write that matches a seeded unresolved attempt", async () => {
    const asked: Asked[] = [];
    const live = await session(refuse, asked);

    // The same seed on the write side, so the pair proves the guard reads the
    // class and not something incidental about which tool it is.
    const seeded = live.journal.recordPending({
      runId: live.runId,
      server: "crm",
      tool: "create_customer",
      args: WRITE,
      class: "compensable",
    });
    live.journal.markUnknown(seeded.actionId, "the answer never arrived");

    const held = await live.client
      .callTool({ name: "create_customer", arguments: WRITE })
      .catch((error: unknown) => error);
    expect(asked).toHaveLength(1);
    expect(String(held)).toContain("holding this call for approval");
  });

  it("goes through once a person says yes, and does not ask for ever", async () => {
    const asked: Asked[] = [];
    const live = await session(allow, asked);
    live.arm(true);
    await live.client.callTool({ name: "create_customer", arguments: WRITE }).catch(() => undefined);
    live.arm(false);

    const done = await live.client.callTool({ name: "create_customer", arguments: WRITE });
    expect(asked).toHaveLength(1);
    expect(done.isError ?? false).toBe(false);
  });

  it("leaves the unresolved attempt unresolved, so undo still stops on it", async () => {
    const asked: Asked[] = [];
    const live = await session(allow, asked);
    live.arm(true);
    await live.client.callTool({ name: "create_customer", arguments: WRITE }).catch(() => undefined);
    live.arm(false);
    await live.client.callTool({ name: "create_customer", arguments: WRITE });

    // Approving the retry is a decision about going forward. It says nothing
    // about what the first attempt did, and must not be recorded as though it
    // did -- undo halting here is the whole point of the state.
    const all = rows(live.journal, live.runId);
    expect(all[0]?.status).toBe("pending");
    expect(all).toHaveLength(2);
    expect(all[1]?.status).toBe("applied");
  });
});
