import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal, type Journal } from "../src/journal/journal.js";
import { openConsole as runConsole } from "../src/console.js";
import type { RollbackReport } from "../src/rollback/rollback.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly path: string;
  readonly runs: string[];
  readonly gates: string[];
}

/** Two runs, the newer one holding a call for approval. */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-console-"));
  dirs.push(dir);
  const path = join(dir, "journal.db");
  const journal: Journal = openJournal(path);
  const runs: string[] = [];
  const gates: string[] = [];

  const older = journal.beginRun("first-agent");
  runs.push(older);
  const wrote = journal.recordPending({
    runId: older,
    server: "crm",
    tool: "update_customer",
    args: { id: "c_001" },
    class: "reversible",
  });
  journal.markApplied(wrote.actionId, {
    result: {},
    inverse: { server: "crm", tool: "update_customer", args: {} },
  });
  journal.endRun(older, "complete");

  const newer = journal.beginRun("second-agent");
  runs.push(newer);
  const held = journal.recordPending({
    runId: newer,
    server: "crm",
    tool: "send_email",
    args: { to: "a@b.c" },
    class: "irreversible",
  });
  journal.markGated(held.actionId);
  gates.push(held.actionId);

  journal.close();
  return { path, runs, gates };
}

/** One run whose only action stopped because somebody changed the resource. */
function conflicted(): { readonly path: string; readonly runId: string } {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-console-"));
  dirs.push(dir);
  const path = join(dir, "journal.db");
  const journal: Journal = openJournal(path);
  const runId = journal.beginRun("an-agent");
  const wrote = journal.recordPending({
    runId,
    server: "crm",
    tool: "update_customer",
    args: { id: "c_001" },
    class: "reversible",
  });
  journal.markApplied(wrote.actionId, {
    result: {},
    inverse: { server: "crm", tool: "update_customer", args: { id: "c_001" } },
  });
  journal.markUnrecoverable(wrote.actionId, "drift at sequence 1");
  journal.endRun(runId, "partial");
  journal.close();
  return { path, runId };
}

