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
