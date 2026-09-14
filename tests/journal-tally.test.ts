import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal, type Journal } from "../src/journal/journal.js";

const dirs: string[] = [];
let journal: Journal | undefined;

afterEach(() => {
  journal?.close();
  journal = undefined;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function open(): Journal {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-tally-"));
  dirs.push(dir);
  journal = openJournal(join(dir, "j.db"));
  return journal;
}

function record(j: Journal, runId: string, tool: string): string {
  return j.recordPending({ runId, server: "fs", tool, args: { n: tool }, class: "reversible" })
    .actionId;
}

describe("counting a run without reading it", () => {
  it("agrees with counting the rows", () => {
    const j = open();
    const a = j.beginRun("one");
    const b = j.beginRun("two");

    j.markApplied(record(j, a, "t1"), { result: {} });
    j.markApplied(record(j, a, "t2"), { result: {} });
    j.markGated(record(j, a, "t3"));
    record(j, a, "t4"); // left pending: a call whose outcome is unknown
    j.markApplied(record(j, b, "t5"), { result: {} });

    const tally = j.tallyRuns();
    expect(tally.get(a)).toEqual({ actions: 4, unknown: 1, waiting: 1, applied: 2 });
    expect(tally.get(b)).toEqual({ actions: 1, unknown: 0, waiting: 0, applied: 1 });

    // The same numbers the slow way, which is what this replaced.
    for (const run of [a, b]) {
      const rows = j.getActions(run);
      const counted = tally.get(run);
      expect(counted?.actions).toBe(rows.length);
      expect(counted?.applied).toBe(rows.filter((r) => r.status === "applied").length);
      expect(counted?.waiting).toBe(rows.filter((r) => r.status === "gated").length);
      expect(counted?.unknown).toBe(rows.filter((r) => r.status === "pending").length);
    }
  });

  it("omits a run that has recorded nothing, rather than inventing zeroes", () => {
    const j = open();
    const empty = j.beginRun("quiet");
    // A client that connects and calls nothing still opens a run; group-by has
    // no group for it, and the caller supplies the zeroes.
    expect(j.tallyRuns().has(empty)).toBe(false);
  });

  it("is empty on an empty journal", () => {
    expect(open().tallyRuns().size).toBe(0);
  });

  it("counts a rolled-back action as neither applied nor waiting", () => {
    const j = open();
    const run = j.beginRun("r");
    const id = record(j, run, "t");
    j.markApplied(id, { result: {} });
    j.markRolledBack(id);
    expect(j.tallyRuns().get(run)).toEqual({ actions: 1, unknown: 0, waiting: 0, applied: 0 });
  });
});
