import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import { openJournal, type Journal } from "../src/journal/journal.js";

/**
 * One command to clear what is finished and keep what is not.
 *
 * A journal that had been used for three weeks listed 126 sessions, 113 with
 * nothing in them, and the ways to clear them each needed a person to know
 * something first. `clean` asks nothing, and must never take away anything a
 * person could still undo or still has to decide.
 */

const CLI = resolve("dist/cli.js");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function journalAt(): { path: string; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-clean-"));
  dirs.push(dir);
  const path = join(dir, "journal.db");
  return { path, journal: openJournal(path) };
}

/** A pid certainly not running: a process that has already exited. */
function deadPid(): number {
  return Number(spawnSync("node", ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
}

function write(journal: Journal, runId: string, withUndo: boolean): string {
  const action = journal.recordPending({ runId, server: "fs", tool: "write_file", args: { path: "/a" }, class: "reversible" });
  journal.markApplied(action.actionId, { result: {}, ...(withUndo ? { inverse: { server: "fs", tool: "write_file", args: {} } } : {}) });
  return action.actionId;
}

function world(): { path: string; ids: Record<string, string> } {
  const { path, journal } = journalAt();
  const ids: Record<string, string> = {};
  const finished = (label: string, body?: (id: string) => void): string => {
    const id = journal.beginRun(label);
    body?.(id);
    journal.endRun(id, "complete");
    return id;
  };
  ids["empty"] = finished("empty");
  ids["read"] = finished("read", (id) => {
    const read = journal.recordPending({ runId: id, server: "fs", tool: "read_file", args: {}, class: "readonly" });
    journal.markApplied(read.actionId, { result: {} });
  });
  ids["undone"] = finished("undone", (id) => {
    const action = write(journal, id, true);
    journal.markRollingBack(action);
    journal.markRolledBack(action);
  });
  ids["undoable"] = finished("undoable", (id) => write(journal, id, true));
  ids["waiting"] = finished("waiting", (id) => {
    const held = journal.recordPending({ runId: id, server: "fs", tool: "move_file", args: {}, class: "irreversible" });
    journal.markGated(held.actionId);
  });
  ids["unknown"] = finished("unknown", (id) => {
    const sent = journal.recordPending({ runId: id, server: "fs", tool: "write_file", args: {}, class: "reversible" });
    journal.markUnknown(sent.actionId, "timed out");
  });
  // Open, and its app is still running: this test process owns it.
  ids["live"] = journal.beginRun("live");
  // Open, and its app has exited.
  ids["abandoned"] = journal.beginRun("abandoned");
  journal.close();
  const db = new Database(path);
  db.prepare("UPDATE run_owners SET pid = ? WHERE run_id = ?").run(deadPid(), ids["abandoned"]);
  db.close();
  return { path, ids };
}

function clean(path: string, ...more: string[]): { code: number | null; stdout: string } {
  const ran = spawnSync("node", [CLI, "clean", "--journal", path, ...more], { encoding: "utf8" });
  return { code: ran.status, stdout: ran.stdout };
}

function remaining(path: string): string[] {
  const journal = openJournal(path);
  try {
    return journal.listRuns().map((run) => run.label ?? "");
  } finally {
    journal.close();
  }
}

describe("synartesis clean", () => {
  it("clears what is finished, and keeps everything still working or still needing a person", () => {
    const { path } = world();
    const ran = clean(path, "--yes");
    expect(ran.code).toBe(0);
    expect(remaining(path).sort()).toEqual(["live", "undoable", "unknown", "waiting"]);
    expect(ran.stdout).toContain("cleared 4 sessions");
    expect(ran.stdout).toContain("closed 1");
  });

  it("changes nothing on a dry run, and says what it would do", () => {
    const { path } = world();
    const ran = clean(path, "--dry-run");
    expect(ran.stdout).toContain("4 finished sessions");
    expect(ran.stdout).toContain("1 session left open");
    expect(ran.stdout).toContain("Nothing was changed");
    expect(remaining(path)).toHaveLength(8);
  });

  it("asks before changing anything, and changes nothing without a terminal to ask at", () => {
    const { path } = world();
    const ran = clean(path);
    expect(ran.code).toBe(1);
    expect(ran.stdout).toContain("add --yes");
    expect(remaining(path)).toHaveLength(8);
  });

  it("says so when there is nothing to clear", () => {
    const { path, journal } = journalAt();
    write(journal, journal.beginRun("keep"), true);
    journal.close();
    expect(clean(path, "--yes").stdout).toContain("Nothing to clear");
  });
});
