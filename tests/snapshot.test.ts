import { afterEach, describe, expect, it } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import { toPayload } from "../src/proxy/snapshot.js";
import type { ActionRow } from "../src/journal/journal.js";
import { createHarness, type Harness } from "./helpers/harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

function lastAction(active: Harness): ActionRow {
  const runId = active.journal.listRuns()[0]?.id ?? "";
  const actions = active.journal.getActions(runId);
  const action = actions[actions.length - 1];
  if (action === undefined) {
    throw new Error("no action was journalled");
  }
  return action;
}

describe("payload extraction", () => {
  it("prefers structured content when the server provides it", () => {
    expect(
      toPayload({ structuredContent: { id: "x" }, content: [{ type: "text", text: "ignored" }] }),
    ).toEqual({ id: "x" });
  });

  it("parses json out of a lone text block, which is what most servers return", () => {
    expect(toPayload({ content: [{ type: "text", text: '{"id":"c_001"}' }] })).toEqual({
      id: "c_001",
    });
  });

  it("keeps unparseable text as a string rather than failing", () => {
    expect(toPayload({ content: [{ type: "text", text: "hello" }] })).toBe("hello");
  });

  it("hands back the whole result when there is no single obvious payload", () => {
    const result = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
    expect(toPayload(result)).toEqual(result);
  });
});

describe("snapshotting", () => {
  it("captures the pre-state of a reversible write", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free", notes: "changed" },
    });
    expect(lastAction(harness).snapshot).toEqual({
      id: "c_001",
      name: "Ada Lovelace",
      email: "ada@example.com",
      plan: "pro",
      notes: "founding customer",
    });
  });

  it("resolves the inverse to literal values at capture time", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free", notes: "changed" },
    });
    // D5: nothing is left to be looked up at rollback time, when upstream
    // state may have drifted and the old value may no longer be readable.
    expect(lastAction(harness).inverse).toEqual({
      server: "crm",
      tool: "update_customer",
      args: {
        id: "c_001",
        name: "Ada Lovelace",
        email: "ada@example.com",
        plan: "pro",
        notes: "founding customer",
      },
    });
  });

  it("leaves no unresolved reference anywhere in a stored inverse", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({ name: "update_customer", arguments: { id: "c_002", plan: "free" } });
    await harness.proxied.callTool({ name: "delete_customer", arguments: { id: "c_003" } });
    await harness.proxied.callTool({
      name: "create_customer",
      arguments: { name: "Katherine", email: "kj@example.com" },
    });

    const runId = harness.journal.listRuns()[0]?.id ?? "";
    for (const action of harness.journal.getActions(runId)) {
      expect(JSON.stringify(action.inverse ?? {})).not.toMatch(/"\$[.a-z]/);
    }
  });

  it("builds the inverse of a delete from the record it captured", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({ name: "delete_customer", arguments: { id: "c_002" } });
    expect(lastAction(harness).inverse).toEqual({
      server: "crm",
      tool: "restore_customer",
      args: {
        id: "c_002",
        name: "Grace Hopper",
        email: "grace@example.com",
        plan: "enterprise",
        notes: "renewal in March",
      },
    });
  });

  it("takes the id of a compensable create from the result, not the arguments", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({
      name: "create_customer",
      arguments: { name: "Katherine Johnson", email: "kj@example.com", plan: "pro" },
    });
    const action = lastAction(harness);
    expect(action.snapshot).toBeUndefined();
    expect(action.inverse).toEqual({
      server: "crm",
      tool: "delete_customer",
      args: { id: "c_004" },
    });
  });

  it("captures the post-state so that Phase 4 can detect drift", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free" },
    });
    const action = lastAction(harness);
    expect(action.postSnapshot).toEqual({
      present: true,
      value: {
        id: "c_001",
        name: "Ada Lovelace",
        email: "ada@example.com",
        plan: "free",
        notes: "founding customer",
      },
    });
    // The post-state is the state the write produced, not the state before it.
    expect(action.snapshot).toMatchObject({ plan: "pro" });
    expect(action.error).toBeUndefined();
  });

  it("records absence as the post-state of a delete, not as a failure", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({ name: "delete_customer", arguments: { id: "c_002" } });
    const action = lastAction(harness);
    // Treating this as a failed post-read would make every delete
    // unrollbackable, since Phase 4 refuses to act without a post-state.
    expect(action.postSnapshot).toEqual({ present: false });
    expect(action.error).toBeUndefined();
  });

  it("snapshots the current state on a second write, not the original", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    await harness.proxied.callTool({ name: "update_customer", arguments: { id: "c_001", notes: "second" } });
    // Undo walks backwards, so each step has to restore the state that step
    // replaced, not the state at the start of the run.
    expect(lastAction(harness).snapshot).toMatchObject({ plan: "free", notes: "founding customer" });
  });

  it("records nothing to undo for readonly and irreversible tools", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({ name: "get_customer", arguments: { id: "c_001" } });
    expect(lastAction(harness).snapshot).toBeUndefined();
    expect(lastAction(harness).inverse).toBeUndefined();

    await harness.proxied.callTool({
      name: "send_email",
      arguments: { to: "a@b.c", subject: "s", body: "b" },
    });
    expect(lastAction(harness).inverse).toBeUndefined();
  });

  it("does not journal its own pre-read as an agent action", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } });
    const runId = harness.journal.listRuns()[0]?.id ?? "";
    const actions = harness.journal.getActions(runId);
    // One row for the write. The snapshot read is the proxy's own traffic and
    // would bury the actions an operator actually needs to see.
    expect(actions).toHaveLength(1);
    expect(actions[0]?.tool).toBe("update_customer");
  });
});

