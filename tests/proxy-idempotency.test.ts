import { afterEach, describe, expect, it } from "vitest";

import { IDEMPOTENCY_META_KEY } from "../src/idempotency.js";
import { createHarness, type Harness } from "./helpers/harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

interface Seen {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * Records what the upstream was actually asked, which is the only place the
 * key can be observed: it is added on the way out, so the journal cannot prove
 * it was sent and neither can the reply.
 */
function watch(active: Harness): Seen[] {
  const seen: Seen[] = [];
  const client = active.upstream.client;
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
  const original: any = (client as any).request.bind(client);
  (client as any).request = (request: any, schema: any, options?: any): unknown => {
    if (typeof request?.method === "string") {
      seen.push({ method: request.method, params: { ...request.params } });
    }
    return original(request, schema, options);
  };
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
  return seen;
}

function calls(seen: readonly Seen[]): readonly Record<string, unknown>[] {
  return seen.filter((entry) => entry.method === "tools/call").map((entry) => entry.params);
}

function keyOf(params: Record<string, unknown>): unknown {
  const meta = params["_meta"];
  return typeof meta === "object" && meta !== null
    ? Object.fromEntries(Object.entries(meta))[IDEMPOTENCY_META_KEY]
    : undefined;
}

describe("forward-call idempotency", () => {
  it("presents a key on the forward call, not just the inverse", async () => {
    harness = await createHarness();
    const seen = watch(harness);

    await harness.proxied.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free" },
    });

    const write = calls(seen).find((params) => params["name"] === "update_customer");
    expect(write).toBeDefined();
    expect(keyOf(write ?? {})).toBeTypeOf("string");
  });

  it("presents the key the journal recorded for that action", async () => {
    harness = await createHarness();
    const seen = watch(harness);

    await harness.proxied.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "pro" },
    });

    const runId = harness.journal.listRuns()[0]?.id ?? "";
    const action = harness.journal
      .getActions(runId)
      .find((row) => row.tool === "update_customer");
    const write = calls(seen).find((params) => params["name"] === "update_customer");

    // Same key on the wire as in the row. A key that did not match its action
    // would be worse than none: undo reasons about the row.
    expect(action?.idempotencyKey).toBeTypeOf("string");
    expect(keyOf(write ?? {})).toBe(action?.idempotencyKey);
  });

  it("gives each action its own key", async () => {
    harness = await createHarness();
    const seen = watch(harness);

    // Two identical writes are two intentions, not a retry of one. Sharing a
    // key would invite a server to discard the second, and the journal has
    // two rows expecting two effects.
    await harness.proxied.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free" },
    });
    await harness.proxied.callTool({
      name: "update_customer",
      arguments: { id: "c_001", plan: "free" },
    });

    const keys = calls(seen)
      .filter((params) => params["name"] === "update_customer")
      .map(keyOf);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("keeps the client's own _meta entries", async () => {
    harness = await createHarness();
    const seen = watch(harness);

    await harness.proxied.callTool({
      name: "get_customer",
      arguments: { id: "c_001" },
      _meta: { progressToken: "tok-1" },
    });

    const read = calls(seen).find((params) => params["name"] === "get_customer");
    const meta = read?.["_meta"];
    expect(meta).toMatchObject({ progressToken: "tok-1" });
    expect(keyOf(read ?? {})).toBeTypeOf("string");
  });

  it("presents the same key when a held call is retried", async () => {
    harness = await createHarness({ gate: "retry" });

    const send = {
      name: "send_email",
      arguments: { to: "a@b.c", subject: "s", body: "b" },
    };
    // Refused twice by the retry gate: neither reaches the upstream, but both
    // land on one journal row, so the key a later approval spends is stable.
    await harness.proxied.callTool(send).catch(() => undefined);
    await harness.proxied.callTool(send).catch(() => undefined);

    const runId = harness.journal.listRuns()[0]?.id ?? "";
    const rows = harness.journal.getActions(runId).filter((row) => row.tool === "send_email");
    expect(rows).toHaveLength(1);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(1);
  });
});
