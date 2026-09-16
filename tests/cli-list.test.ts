/**
 * The column the session list exists for.
 *
 * Three sessions a second apart -- one that wrote a file, one that read one,
 * one that did nothing -- printed as three identical rows distinguished only
 * by a uuid. So the command you run to find the session you want told you
 * nothing about which session you want, and the only way through was to `show`
 * each one in turn.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

import { asInstalled } from "./helpers/installed.js";
import { openJournal } from "../src/journal/journal.js";

const CLI = resolve("dist/cli.js");
const POLICY = resolve("manifests/toy-crm.yaml");

/** Only the corner of the fixture's state this file edits. */
const storeShape = z.looseObject({
  customers: z.record(z.string(), z.looseObject({ notes: z.string() })),
});

/** What --json promises to scripts, which this must not have changed. */
const listShape = z.array(z.object({ id: z.string(), actions: z.number() }));
const countShape = z.array(z.object({ id: z.string(), actionCount: z.number() }));
const shownShape = z.object({ actionCount: z.number(), actions: z.array(z.unknown()) });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-list-"));
  dirs.push(dir);
  return dir;
}

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], stdin?: string): Promise<Ran> {
  return new Promise<Ran>((done, fail) => {
    const child = spawn("node", [CLI, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...asInstalled(dirs), NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", fail);
    child.on("close", (code) => {
      done({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

const HELLO = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"agent","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
].join("\n");

function call(id: number, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

async function session(journal: string, ...calls: readonly string[]): Promise<void> {
  await run(["proxy", "--manifest", POLICY, "--journal", journal], `${HELLO}\n${calls.join("\n")}\n`);
}

/** The table rows, which begin with a short id at a known indent. */
function rows(stdout: string): readonly string[] {
  return stdout.split("\n").filter((line) => /^ {2}[0-9a-f]{8}\b/.test(line));
}

describe("telling one session from another", () => {
  it("names what each one touched", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "one" }));
    await session(journal, call(2, "get_customer", { id: "c_002" }));
    await session(journal, call(2, "update_customer", { id: "c_003", notes: "three" }));

    const listed = await run(["list", "--journal", journal]);
    const table = rows(listed.stdout);
    expect(table).toHaveLength(3);

    // Newest first. The two writes name their record; the read says so.
    expect(table[0]).toContain("update_customer c_003");
    expect(table[1]).toContain("read only");
    expect(table[2]).toContain("update_customer c_001");

    // And every row is distinguishable by something other than its id, which
    // is the whole point.
    const withoutIds = table.map((line) => line.slice(10));
    expect(new Set(withoutIds).size).toBe(3);
  });

  it("says where each one stands, not just what it did", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "one" }));
    const undone = await run(["undo", "--manifest", POLICY, "--journal", journal]);
    expect(undone.code).toBe(0);
    // Held, because send_email is irreversible.
    await session(journal, call(2, "send_email", { to: "a@b.c", subject: "s", body: "b" }));

    const table = rows((await run(["list", "--journal", journal])).stdout);
    expect(table[0]).toContain("waiting for you");
    // A run that has been undone and one that has not looked identical before,
    // and which of the two it is happens to be the question this is asked for.
    expect(table[1]).toContain("undone");
  });

  it("keeps the columns aligned however long the state is", async () => {
    // A manifest of its own, pointing the fixture at a file, so the record can
    // be changed by a hand that is not a journalled session -- which is what
    // makes an undo halt, and a halt is what produces the longest state string
    // there is: "changed since; not safe to undo", at thirty-one characters.
    // Two proxy sessions would not do it: undoing the newest leaves the record
    // exactly as that session left it, so nothing has drifted and the state
    // stays short -- which is how this test first passed while padding alone
    // was still breaking the table.
    const dir = workspace();
    const journal = join(dir, "j.db");
    const state = join(dir, "crm.json");
    const manifest = join(dir, "synartesis.yaml");
    writeFileSync(
      manifest,
      readFileSync(POLICY, "utf8").replace(
        'args: ["dist/toy-crm.js"]',
        `args: ["${resolve("dist/toy-crm.js")}", "--state", "${state}"]`,
      ),
    );

    await run(
      ["proxy", "--manifest", manifest, "--journal", journal],
      `${HELLO}\n${call(2, "update_customer", { id: "c_001", notes: "by the agent" })}\n`,
    );
    const held = storeShape.parse(JSON.parse(readFileSync(state, "utf8")));
    const record = held.customers["c_001"];
    if (record === undefined) {
      throw new Error("the fixture no longer has c_001");
    }
    record.notes = "by a person";
    writeFileSync(state, JSON.stringify(held));
    await run(["undo", "--manifest", manifest, "--journal", journal]);

    const listed = await run(["list", "--journal", journal]);
    const table = rows(listed.stdout);
    // Only meaningful if the long state is actually on screen.
    expect(listed.stdout).toContain("changed since");

    const header = listed.stdout
      .split("\n")
      .find((line) => line.includes("session") && line.includes("state"));
    expect(header).toBeDefined();

    // Every row's agent column starts where the header's does. Padding alone
    // cannot promise this: one value longer than its column pushed every
    // column after it out of line.
    const at = (header ?? "").indexOf("agent");
    for (const line of table) {
      expect(line.slice(at - 2, at), line).toBe("  ");
    }
  });

  it("marks a run that is still open", async () => {
    const dir = workspace();
    const journal = join(dir, "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "one" }));

    // Seeded directly: a run is left active by a proxy that was killed rather
    // than disconnected, which is not a thing to arrange reliably from here.
    const open = openJournal(journal);
    const runId = open.beginRun("agent");
    const pending = open.recordPending({
      runId,
      server: "crm",
      tool: "update_customer",
      args: { id: "c_002" },
      class: "reversible",
    });
    open.markApplied(pending.actionId, {
      result: {},
      inverse: { server: "crm", tool: "update_customer", args: { id: "c_002" } },
    });
    open.close();

    const table = rows((await run(["list", "--journal", journal])).stdout);
    // `complete` was dropped as a column because it is true of nearly every
    // line. `active` is not: it is a proxy still working or one that was
    // killed, and it is the whole reason `close` exists. Losing it along with
    // the column it shared would have been a real loss inside a tidier table.
    expect(table[0]).toContain("still open");
    expect(table[1]).not.toContain("still open");
  });

  it("widens the id only as far as it has to", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "one" }));

    const listed = await run(["list", "--journal", journal]);
    // Eight is what every other view prints and what a person copies. Thirty-
    // six characters of hex on every line, against the chance of a collision,
    // is what this replaced.
    expect(rows(listed.stdout)).toHaveLength(1);
    expect(listed.stdout).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("leaves --json exactly as scripts already read it", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "one" }));

    const said = await run(["list", "--json", "--journal", journal]);
    const parsed = listShape.parse(JSON.parse(said.stdout));
    expect(parsed).toHaveLength(1);
    // Full length, still: a script matching on an id must keep working.
    expect(parsed[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(parsed[0]?.actions).toBe(1);
  });

  it("offers one name that means the same thing here and in show", async () => {
    // `actions` is a count here and the array of actions in `show --json`.
    // That cannot be renamed -- the shape above is a promise -- so the
    // unambiguous name is added beside it, in both commands.
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "one" }));

    const listed = countShape.parse(JSON.parse((await run(["list", "--json", "--journal", journal])).stdout));
    const id = listed[0]?.id ?? "";
    expect(listed[0]?.actionCount).toBe(1);

    const shown = shownShape.parse(
      JSON.parse((await run(["show", id, "--json", "--journal", journal])).stdout),
    );
    expect(shown.actionCount).toBe(1);
    expect(shown.actionCount).toBe(shown.actions.length);
  });
});
