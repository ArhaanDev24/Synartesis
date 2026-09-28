import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { DamagedJournalError } from "../src/errors.js";
import { openJournal } from "../src/journal/journal.js";

/**
 * A journal file that cannot be read.
 *
 * A power cut, a full disk, a sync tool: a journal can be damaged by things
 * that have nothing to do with Synartesis. The proxy refused to start on one,
 * and with it every server it covered, so the AI app lost its tools and the
 * only explanation was in its MCP log. Now it sets the file aside -- renamed,
 * never deleted -- and starts a new one. A journal that is merely from another
 * version is intact and must never be treated this way.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-damaged-"));
  dirs.push(dir);
  return dir;
}

describe("a damaged journal", () => {
  it("is set aside, byte for byte, and a new one starts where it was", () => {
    const dir = scratch();
    const path = join(dir, "journal.db");
    // A database header, and nothing after it that makes sense: what an
    // interrupted write or a bad sector leaves of a real journal.
    const garbage = Buffer.concat([Buffer.from("SQLite format 3\u0000", "latin1"), Buffer.from("x".repeat(4000))]);
    writeFileSync(path, garbage);
    let movedTo = "";
    const journal = openJournal(path, { setAsideDamaged: (to) => (movedTo = to) });
    const run = journal.beginRun("after");
    expect(journal.getRun(run)).toBeDefined();
    journal.close();
    expect(movedTo).toContain(".damaged-");
    expect(readFileSync(movedTo)).toEqual(garbage);
  });

  it("is recognised when it was cut off part way, as a full disk leaves it", () => {
    const dir = scratch();
    const path = join(dir, "journal.db");
    const journal = openJournal(path);
    const run = journal.beginRun("before");
    for (let i = 0; i < 400; i += 1) {
      const action = journal.recordPending({ runId: run, server: "fs", tool: "write_file", args: { i, body: "x".repeat(500) }, class: "reversible" });
      journal.markApplied(action.actionId, { result: {} });
    }
    journal.close();
    truncateSync(path, Math.floor(statSync(path).size / 3));
    let movedTo = "";
    const reopened = openJournal(path, { setAsideDamaged: (to) => (movedTo = to) });
    reopened.close();
    expect(movedTo).not.toBe("");
  });

  it("is reported, not moved, by anything that only reads", () => {
    const dir = scratch();
    const path = join(dir, "journal.db");
    writeFileSync(path, Buffer.concat([Buffer.from("SQLite format 3\u0000", "latin1"), Buffer.from("x".repeat(4000))]));
    expect(() => openJournal(path, { mustExist: true })).toThrow(DamagedJournalError);
    expect(() => openJournal(path, { mustExist: true })).toThrow(/mv '/);
    expect(readdirSync(dir)).toEqual(["journal.db"]);
  });

  it("is never a file that was not a database to begin with, which is somebody else's", () => {
    // --journal typed at the wrong path. Renaming it would be moving a
    // person's own file out of the way on a guess.
    const dir = scratch();
    const path = join(dir, "notes.txt");
    writeFileSync(path, "my notes\n".repeat(100));
    let moved = false;
    expect(() => openJournal(path, { setAsideDamaged: () => (moved = true) })).toThrow(/not a Synartesis journal/);
    expect(moved).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("my notes\n".repeat(100));
  });

  it("is never confused with a journal from another version, which is intact", () => {
    const dir = scratch();
    const path = join(dir, "journal.db");
    const db = new Database(path);
    db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY); PRAGMA user_version = 2;");
    db.close();
    let moved = false;
    expect(() => openJournal(path, { setAsideDamaged: () => (moved = true) })).toThrow(/schema version 2/);
    expect(moved).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.includes("damaged"))).toEqual([]);
  });
});