/** The snapshot names a server that is not connected, so the read cannot run. */
const UNREACHABLE_SNAPSHOT = `version: 1
servers:
  crm: { command: node, args: [] }
  ghost: { command: node, args: [] }
tools:
  - match: "crm.update_customer"
    class: reversible
    snapshot:
      tool: "ghost.read"
      args: { id: "$.id" }
    inverse:
      tool: "crm.update_customer"
      args: { id: "$.id", plan: "$snapshot.plan" }
`;

/**
 * restore_customer treated as reversible: a pre-read that finds nothing where
 * a write is about to land, followed by a write the server accepts.
 */
const CREATES_WHERE_NOTHING_WAS = `version: 1
servers:
  crm: { command: node, args: [] }
tools:
  - match: "crm.restore_customer"
    class: reversible
    snapshot:
      tool: "crm.get_customer"
      args: { id: "$.id" }
    inverse:
      tool: "crm.delete_customer"
      args: { id: "$.id" }
`;

describe("a failed snapshot blocks the write", () => {
  it("does not forward the write when the pre-read cannot run", async () => {
    harness = await createHarness({ manifest: UNREACHABLE_SNAPSHOT });
    const before = harness.store.__snapshot();

    const thrown = await harness.proxied
      .callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } })
      .catch((error: unknown) => error);

    // A reversible action without a snapshot is silently irreversible, so it
    // must not happen at all.
    expect(thrown).toBeInstanceOf(McpError);
    expect(String(thrown)).toMatch(/snapshot/i);
    expect(harness.store.__snapshot()).toEqual(before);
  });

  it("records the blocked attempt as failed rather than pending", async () => {
    harness = await createHarness({ manifest: UNREACHABLE_SNAPSHOT });
    await harness.proxied
      .callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } })
      .catch(() => undefined);

    const action = lastAction(harness);
    // The call definitively never went out, which is not the same as unknown.
    expect(action.status).toBe("failed");
    expect(action.error).toMatch(/snapshot/i);
    expect(action.snapshot).toBeUndefined();
  });
});

describe("a write with no prior state", () => {
  it("asks instead of refusing, because creating things is not forbidden", async () => {
    harness = await createHarness({ gate: "journal", gateTimeoutMs: 80 });
    const active = harness;
    const before = active.store.__snapshot();

    // There is no c_absent to read, so nothing can be restored afterwards.
    // That makes this call irreversible, and irreversible means ask.
    const thrown = await active.proxied
      .callTool({ name: "update_customer", arguments: { id: "c_absent", plan: "free" } })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(McpError);
    // Not "nothing exists here": all this knows is that the pre-read came back
    // with nothing usable, and it hands over the server's own words for why.
    expect(String(thrown)).toMatch(/nothing was captured to restore/i);
    expect(String(thrown)).toMatch(/the read said/i);
    expect(active.store.__snapshot()).toEqual(before);
    expect(lastAction(active).status).toBe("denied");
  });

  it("records that there was nothing to restore when it is allowed through", async () => {
    // A write that succeeds where the pre-read found nothing. It has to be a
    // call the server will actually carry out: one it refuses did not happen,
    // and would be recorded as a refusal rather than as a change with a
    // reservation attached to it.
    harness = await createHarness({ manifest: CREATES_WHERE_NOTHING_WAS });
    await harness.proxied
      .callTool({
        name: "restore_customer",
        arguments: { id: "c_new", name: "Ada", email: "a@b.c", plan: "free", notes: "" },
      })
      .catch(() => undefined);
    const action = lastAction(harness);
    expect(action.status).toBe("applied");
    expect(action.snapshot).toBeUndefined();
    expect(action.inverse).toBeUndefined();
    expect(action.error).toMatch(/no prior state existed/i);
  });
});
