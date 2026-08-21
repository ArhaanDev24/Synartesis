import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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

  it("refuses a journal that is not there", async () => {
    await expect(capture(join(tmpdir(), "synartesis-nope", "journal.db"))).rejects.toThrow(
      /no journal at/,
    );
  });
});
