import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { labelFor, openJournal, type ActionRow, type Journal } from "../src/journal/journal.js";

const dirs: string[] = [];
let journal: Journal | undefined;

afterEach(() => {
  journal?.close();
  journal = undefined;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The shape a real approval-then-retry leaves behind: a row that was gated,
 * approved by a person, and then retired because the approval moved onto the
 * call that actually ran. It is stored as `denied`, which is the trap.
 */
function supersededRow(): { row: ActionRow; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-superseded-"));
  dirs.push(dir);
  const open = openJournal(join(dir, "j.db"));
  journal = open;

  const first = open.beginRun("agent");
  const held = open.recordPending({
    runId: first,
    server: "fs",
    tool: "write_file",
    args: { path: "/tmp/new.txt", content: "brand new" },
    class: "reversible",
  });
  open.markGated(held.actionId, "nothing was captured to restore");
  expect(open.approve(held.actionId, "arhaan")).toBe(true);

  const second = open.beginRun("agent");
  const retry = open.recordPending({
    runId: second,
    server: "fs",
    tool: "write_file",
    args: { path: "/tmp/new.txt", content: "brand new" },
    class: "reversible",
  });
  const granted = open.getAction(held.actionId);
  if (granted === undefined) {
    throw new Error("expected the approved row");
  }
  expect(open.adoptApproval(retry.actionId, granted)).toBe(true);

  const row = open.getAction(held.actionId);
  if (row === undefined) {
    throw new Error("expected the retired row");
  }
  return { row, journal: open };
}

describe("a row whose approval moved to the call that ran", () => {
  it("is stored as denied, which is why every reader must go through labelFor", () => {
    const { row } = supersededRow();
    // The storage detail this whole test exists to guard. If it ever stops
    // being true, the readers below are looking for the wrong thing.
    expect(row.status).toBe("denied");
    expect(row.approvedBy).toBe("arhaan");
  });

  it("is not called a refusal", () => {
    const { row } = supersededRow();
    expect(labelFor(row)).toBe("used");
    expect(labelFor(row)).not.toBe("denied");
  });

  it("keeps saying denied for a call somebody actually refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-refused-"));
    dirs.push(dir);
    const open = openJournal(join(dir, "j.db"));
    journal = open;
    const run = open.beginRun("agent");
    const held = open.recordPending({
      runId: run,
      server: "fs",
      tool: "write_file",
      args: { path: "/tmp/x" },
      class: "reversible",
    });
    open.markGated(held.actionId);
    open.deny(held.actionId, "arhaan", "not today");
    const row = open.getAction(held.actionId);
    if (row === undefined) {
      throw new Error("expected the denied row");
    }
    expect(labelFor(row)).toBe("denied");
  });
});
