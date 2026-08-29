import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { openJournal, type Journal } from "../src/journal/journal.js";

/**
 * Keeping what was in a file so it can be put back means the journal grows at
 * several times what an agent writes, and deleting rows leaves a SQLite file
 * exactly as large as it was. What follows is the way that space comes back,
 * and the rules about what may never be thrown away to get it.
 */
const dirs: string[] = [];
let open: Journal | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function journalAt(): { journal: Journal; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-prune-"));
  dirs.push(dir);
  const path = join(dir, "journal.db");
  const journal = openJournal(path);
  open = journal;
  return { journal, path };
}

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString();
/** The cutoff prune uses for "older than n days". */
const before = (days: number): string => ago(days);

/**
 * Runs are dated when they happen, so the only way to have an old one is to
 * say so directly. Done through the file rather than the api because no api
 * should offer to backdate history.
 */
function backdate(path: string, runId: string, when: string): void {
  const db = new Database(path);
  db.prepare("UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?").run(when, when, runId);
  db.close();
}

describe("prunableRuns", () => {
  it("offers a run that is old and finished with", () => {
    const { journal, path } = journalAt();
    const runId = journal.beginRun("old");
    const action = journal.recordPending({ runId, server: "s", tool: "t", args: {}, class: "readonly" });
    // Applied, not left pending: a recorded call starts out as an outcome
    // nobody knows yet, and those are never prunable at any age.
    journal.markApplied(action.actionId, { result: { ok: true } });
    journal.endRun(runId, "complete");
    backdate(path, runId, ago(60));

    const stale = journal.prunableRuns(before(30));
    expect(stale.map((run) => run.id)).toEqual([runId]);
    expect(stale[0]?.actions).toBe(1);
  });

  it("leaves a run that is finished but recent", () => {
    const { journal } = journalAt();
    const runId = journal.beginRun("recent");
    journal.endRun(runId, "complete");

    expect(journal.prunableRuns(before(30))).toHaveLength(0);
  });

  it("never offers a run that is still active, however old", () => {
    // Several proxies can share one journal, so an active run is not
    // abandoned; it is one nobody has finished yet.
    const { journal, path } = journalAt();
    const runId = journal.beginRun("still going");
    backdate(path, runId, ago(400));

    expect(journal.prunableRuns(before(30))).toHaveLength(0);
  });

  it("never offers a run holding a call that is waiting on a person", () => {
    const { journal, path } = journalAt();
    const runId = journal.beginRun("held");
    const action = journal.recordPending({
      runId,
      server: "s",
      tool: "send_email",
      args: {},
      class: "irreversible",
    });
    journal.markGated(action.actionId, "this action cannot be undone");
    journal.endRun(runId, "complete");
    backdate(path, runId, ago(400));

    // Age is not an answer to a question nobody answered.
    expect(journal.prunableRuns(before(30))).toHaveLength(0);
  });

  it("never offers a run holding a call whose outcome is unknown", () => {
    const { journal, path } = journalAt();
    const runId = journal.beginRun("in flight");
    const action = journal.recordPending({
      runId,
      server: "s",
      tool: "t",
      args: {},
      class: "reversible",
    });
    journal.markInFlight(action.actionId);
    journal.endRun(runId, "partial");
    backdate(path, runId, ago(400));

    expect(journal.prunableRuns(before(30))).toHaveLength(0);
  });
});

describe("deleteRuns", () => {
  it("takes the actions with the run", () => {
    const { journal, path } = journalAt();
    const doomed = journal.beginRun("old");
    for (let i = 0; i < 3; i += 1) {
      const action = journal.recordPending({
        runId: doomed,
        server: "s",
        tool: `t${String(i)}`,
        args: {},
        class: "readonly",
      });
      journal.markApplied(action.actionId, { result: { ok: true } });
    }
    journal.endRun(doomed, "complete");
    backdate(path, doomed, ago(60));

    const kept = journal.beginRun("recent");
    journal.recordPending({ runId: kept, server: "s", tool: "t", args: {}, class: "readonly" });
    journal.endRun(kept, "complete");

    const removed = journal.deleteRuns([doomed]);
    expect(removed).toEqual({ runs: 1, actions: 3 });
    expect(journal.getRun(doomed)).toBeUndefined();
    expect(journal.getActions(doomed)).toHaveLength(0);

    // And the one that was not old is untouched, timeline and all.
    expect(journal.getRun(kept)?.id).toBe(kept);
    expect(journal.getActions(kept)).toHaveLength(1);
  });

  it("reclaims the space, which deleting alone does not", () => {
    const { journal, path } = journalAt();
    const runId = journal.beginRun("bulky");
    // A snapshot is the whole of what was in a file, so a journal is mostly
    // payload rather than rows.
    const payload = "x".repeat(64 * 1024);
    for (let i = 0; i < 20; i += 1) {
      const action = journal.recordPending({
        runId,
        server: "fs",
        tool: "write_file",
        args: { content: payload },
        class: "reversible",
      });
      journal.attachSnapshot(action.actionId, { content: payload });
      journal.markApplied(action.actionId, { result: { ok: true }, inverse: { content: payload } });
    }
    journal.endRun(runId, "complete");
    backdate(path, runId, ago(60));

    // Checkpoint first: until WAL is folded in, the size on disk says more
    // about the write-ahead log than about the database.
    journal.pragma("wal_checkpoint(TRUNCATE)");
    const before_ = statSync(path).size;
    expect(before_).toBeGreaterThan(1024 * 1024);

    journal.deleteRuns([runId]);
    journal.vacuum();

    expect(statSync(path).size).toBeLessThan(before_ / 2);
  });
});
