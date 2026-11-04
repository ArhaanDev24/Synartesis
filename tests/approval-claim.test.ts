import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "./helpers/harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/**
 * Losing the claim on an approval to another proxy.
 *
 * The loser used to take the approved row as its own action even after
 * failing to claim it, so its fresh hold put the winner's call -- already on
 * its way out -- back to `gated`. The person was then asked about an email
 * that had gone, and the row of the call that ran said it was still waiting.
 *
 * Within one process the read and the claim never interleave, so the other
 * proxy is played by the journal: the claim is spent elsewhere the instant
 * this one tries.
 */
describe("losing the claim on an approval", () => {
  it("leaves the winner's row alone and opens a hold of its own", async () => {
    harness = await createHarness({ gate: "retry" });
    const journal = harness.journal;
    const email = { name: "send_email", arguments: { to: "ada@example.com", subject: "s", body: "b" } };
    await harness.proxied.callTool(email).catch(() => undefined);
    const held = journal.listGated()[0]?.id ?? "";
    expect(journal.approve(held, "arhaan")).toBe(true);

    const claim = journal.markInFlight.bind(journal);
    journal.markInFlight = (id: string): boolean => {
      claim(id);
      return false;
    };

    const result = await harness.proxied.callTool(email).then(
      () => "sent",
      (error: unknown) => String(error),
    );

    expect(result).toContain("holding this call");
    expect(harness.store.__snapshot().outbox).toHaveLength(0);
    const runId = journal.listRuns()[0]?.id ?? "";
    const rows = journal.getActions(runId).filter((row) => row.tool === "send_email");
    // The winner's row is in flight, as the winner left it.
    expect(rows.find((row) => row.id === held)?.status).toBe("pending");
    const waiting = rows.filter((row) => row.status === "gated");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.id).not.toBe(held);
  });
});

describe("two identical calls waiting on one approval in a window", () => {
  it("sends one, not both", async () => {
    // The window's gate waits on the row rather than refusing. Two identical
    // calls share one row, and both saw it approved: one yes, two emails.
    harness = await createHarness({ gate: "journal", gateTimeoutMs: 4000 });
    const journal = harness.journal;
    const agent = harness.proxied;
    const email = { name: "send_email", arguments: { to: "ada@example.com", subject: "s", body: "b" } };
    const both = Promise.all([0, 1].map(() => agent.callTool(email).then(() => "sent", () => "refused")));
    for (let i = 0; i < 100 && journal.listGated().length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const held = journal.listGated();
    expect(held).toHaveLength(1);
    expect(journal.approve(held[0]?.id ?? "", "arhaan")).toBe(true);
    const results = await both;

    expect(harness.store.__snapshot().outbox).toHaveLength(1);
    expect(results.sort()).toEqual(["refused", "sent"]);
  });
});
