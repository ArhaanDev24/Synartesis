import { afterEach, describe, expect, it } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import { shouldGateOnWrite } from "../src/gate/heuristic.js";
import { createHarness, type Harness } from "./helpers/harness.js";
import type { Gate } from "../src/gate/gate.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

const EMAIL = {
  name: "send_email",
  arguments: { to: "ada@example.com", subject: "hello", body: "world" },
};

/** Waits for the action to reach `gated`, so tests never race the suspension. */
async function awaitGate(active: Harness): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const runId = active.journal.listRuns()[0]?.id ?? "";
    const gated = active.journal.getActions(runId).find((a) => a.status === "gated");
    if (gated !== undefined) {
      return gated.id;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("no action reached the gate");
}

describe("the gate", () => {
  it("suspends an irreversible call instead of forwarding it", async () => {
    harness = await createHarness({ gate: "journal" });
    const active = harness;
    const call = active.proxied.callTool(EMAIL).catch((error: unknown) => error);

    const actionId = await awaitGate(active);
    // Suspended, not forwarded: nothing has been sent.
    expect(active.store.__snapshot().outbox).toEqual([]);

    expect(active.journal.approve(actionId, "arhaan")).toBe(true);
    await call;
    expect(active.store.__snapshot().outbox).toHaveLength(1);
  });

  it("records who approved it and when", async () => {
    harness = await createHarness({ gate: "journal" });
    const active = harness;
    const call = active.proxied.callTool(EMAIL).catch(() => undefined);
    const actionId = await awaitGate(active);
    active.journal.approve(actionId, "arhaan");
    await call;

    const action = active.journal.getAction(actionId);
    expect(action?.status).toBe("applied");
    expect(action?.approvedBy).toBe("arhaan");
    expect(action?.approvedAt).toBeTruthy();
  });

  it("returns a clean error the agent can read when denied", async () => {
    harness = await createHarness({ gate: "journal" });
    const active = harness;
    const call = active.proxied.callTool(EMAIL).catch((error: unknown) => error);
    const actionId = await awaitGate(active);
    active.journal.deny(actionId, "arhaan", "we do not email customers automatically");

    const thrown = await call;
    // A clean MCP error, not a crash and not a hang: the agent should be able
    // to say it was blocked and carry on.
    expect(thrown).toBeInstanceOf(McpError);
    expect(String(thrown)).toMatch(/denied/i);
    expect(String(thrown)).toContain("we do not email customers automatically");
    expect(active.store.__snapshot().outbox).toEqual([]);
    expect(active.journal.getAction(actionId)?.status).toBe("denied");
  });

  it("denies when nobody answers in time", async () => {
    harness = await createHarness({ gate: "journal", gateTimeoutMs: 60 });
    const active = harness;
    const thrown = await active.proxied.callTool(EMAIL).catch((error: unknown) => error);

    // Deny by default: silence is not consent.
    expect(thrown).toBeInstanceOf(McpError);
    expect(String(thrown)).toMatch(/no answer|timed out/i);
    expect(active.store.__snapshot().outbox).toEqual([]);
    const runId = active.journal.listRuns()[0]?.id ?? "";
    expect(active.journal.getActions(runId)[0]?.status).toBe("denied");
  });

  it("gates an unmatched tool, because an unknown tool is assumed destructive", async () => {
    harness = await createHarness({ gate: "journal", gateTimeoutMs: 60 });
    const active = harness;
    const thrown = await active.proxied
      .callTool({ name: "wire_money", arguments: { amount: 1000000 } })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(McpError);
    const runId = active.journal.listRuns()[0]?.id ?? "";
    expect(active.journal.getActions(runId)[0]?.status).toBe("denied");
  });

  it("does not gate anything the manifest classifies as safe", async () => {
    harness = await createHarness({ gate: "journal", gateTimeoutMs: 60 });
    const result = await harness.proxied.callTool({
      name: "get_customer",
      arguments: { id: "c_001" },
    });
    expect(result.isError).toBeFalsy();
  });

  it("lets other calls through while one is suspended", async () => {
    harness = await createHarness({ gate: "journal" });
    const active = harness;
    const blocked = active.proxied.callTool(EMAIL).catch(() => undefined);
    const actionId = await awaitGate(active);

    // A gate that stalled the whole session would be unusable: the agent has
    // to be able to keep working, or give up on this action and continue.
    const other = await active.proxied.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free" },
    });
    expect(other.isError).toBeFalsy();
    expect(active.store.__snapshot().customers["c_001"]?.plan).toBe("free");

    active.journal.deny(actionId, "arhaan", "no");
    await blocked;
  });

  it("cannot be approved twice, and cannot be approved after a denial", async () => {
    harness = await createHarness({ gate: "journal" });
    const active = harness;
    const call = active.proxied.callTool(EMAIL).catch(() => undefined);
    const actionId = await awaitGate(active);

    expect(active.journal.approve(actionId, "first")).toBe(true);
    expect(active.journal.approve(actionId, "second")).toBe(false);
    expect(active.journal.deny(actionId, "third", "too late")).toBe(false);
    await call;
    expect(active.journal.getAction(actionId)?.approvedBy).toBe("first");
  });

  it("does not send when an approval lands after the client gave up", async () => {
    // A gate that only answers once the caller has stopped listening. This is
    // the shape of a slow human approving through a second terminal after the
    // client's own tool timeout has already fired.
    const approveAfterAbort: Gate = {
      decide: async (request) => {
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) {
            resolve();
            return;
          }
          request.signal.addEventListener("abort", () => {
            resolve();
          });
        });
        return { approved: true, by: "slow-human" };
      },
    };

    harness = await createHarness({ gate: approveAfterAbort });
    const active = harness;
    const controller = new AbortController();
    const call = active.proxied
      .callTool(EMAIL, undefined, { signal: controller.signal })
      .catch((error: unknown) => error);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await call;

    // Sending here would make the journal and the agent disagree about
    // whether a real email went out.
    expect(active.store.__snapshot().outbox).toEqual([]);
    const runId = active.journal.listRuns()[0]?.id ?? "";
    const settled = active.journal.getActions(runId)[0];
    expect(settled?.status).toBe("denied");
    expect(settled?.error).toMatch(/stopped waiting/i);
  });

  it("settles a gate the client abandoned rather than leaving it waiting", async () => {
    harness = await createHarness({ gate: "journal" });
    const active = harness;
    const controller = new AbortController();
    const call = active.proxied
      .callTool(EMAIL, undefined, { signal: controller.signal })
      .catch(() => undefined);

    await awaitGate(active);
    controller.abort();
    await call;

    // The gate notices on its next poll rather than instantly, so give it one.
    for (let attempt = 0; attempt < 100 && active.journal.listGated().length > 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    // However it resolves, it must not be sent and must not linger.
    expect(active.store.__snapshot().outbox).toEqual([]);
    expect(active.journal.listGated()).toEqual([]);
  });

  it("lists what is waiting so a human can find it", async () => {
    harness = await createHarness({ gate: "journal" });
    const active = harness;
    const call = active.proxied.callTool(EMAIL).catch(() => undefined);
    const actionId = await awaitGate(active);

    const waiting = active.journal.listGated();
    expect(waiting.map((a) => a.id)).toEqual([actionId]);
    expect(waiting[0]?.tool).toBe("send_email");

    active.journal.deny(actionId, "arhaan", "no");
    await call;
    expect(active.journal.listGated()).toEqual([]);
  });
});

