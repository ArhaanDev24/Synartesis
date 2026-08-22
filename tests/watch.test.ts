import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal } from "../src/journal/journal.js";
import { watch } from "../src/watch.js";

const CLEAR = "\u001b[2J";
const SHOW_CURSOR = "\u001b[?25h";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function journalWith(build: (journal: ReturnType<typeof openJournal>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-watch-"));
  dirs.push(dir);
  const path = join(dir, "journal.db");
  const journal = openJournal(path);
  build(journal);
  journal.close();
  return path;
}

async function capture(path: string, live = false, maxTicks?: number): Promise<string> {
  let text = "";
  await watch({
    journalPath: path,
    approveWith: "synartesis",
    write: (chunk) => (text += chunk),
    live,
    intervalMs: 1,
    ...(maxTicks === undefined ? {} : { maxTicks }),
  });
  return text;
}

describe("watching the journal", () => {
  it("says plainly when nothing has happened", async () => {
    const path = journalWith(() => undefined);
    expect(await capture(path)).toContain("No agent has done anything");
  });

  it("shows what an agent did, newest last", async () => {
    const path = journalWith((journal) => {
      const run = journal.beginRun("agent");
      for (const tool of ["get_customer", "update_customer"]) {
        const action = journal.recordPending({
          runId: run,
          server: "crm",
          tool,
          args: {},
          class: tool.startsWith("get") ? "readonly" : "reversible",
        });
        journal.markApplied(action.actionId, { result: {} });
      }
    });

    const text = await capture(path);
    expect(text).toContain("crm.get_customer");
    expect(text).toContain("crm.update_customer");
    expect(text.indexOf("get_customer")).toBeLessThan(text.indexOf("update_customer"));
  });

  it("puts anything waiting for a person where it cannot be missed", async () => {
    const path = journalWith((journal) => {
      const run = journal.beginRun("agent");
      const action = journal.recordPending({
        runId: run,
        server: "crm",
        tool: "send_email",
        args: {},
        class: "irreversible",
      });
      journal.markGated(action.actionId);
    });

    const text = await capture(path);
    expect(text).toContain("1 awaiting approval");
    expect(text).toContain("crm.send_email");
    expect(text).toContain("synartesis approve --all");
  });

  it("redraws while live, and puts the cursor back", async () => {
    const path = journalWith(() => undefined);
    const text = await capture(path, true, 3);
    expect(text.split(CLEAR).length - 1).toBe(3);
    expect(text).toContain(SHOW_CURSOR);
  });

  it("prints once into a pipe rather than spraying escape codes", async () => {
    const path = journalWith(() => undefined);
    expect(await capture(path)).not.toContain(CLEAR);
  });

  it("does not create a journal at a path where there is none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-watch-none-"));
    dirs.push(dir);
    const path = join(dir, "journal.db");
    await capture(path);
    // Waiting for one is not the same as conjuring one, which would leave a
    // stray file behind and make "nothing happened" indistinguishable from a
    // real answer everywhere else.
    expect(existsSync(path)).toBe(false);
  });
});

describe("watching before anything has happened", () => {
  it("waits for a journal that is not there yet rather than refusing to start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-watch-empty-"));
    dirs.push(dir);
    const path = join(dir, "journal.db");

    // This is the ordinary way round: you start watching, then you point your
    // agent at the proxy, and the proxy is what creates the journal.
    const text = await capture(path);

    expect(text).toContain(path);
    expect(text).toMatch(/no journal/i);
  });

  it("picks the journal up as soon as the proxy makes one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-watch-appears-"));
    dirs.push(dir);
    const path = join(dir, "journal.db");

    const running = capture(path, true, 40);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const journal = openJournal(path);
    const runId = journal.beginRun("late-agent");
    journal.recordPending({
      runId,
      server: "crm",
      tool: "update_customer",
      args: { id: "c_001" },
      class: "reversible",
    });
    journal.close();

    const text = await running;
    expect(text).toContain("crm.update_customer");
  });
});

