import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal, type Journal } from "../src/journal/journal.js";

/**
 * What a screen costs to draw on a journal somebody has actually been using.
 *
 * Every other performance test in this repository measures one call through
 * the proxy against a journal a few hundred rows deep, which is the one shape
 * in which none of these problems exist. The console was re-reading and
 * re-parsing every action in every run -- snapshots, results and inverses --
 * eight times a second to render two integers per row, and `recentActions`
 * was scanning the whole table and sorting it in a temporary b-tree to return
 * twelve rows, 120ms apart. Both were invisible to CI for as long as CI only
 * ever looked at a small journal.
 *
 * So the fixture here is deliberately large, and the assertions are budgets
 * rather than comparisons: a number that says "fast enough to draw at 8fps
 * without eating the event loop" keeps meaning the same thing when the
 * machine running it is slower than this one.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The payload is the point: these are the rows a scan has to walk past. */
const SNAPSHOT = { content: "x".repeat(2048) };

const RUNS = 40;
const PER_RUN = 100;

function seeded(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-budget-"));
  dirs.push(dir);
  const path = join(dir, "journal.db");
  const journal: Journal = openJournal(path);
  for (let r = 0; r < RUNS; r += 1) {
    const runId = journal.beginRun(`agent-${String(r)}`);
    for (let a = 0; a < PER_RUN; a += 1) {
      const action = journal.recordPending({
        runId,
        server: "fs",
        tool: "write_file",
        args: { path: `/tmp/f${String(a)}`, content: SNAPSHOT.content },
        class: "reversible",
      });
      journal.attachSnapshot(action.actionId, SNAPSHOT);
      journal.markApplied(action.actionId, {
        result: { ok: true },
        inverse: { server: "fs", tool: "write_file", args: SNAPSHOT },
        postSnapshot: SNAPSHOT,
      });
    }
    journal.endRun(runId, "complete");
  }
  journal.close();
  return path;
}

function millis(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

describe(`drawing a screen over ${String(RUNS * PER_RUN)} actions`, () => {
  it("costs a console frame less than a tenth of its tick", () => {
    const journal = openJournal(seeded(), { mustExist: true });
    try {
      // What runsView does per frame, which is the whole of its query cost.
      journal.tallyRuns();
      journal.standingPerRun();
      const frame = millis(() => {
        journal.listRuns();
        journal.tallyRuns();
        journal.standingPerRun();
      });
      // The tick is 120ms. Anything approaching it blocks the event loop and
      // keypresses queue behind renders, which is what this is here to stop.
      // It was 62ms; it is now comfortably under one.
      expect(frame, `console frame took ${frame.toFixed(2)}ms`).toBeLessThan(12);
    } finally {
      journal.close();
    }
  });

  it("costs a watch frame less than a tenth of its tick", () => {
    const journal = openJournal(seeded(), { mustExist: true });
    try {
      journal.recentActions(12);
      const frame = millis(() => {
        journal.listRuns();
        journal.recentActions(12);
        journal.listGated();
      });
      // recentActions was 7.4ms of this, all of it a scan of every row in the
      // table plus a sort, to return twelve. An index on ts makes it a walk
      // backwards that stops at the limit.
      expect(frame, `watch frame took ${frame.toFixed(2)}ms`).toBeLessThan(12);
    } finally {
      journal.close();
    }
  });

  it("answers what is left in a session without reading the actions", () => {
    const journal = openJournal(seeded(), { mustExist: true });
    try {
      const runId = journal.listRuns()[0]?.id ?? "";

      // The way it was done, kept here as the thing being avoided rather than
      // as a rival implementation: it is the honest baseline, and if the two
      // ever stop agreeing, one of them is wrong.
      const byReading = journal
        .getActions(runId)
        .filter((action) => action.inverse !== undefined && action.status === "applied").length;
      const byIndex = journal.standingPerRun().get(runId)?.undoable ?? 0;
      expect(byIndex).toBe(byReading);
      expect(byIndex).toBe(PER_RUN);

      const reading = millis(() => journal.getActions(runId));
      const indexed = millis(() => journal.standingPerRun());
      // Not a ratio: the point is that one grows with the size of the data
      // the session touched and the other does not.
      expect(
        indexed,
        `index ${indexed.toFixed(2)}ms vs reading one run ${reading.toFixed(2)}ms`,
      ).toBeLessThan(reading);
    } finally {
      journal.close();
    }
  });
});