describe("the on_write heuristic", () => {
  it("lets plain reads through", () => {
    expect(shouldGateOnWrite({ sql: "SELECT * FROM customers" })).toBe(false);
    expect(shouldGateOnWrite({ sql: "  with recent as (select 1) select * from recent" })).toBe(false);
    expect(shouldGateOnWrite({ sql: "EXPLAIN ANALYZE SELECT 1" })).toBe(false);
  });

  it("gates statements that write", () => {
    expect(shouldGateOnWrite({ sql: "UPDATE customers SET plan = 'free'" })).toBe(true);
    expect(shouldGateOnWrite({ sql: "delete from customers" })).toBe(true);
    expect(shouldGateOnWrite({ sql: "DROP TABLE customers" })).toBe(true);
  });

  it("gates anything it cannot classify", () => {
    // Fail closed (D4): not recognising a statement is not evidence that it is
    // safe, and a silent passthrough on an unknown destructive call is the one
    // outcome worth avoiding most.
    expect(shouldGateOnWrite({ sql: "CALL do_something()" })).toBe(true);
    expect(shouldGateOnWrite({ query: 42 })).toBe(true);
    expect(shouldGateOnWrite({})).toBe(true);
    expect(shouldGateOnWrite({ sql: "SELECT 1; DROP TABLE customers" })).toBe(true);
  });
});
