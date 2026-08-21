import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "./helpers/harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

async function classOf(active: Harness, name: string, args: Record<string, unknown>) {
  await active.proxied.callTool({ name, arguments: args }).catch(() => undefined);
  const runId = active.journal.listRuns()[0]?.id ?? "";
  const actions = active.journal.getActions(runId);
  return actions[actions.length - 1]?.class;
}

describe("classification", () => {
  it("classifies every fixture tool from the manifest", async () => {
    harness = await createHarness();
    expect(await classOf(harness, "get_customer", { id: "c_001" })).toBe("readonly");
    expect(await classOf(harness, "update_customer", { id: "c_001", plan: "free" })).toBe(
      "reversible",
    );
    expect(await classOf(harness, "delete_customer", { id: "c_003" })).toBe("reversible");
    expect(
      await classOf(harness, "create_customer", { name: "N", email: "n@example.com" }),
    ).toBe("compensable");
    expect(await classOf(harness, "send_email", { to: "a@b.c", subject: "s", body: "b" })).toBe(
      "irreversible",
    );
  });

  it("classifies an unmatched tool as irreversible", async () => {
    harness = await createHarness();
    // restore_customer is in the manifest; a tool that is not gets the
    // fail-closed policy from D4.
    expect(await classOf(harness, "no_such_tool", {})).toBe("irreversible");
  });

  it("records the class even when the call fails", async () => {
    harness = await createHarness();
    expect(await classOf(harness, "get_customer", { id: "c_nope" })).toBe("readonly");
  });
});