/** A key source a test can drive, in place of a raw terminal. */
function keyboard(): { press: (key: string) => void; done: () => void; keys: AsyncIterable<string> } {
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

function gated(count: number): { path: string; ids: string[] } {
  const ids: string[] = [];
  const path = journalWith((journal) => {
    const run = journal.beginRun("agent");
    for (let i = 0; i < count; i += 1) {
      const action = journal.recordPending({
        runId: run,
        server: "memory",
        tool: `delete_thing_${String(i)}`,
        args: { which: i },
        class: "irreversible",
      });
      journal.markGated(action.actionId);
      ids.push(action.actionId);
    }
  });
  return { path, ids };
}

describe("deciding from the watch view", () => {
  it("approves the waiting call when a is pressed", async () => {
    const { path, ids } = gated(1);
    const board = keyboard();
    const running = watch({
      journalPath: path,
      approveWith: "synartesis",
      write: () => undefined,
      live: true,
      intervalMs: 1,
      decideAs: "arhaan",
      keys: board.keys,
    });
    board.press("a");
    await new Promise((resolve) => setTimeout(resolve, 30));
    board.press("q");
    board.done();
    await running;

    const journal = openJournal(path);
    const action = journal.getAction(ids[0] ?? "");
    journal.close();
    expect(action?.status).toBe("approved");
    expect(action?.approvedBy).toBe("arhaan");
  });

  it("denies it when d is pressed", async () => {
    const { path, ids } = gated(1);
    const board = keyboard();
    const running = watch({
      journalPath: path,
      approveWith: "synartesis",
      write: () => undefined,
      live: true,
      intervalMs: 1,
      decideAs: "arhaan",
      keys: board.keys,
    });
    board.press("d");
    await new Promise((resolve) => setTimeout(resolve, 30));
    board.press("q");
    board.done();
    await running;

    const journal = openJournal(path);
    const action = journal.getAction(ids[0] ?? "");
    journal.close();
    expect(action?.status).toBe("denied");
    expect(action?.approvedBy).toBe("arhaan");
  });

  it("acts on the one the cursor is on, not on all of them", async () => {
    const { path, ids } = gated(3);
    const board = keyboard();
    const running = watch({
      journalPath: path,
      approveWith: "synartesis",
      write: () => undefined,
      live: true,
      intervalMs: 1,
      decideAs: "arhaan",
      keys: board.keys,
    });
    board.press("j");
    await new Promise((resolve) => setTimeout(resolve, 20));
    board.press("a");
    await new Promise((resolve) => setTimeout(resolve, 30));
    board.press("q");
    board.done();
    await running;

    const journal = openJournal(path);
    const statuses = ids.map((id) => journal.getAction(id)?.status);
    journal.close();
    // One decision, and the one under the cursor.
    expect(statuses).toEqual(["gated", "approved", "gated"]);
  });

  it("offers the keys only where there is a keyboard to press them on", async () => {
    const { path } = gated(1);
    const piped = await capture(path);
    expect(piped).not.toMatch(/\[a\] approve/i);
  });
});

describe("leaving the watch view", () => {
  it("closes the key source however it stops, not only when q is pressed", async () => {
    const { path } = gated(1);
    let closed = false;
    // A generator's finally is where a real terminal puts its own back: raw
    // mode off, stdin paused. If nothing closes the iterator, that never runs.
    async function* keys(): AsyncIterable<string> {
      try {
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield " ";
        }
      } finally {
        closed = true;
      }
    }

    await watch({
      journalPath: path,
      approveWith: "synartesis",
      write: () => undefined,
      live: true,
      intervalMs: 1,
      // Stops for a reason that is not a keypress, which is what a signal or a
      // client going away looks like.
      maxTicks: 3,
      decideAs: "arhaan",
      keys: keys(),
    });

    expect(closed).toBe(true);
  });

  it("says what has to happen next, because approving does not make the call", async () => {
    const { path } = gated(1);
    const board = keyboard();
    let text = "";
    const running = watch({
      journalPath: path,
      approveWith: "synartesis",
      write: (chunk) => (text += chunk),
      live: true,
      intervalMs: 1,
      decideAs: "arhaan",
      keys: board.keys,
    });
    board.press("a");
    await new Promise((resolve) => setTimeout(resolve, 30));
    board.press("q");
    board.done();
    await running;

    // The agent was refused and is not waiting on anything. Somebody has to
    // ask it again, and a view that says only "approved" does not say so.
    expect(text).toMatch(/try again|retry/i);
  });
});

describe("the confirmation line", () => {
  it("stays up long enough to read wherever in the cycle you pressed", async () => {
    const { path } = gated(1);
    const board = keyboard();
    const frames: string[] = [];
    // Pressed at the exact tick the old code happened to clear on. The point
    // is that a confirmation must last from when it was shown, not until the
    // next fixed boundary, or how long you get to read it is luck.
    const running = watch({
      journalPath: path,
      approveWith: "synartesis",
      write: (chunk) => {
        if (!chunk.startsWith("\u001b[?25")) {
          frames.push(chunk);
          if (frames.length === 23) {
            board.press("a");
          }
        }
      },
      live: true,
      intervalMs: 1,
      maxTicks: 60,
      decideAs: "arhaan",
      keys: board.keys,
    });
    await running;
    board.done();

    const showing = frames.filter((frame) => frame.includes("approved memory.")).length;
    expect(showing).toBeGreaterThan(8);
  });

  it("does not offer keys when there is no keyboard attached", async () => {
    const { path } = gated(1);
    // stdout is a terminal, stdin is not: `synartesis watch < /dev/null`.
    // Offering [a] approve there promises a key that can never be pressed.
    const frames: string[] = [];
    await watch({
      journalPath: path,
      approveWith: "synartesis",
      write: (chunk) => frames.push(chunk),
      live: true,
      intervalMs: 1,
      maxTicks: 2,
      decideAs: "arhaan",
    });
    expect(frames.join("")).not.toMatch(/\[a\] approve/);
  });
});