function keyboard(): {
  press: (key: string) => void;
  done: () => void;
  keys: AsyncIterable<string>;
} {
  const queued: string[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  return {
    press(key: string): void {
      queued.push(key);
      wake?.();
    },
    done(): void {
      finished = true;
      wake?.();
    },
    keys: {
      async *[Symbol.asyncIterator](): AsyncIterator<string> {
        for (;;) {
          const next = queued.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (finished) {
            return;
          }
          await new Promise<void>((resolve) => (wake = resolve));
        }
      },
    },
  };
}

interface Driven {
  readonly text: string;
  readonly undone: { runId: string; dryRun: boolean; force: boolean }[];
}

async function drive(path: string, script: readonly string[]): Promise<Driven> {
  const board = keyboard();
  const undone: { runId: string; dryRun: boolean; force: boolean }[] = [];
  let text = "";
  const running = runConsole({
    journalPath: path,
    write: (chunk) => (text += chunk),
    live: true,
    intervalMs: 1,
    decideAs: "arhaan",
    keys: board.keys,
    undo: (runId, dryRun, force): Promise<RollbackReport> => {
      undone.push({ runId, dryRun, force: force ?? false });
      return Promise.resolve({ runId, status: "rolled_back", dryRun, steps: [] });
    },
  });
  for (const key of script) {
    board.press(key);
    await new Promise((resolve) => setTimeout(resolve, 14));
  }
  board.press("q");
  board.done();
  await running;
  return { text, undone };
}

describe("the console", () => {
  it("opens on the runs, newest first, without being asked for a subcommand", async () => {
    const { path } = fixture();
    const { text } = await drive(path, []);
    expect(text).toContain("second-agent");
    expect(text).toContain("first-agent");
    expect(text.indexOf("second-agent")).toBeLessThan(text.indexOf("first-agent"));
  });

  it("opens a run and shows what the agent did in it", async () => {
    const { path } = fixture();
    const { text } = await drive(path, ["\r"]);
    expect(text).toContain("send_email");
  });

  it("goes back out of a run", async () => {
    const { path } = fixture();
    const { text } = await drive(path, ["\r", "\u001b"]);
    expect(text.lastIndexOf("first-agent")).toBeGreaterThan(text.lastIndexOf("crm.send_email"));
  });

  it("shows what is waiting and approves it from there", async () => {
    const { path, gates } = fixture();
    await drive(path, ["g", "a"]);
    const journal = openJournal(path);
    const action = journal.getAction(gates[0] ?? "");
    journal.close();
    expect(action?.status).toBe("approved");
    expect(action?.approvedBy).toBe("arhaan");
  });

  it("undoes the run under the cursor, but only after it is confirmed", async () => {
    const { path, runs } = fixture();
    // Down one first: the newest run here only ever held a call for approval,
    // and there is nothing in it to put back.
    const { undone } = await drive(path, ["j", "u", "y"]);
    expect(undone).toEqual([{ runId: runs[0], dryRun: false, force: false }]);
  });

  it("says so rather than confirming an undo that would revert nothing", async () => {
    const { path, runs } = fixture();
    const { text, undone } = await drive(path, ["u", "y"]);
    expect(undone).toEqual([]);
    expect(text).toContain("nothing in this session can be undone");
    // And points at the one that does have something, by id.
    expect(text).toContain((runs[0] ?? "").slice(0, 8));
  });

  it("prints the command for the session under the cursor", async () => {
    const { path, runs } = fixture();
    const { text } = await drive(path, ["j"]);
    expect(text).toContain(`undo ${(runs[0] ?? "").slice(0, 8)}`);
  });

  it("does not undo when the confirmation is declined", async () => {
    const { path } = fixture();
    const { undone } = await drive(path, ["j", "u", "n"]);
    expect(undone).toEqual([]);
  });

  it("offers a dry run, which needs no confirming because it changes nothing", async () => {
    const { path, runs } = fixture();
    const { undone } = await drive(path, ["j", "p"]);
    expect(undone).toEqual([{ runId: runs[0], dryRun: true, force: false }]);
  });

  it("calls a conflicted session a decision, not nothing to undo", async () => {
    const { path, runId } = conflicted();
    const { text } = await drive(path, []);
    expect(text).toContain("changed since this ran");
    // The way past it, as something to type.
    expect(text).toContain(`undo ${runId.slice(0, 8)} --force`);
    expect(text).not.toContain("nothing to undo in this session");
  });

  it("shows what an undo would write over before it will offer to do it", async () => {
    const { path, runId } = conflicted();
    // One u only looks. Two u and a y is what writes over somebody's change.
    const { undone } = await drive(path, ["u"]);
    expect(undone).toEqual([{ runId, dryRun: true, force: false }]);
  });

  it("writes over a change only after being asked twice and answered", async () => {
    const { path, runId } = conflicted();
    const { text, undone } = await drive(path, ["u", "u", "y"]);
    expect(text).toContain("losing that change");
    expect(undone).toEqual([
      { runId, dryRun: true, force: false },
      { runId, dryRun: false, force: true },
    ]);
  });

  it("prints one still frame and leaves when it is not a terminal", async () => {
    const { path } = fixture();
    let text = "";
    const code = await runConsole({
      journalPath: path,
        write: (chunk) => (text += chunk),
      live: false,
      decideAs: "arhaan",
    });
    expect(code).toBe(0);
    expect(text).toContain("second-agent");
    expect(text).not.toMatch(/\[u\] undo/);
  });
});

describe("the console under a heavy hand", () => {
  it("does not start a second undo while one is still running", async () => {
    const { path } = fixture();
    const board = keyboard();
    const started: string[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));

    const running = runConsole({
      journalPath: path,
      write: () => undefined,
      live: true,
      intervalMs: 1,
      decideAs: "arhaan",
      keys: board.keys,
      undo: async (runId): Promise<RollbackReport> => {
        started.push(runId);
        await held;
        return { runId, status: "rolled_back", dryRun: false, steps: [] };
      },
    });

    // Confirm one, then lean on the keys while it is still in flight. Two
    // rollbacks of the same run at once would send every inverse twice.
    for (const key of ["j", "u", "y", "u", "y", "p"]) {
      board.press(key);
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    board.press("q");
    board.done();
    await running;

    expect(started).toHaveLength(1);
  });

  it("keeps the cursor on something real when the list shrinks under it", async () => {
    const { path, gates } = fixture();
    const board = keyboard();
    const running = runConsole({
      journalPath: path,
      write: () => undefined,
      live: true,
      intervalMs: 1,
      decideAs: "arhaan",
      keys: board.keys,
      undo: (runId): Promise<RollbackReport> =>
        Promise.resolve({ runId, status: "rolled_back", dryRun: false, steps: [] }),
    });
    // Walk the cursor well past the end, then act.
    for (const key of ["g", "j", "j", "j", "j", "a"]) {
      board.press(key);
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    board.press("q");
    board.done();
    await running;

    const journal = openJournal(path);
    const action = journal.getAction(gates[0] ?? "");
    journal.close();
    expect(action?.status).toBe("approved");
  });
});

describe("a journal with more in it than fits", () => {
  function manyRuns(count: number): string {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-many-"));
    dirs.push(dir);
    const path = join(dir, "journal.db");
    const journal = openJournal(path);
    for (let i = 0; i < count; i += 1) {
      const run = journal.beginRun(`agent-${String(i)}`);
      journal.endRun(run, "complete");
    }
    journal.close();
    return path;
  }

  async function frameFor(path: string, script: readonly string[], rows: number): Promise<string> {
    const board = keyboard();
    let text = "";
    const running = runConsole({
      journalPath: path,
      write: (chunk) => (text += chunk),
      live: true,
      intervalMs: 1,
      rows,
      decideAs: "arhaan",
      keys: board.keys,
    });
    for (const key of script) {
      board.press(key);
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    board.press("q");
    board.done();
    await running;
    const frames = text.split("[H");
    return frames[frames.length - 1] ?? "";
  }

  it("fits what it draws into the terminal it was given", async () => {
    const path = manyRuns(40);
    const frame = await frameFor(path, [], 24);
    // A frame taller than the terminal scrolls its own header off, and with it
    // the top of the list, which is where the cursor starts.
    expect(frame.split("\n").length).toBeLessThanOrEqual(24);
  });

  it("keeps the cursor on screen when it is moved past the fold", async () => {
    const path = manyRuns(40);
    const frame = await frameFor(path, Array.from({ length: 25 }, () => "j"), 24);
    expect(frame).toContain("agent-14");
    expect(frame.split("\n").length).toBeLessThanOrEqual(24);
  });

  it("says how many are not being shown", async () => {
    const path = manyRuns(40);
    const frame = await frameFor(path, [], 24);
    expect(frame).toMatch(/more/);
  });
});
