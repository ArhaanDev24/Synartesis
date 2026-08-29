import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal } from "../src/journal/journal.js";

/**
 * The journal holds the previous contents of every file an agent overwrote,
 * because that is what putting one back requires. SQLite would create it at
 * whatever the umask allows, which is world-readable on an ordinary machine.
 *
 * Windows chmod only moves a read-only bit, so the modes are meaningless
 * there; the code still has to not throw, which the rest of the suite covers.
 */
const posix = process.platform !== "win32";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-perm-"));
  dirs.push(dir);
  return dir;
}

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

describe.skipIf(!posix)("what the journal lets other people read", () => {
  it("creates the journal readable only by its owner", () => {
    const path = join(workspace(), "nested", "journal.db");
    const journal = openJournal(path);
    journal.beginRun("agent");
    journal.close();

    expect(mode(path)).toBe("600");
  });

  it("creates the directory it puts the journal in the same way", () => {
    const dir = join(workspace(), "home");
    const journal = openJournal(join(dir, "journal.db"));
    journal.close();

    expect(mode(dir)).toBe("700");
  });

  it("closes a journal that is already open to everyone", () => {
    // The ones that most need this are the journals already on disk, written
    // before anything set a mode. Opening one has to be enough to fix it.
    const path = join(workspace(), "journal.db");
    openJournal(path).close();
    chmodSync(path, 0o644);
    expect(mode(path)).toBe("644");

    openJournal(path, { mustExist: true }).close();
    expect(mode(path)).toBe("600");
  });

  it("does not leave the write-ahead log open either", () => {
    // -wal and -shm hold the same content as the database they belong to, and
    // are created when WAL is switched on rather than when the file is.
    const path = join(workspace(), "journal.db");
    const journal = openJournal(path);
    const runId = journal.beginRun("agent");
    journal.recordPending({ runId, server: "s", tool: "t", args: { a: 1 }, class: "readonly" });

    const wal = `${path}-wal`;
    expect(mode(wal)).toBe("600");
    journal.close();
  });
});
