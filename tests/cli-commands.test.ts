import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import { openJournal } from "../src/journal/journal.js";

/**
 * The commands people type when something has gone wrong, each in the state
 * that made it do the wrong thing.
 */

const CLI = resolve("dist/cli.js");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function space(): { dir: string; journal: string; manifest: string } {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-commands-"));
  dirs.push(dir);
  const manifest = join(dir, "synartesis.yaml");
  writeFileSync(
    manifest,
    'version: 1\nservers:\n  crm:\n    command: node\n    args: ["dist/toy-crm.js"]\ntools:\n  - match: "crm.send_email"\n    class: irreversible\n',
  );
  return { dir, journal: join(dir, "journal.db"), manifest };
}

function cli(args: readonly string[], dir: string): { code: number | null; stdout: string; stderr: string } {
  const ran = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, SYNARTESIS_HOME: dir, SYNARTESIS_NO_HINTS: "1", SYNARTESIS_NOTIFY: "0" },
  });
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

/** A pid certainly not running: a process that has already exited. */
function deadPid(): number {
  return Number(spawnSync("node", ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
}

function ownedBy(journal: string, runId: string, pid: number): void {
  const db = new Database(journal);
  db.prepare("UPDATE run_owners SET pid = ? WHERE run_id = ?").run(pid, runId);
  db.close();
}

describe("undo, on a session still open with nothing in it to undo", () => {
  it("leaves it open, rather than marking a running session ended", () => {
    const where = space();
    const journal = openJournal(where.journal);
    const runId = journal.beginRun("reading");
    const read = journal.recordPending({ runId, server: "crm", tool: "get_customer", args: {}, class: "readonly" });
    journal.markApplied(read.actionId, { result: {} });
    journal.close();

    const ran = cli(["undo", runId.slice(0, 8), "--yes", "--journal", where.journal, "--manifest", where.manifest], where.dir);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("left as it is");
    const after = openJournal(where.journal);
    expect(after.getRun(runId)?.status).toBe("active");
    after.close();
  });
});

describe("taking back a denial with the short id the deny printed", () => {
  it("finds the call by its prefix", () => {
    const where = space();
    const journal = openJournal(where.journal);
    const runId = journal.beginRun("agent");
    const held = journal.recordPending({ runId, server: "crm", tool: "send_email", args: { to: "a" }, class: "irreversible" });
    journal.markGated(held.actionId);
    journal.close();

    expect(cli(["deny", held.actionId.slice(0, 8), "--unattended", "--journal", where.journal], where.dir).code).toBe(0);
    const back = cli(["approve", held.actionId.slice(0, 8), "--unattended", "--journal", where.journal], where.dir);
    expect(back.code).toBe(0);
    expect(back.stdout).toContain("was denied");
  });

  it("will not take both a call and --all", () => {
    const where = space();
    const journal = openJournal(where.journal);
    const runId = journal.beginRun("agent");
    const held = journal.recordPending({ runId, server: "crm", tool: "send_email", args: {}, class: "irreversible" });
    journal.markGated(held.actionId);
    journal.close();
    const both = cli(["approve", held.actionId.slice(0, 8), "--all", "--unattended", "--journal", where.journal], where.dir);
    expect(both.code).toBe(2);
    const after = openJournal(where.journal);
    expect(after.getAction(held.actionId)?.status).toBe("gated");
    after.close();
  });
});

describe("prune, given an empty number of days", () => {
  it("refuses, rather than reading it as 0 and pruning everything", () => {
    const where = space();
    const journal = openJournal(where.journal);
    const runId = journal.beginRun("old");
    journal.endRun(runId, "complete");
    journal.releaseRun(runId);
    journal.close();
    for (const days of ["", " ", "ten"]) {
      const ran = cli(["prune", "--older-than", days, "--journal", where.journal], where.dir);
      expect(ran.code, JSON.stringify(days)).toBe(2);
    }
    const after = openJournal(where.journal);
    expect(after.getRun(runId)).toBeDefined();
    after.close();
  });
});

describe("flags", () => {
  it("leaves the server's own flags to the server", () => {
    const where = space();
    const ran = cli(["init", "other", "--manifest", where.manifest, "--", "node", "dist/toy-crm.js", "-v"], where.dir);
    expect(ran.stdout.trim()).not.toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("refuses one the command would ignore, before it changes anything", () => {
    const where = space();
    const ran = cli(["uninstall", "--dry-run"], where.dir);
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain("--dry-run does nothing for uninstall");
  });
});

describe("resolve, on a call that may still be on its way", () => {
  it("refuses while the session's app is running and the call has not come back", () => {
    const where = space();
    const journal = openJournal(where.journal);
    const runId = journal.beginRun("live");
    const sending = journal.recordPending({ runId, server: "crm", tool: "send_email", args: {}, class: "irreversible" });
    journal.close();

    const refused = cli(["resolve", "--applied", "--journal", where.journal], where.dir);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("may still be on its way");

    // Its app gone, the same call can be settled.
    ownedBy(where.journal, runId, deadPid());
    const settled = cli(["resolve", "--failed", "--journal", where.journal], where.dir);
    expect(settled.code).toBe(0);
    const after = openJournal(where.journal);
    expect(after.getAction(sending.actionId)?.status).toBe("failed");
    after.close();
  });
});

describe("close, with several sessions open", () => {
  it("asks which", () => {
    const where = space();
    const journal = openJournal(where.journal);
    journal.beginRun("a");
    journal.beginRun("b");
    journal.close();
    expect(cli(["close", "--journal", where.journal], where.dir).code).toBe(2);
  });
});

describe("allow, before any agent has run", () => {
  it("allows for a while without needing a journal to exist first", () => {
    const where = space();
    const ran = cli(
      ["allow", "crm.send_email", "--for", "30m", "--unattended", "--manifest", where.manifest, "--journal", where.journal],
      where.dir,
    );
    expect(ran.code).toBe(0);
    expect(existsSync(where.journal)).toBe(true);
  });

  it("says so when no rule names the tool, since a typo lets nothing through", () => {
    const where = space();
    const ran = cli(
      ["allow", "crm.send_emial", "--for", "30m", "--unattended", "--manifest", where.manifest, "--journal", where.journal],
      where.dir,
    );
    expect(ran.stderr).toContain("no rule in");
  });

  it("lists nothing allowed, rather than an error, when there is no journal", () => {
    const where = space();
    const ran = cli(["allow", "--journal", where.journal], where.dir);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("Nothing is being let through");
  });
});
