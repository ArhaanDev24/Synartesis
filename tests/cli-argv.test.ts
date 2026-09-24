/**
 * Where one word ends and the next begins.
 *
 * Four separate things read the same argv and each had its own idea of it:
 * what belongs to us and what belongs to a wrapped server, which tokens are
 * flags, which are the values of flags, and which are commands. Every bug
 * below came from two of those four disagreeing, and every one of them was
 * invisible until somebody typed a perfectly ordinary thing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { asInstalled } from "./helpers/installed.js";

/** Only the corner of the fixture's state this test edits. */
const storeShape = z.looseObject({
  customers: z.record(z.string(), z.looseObject({ notes: z.string() })),
});

const CLI = resolve("dist/cli.js");
const POLICY = resolve("manifests/toy-crm.yaml");
const CRM = resolve("dist/toy-crm.js");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-argv-"));
  dirs.push(dir);
  return dir;
}

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], stdin?: string, env: Record<string, string> = {}): Promise<Ran> {
  return new Promise<Ran>((done, fail) => {
    const child = spawn("node", [CLI, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      // Spelled `synartesis ...` rather than `node /long/path/cli.js ...`,
      // whatever this machine happens to have installed.
      env: { ...process.env, ...asInstalled(dirs), ...env },
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

describe("everything past a bare --", () => {
  it("belongs to the server being wrapped, flags included", async () => {
    const home = workspace();
    const decoy = join(home, "decoy.yaml");

    // --manifest here is the wrapped server's own flag. It must reach that
    // server and must not also be read as ours: this wrote the policy to the
    // server's path, which is a file somebody never asked for and, on a
    // machine where that path is real, one they already had.
    const made = await run(
      ["init", "crm", "--", "node", CRM, "--manifest", decoy],
      undefined,
      { SYNARTESIS_HOME: home },
    );
    expect(made.code).toBe(0);
    expect(existsSync(decoy)).toBe(false);
    expect(existsSync(join(home, "synartesis.yaml"))).toBe(true);

    // And the flag did reach the server, which is the other half of the
    // promise: it is recorded as one of that server's arguments.
    const written = readFileSync(join(home, "synartesis.yaml"), "utf8");
    expect(written).toContain("--manifest");
    expect(written).toContain(decoy);
  });

  it("does not let a wrapped server's --journal choose ours", async () => {
    const home = workspace();
    const decoy = join(home, "decoy.db");
    const made = await run(
      ["init", "crm", "--", "node", CRM, "--journal", decoy],
      undefined,
      { SYNARTESIS_HOME: home },
    );
    expect(made.code).toBe(0);
    // init writes no journal either way; what matters is that nothing went to
    // a path the server named for its own purposes.
    expect(existsSync(decoy)).toBe(false);
  });
});

describe("the value of a flag is not a flag", () => {
  it("takes a reason that begins with a dash", async () => {
    const dir = workspace();
    const journal = join(dir, "j.db");
    await run(
      ["proxy", "--manifest", POLICY, "--journal", journal],
      `${HELLO}\n${call(2, "send_email", { to: "a@b.c", subject: "s", body: "b" })}\n`,
    );

    // "unknown flag -see ticket 42" is what this used to say, about a value
    // that was never a flag.
    const said = await run(["deny", "--all", "--reason", "-see ticket 42", "--journal", journal]);
    expect(said.code).toBe(0);
    expect(said.stdout).toContain("denied");
  });

  it("gives --older-than its own error rather than calling the number a flag", async () => {
    const dir = workspace();
    const journal = join(dir, "j.db");
    await run(["proxy", "--manifest", POLICY, "--journal", journal], HELLO);

    const said = await run(["prune", "--older-than", "-5", "--journal", journal]);
    expect(said.code).toBe(2);
    // The message that knows what --older-than is for, not the one that does
    // not know what -5 is.
    expect(said.stderr).toContain("--older-than takes a number of days");
    expect(said.stderr).not.toContain("unknown flag");
  });
});

describe("a real flag on the wrong command", () => {
  it("says which command it belongs to", async () => {
    for (const flag of ["--http", "--token", "--server", "--log-level"]) {
      const said = await run(["list", flag, "x"]);
      expect(said.code, flag).toBe(2);
      // These are all in the help page. Answering one with "unknown flag"
      // sends somebody hunting through that page for a flag already in it.
      expect(said.stderr, flag).toContain(`${flag} is a flag for`);
      expect(said.stderr, flag).toContain("proxy");
    }
  });

  it("still calls a word nobody has heard of unknown", async () => {
    const said = await run(["list", "--xyzzy"]);
    expect(said.code).toBe(2);
    expect(said.stderr).toContain("unknown flag --xyzzy");
  });
});

describe("the lists that have to agree", () => {
  it("accepts every flag that is documented as taking a value", async () => {
    // The help page is the contract. Every flag in it that is followed by a
    // placeholder must be accepted, and its value must not be read as a
    // command name or as a flag of its own -- which is the bug this file is
    // mostly about, found three separate times in three separate lists.
    const help = (await run(["--help"])).stdout;
    const documented = [...help.matchAll(/(--[a-z-]+) <[a-z]+>/g)].map((hit) => hit[1] ?? "");
    expect(documented.length).toBeGreaterThan(4);

    const dir = workspace();
    const journal = join(dir, "j.db");
    await run(["proxy", "--manifest", POLICY, "--journal", journal], HELLO);

    for (const flag of new Set(documented)) {
      // Given a value that begins with a dash, since that is the shape that
      // exposed the disagreement. Whatever the command makes of the value, it
      // must not come back as a word nobody has heard of.
      const said = await run(["list", flag, "-x", "--journal", journal]);
      expect(said.stderr, flag).not.toContain("unknown flag -x");
    }
  });
});

describe("a run stopped by drift is not a run that is finished", () => {
  it("does not answer --force with \"it has already been undone\"", async () => {
    // A manifest of its own, pointing the fixture at a file, so the record
    // survives between the write and the edit that conflicts with it.
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
    // Somebody edits the same record by hand, outside the proxy -- which is
    // the case that matters and, being outside, opens no newer session for
    // `undo` to pick instead.
    const held = storeShape.parse(JSON.parse(readFileSync(state, "utf8")));
    const record = held.customers["c_001"];
    if (record === undefined) {
      throw new Error("the fixture no longer has c_001");
    }
    record.notes = "by a person";
    writeFileSync(state, JSON.stringify(held));

    const halted = await run(["undo", "--manifest", manifest, "--journal", journal]);
    expect(halted.stdout).toContain("halted");

    // The three ways on are a menu, and a menu whose columns do not line up
    // is read as three unrelated lines. They were spaced by hand and the
    // middle one sat a character left of the other two.
    const ways = halted.stdout
      .split("\n")
      .filter((line) => / {3}(nothing to do|synartesis undo )/.test(line));
    expect(ways).toHaveLength(3);
    // Where the value starts: the first character with a gap of three or
    // more spaces in front of it. The two-space indent and the labels' own
    // single spaces cannot match it.
    const columns = new Set(ways.map((line) => line.search(/(?<= {3})\S/)));
    expect(columns.size).toBe(1);

    // And the middle one must not read as though the flag does the restoring.
    // --replan rebuilds each inverse from the manifest; the drift check then
    // runs again on a resource nobody has touched, so somebody who typed what
    // this line told them to got the identical halt offering the identical
    // three options, for as long as they cared to keep typing it.
    expect(halted.stdout).not.toContain("put it back as the run left it");
    expect(halted.stdout).toContain("put the resource back, then:");

    // The halt prints `undo <id> --force` as one of the three ways on. Running
    // it counted only `applied` actions, found none, and said the run had
    // already been undone -- about a change still sitting in the record, and
    // refusing the command it had itself just recommended.
    const forced = await run(["undo", "--force", "--manifest", manifest, "--journal", journal]);
    expect(forced.stdout).not.toContain("already been undone");
    expect(forced.stdout).toContain("--force --yes");
  });

  it("still shows the plan when a forced undo is only a dry run", async () => {
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
    const edited = readFileSync(state, "utf8");

    // --dry-run --force asks one question: if I forced this, what would
    // happen? It answered half of it -- the overwrite list -- and returned
    // before the plan, so the flag that exists to show you the plan showed
    // you no plan.
    const dry = await run([
      "undo", "--dry-run", "--force", "--manifest", manifest, "--journal", journal,
    ]);
    expect(dry.stdout).toContain("would write over");
    expect(dry.stdout).toContain("D R Y   R U N");
    expect(dry.stdout).toContain("would put back");
    // And the whole point of the flag.
    expect(readFileSync(state, "utf8")).toBe(edited);
  });
});

describe("undoing down to a floor", () => {
  it("reports success when it did exactly what was asked", async () => {
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
      `${HELLO}\n${call(2, "update_customer", { id: "c_001", notes: "first" })}\n` +
        `${call(3, "update_customer", { id: "c_002", notes: "second" })}\n`,
    );

    // Undo the newest only. Nothing halts, nothing is permanent, and the one
    // action below the floor is left alone because that is what --to means.
    const undone = await run(["undo", "--to", "2", "--manifest", manifest, "--journal", journal]);
    expect(undone.stdout).toContain("left alone");
    // A floor makes the run `partial` by construction -- correctly, the run is
    // not fully reversed -- and the exit code was read straight off that. So a
    // --to undo that did precisely what it was told could not be told apart
    // from one that halted on somebody's edit.
    expect(undone.code).toBe(0);

    const left = storeShape.parse(JSON.parse(readFileSync(state, "utf8")));
    expect(left.customers["c_001"]?.notes).toBe("first");
    expect(left.customers["c_002"]?.notes).not.toBe("second");
  });
});

describe("a client name that is not one", () => {
  it("blames the word, not the machine", async () => {
    // Unvalidated, this filtered every site away and install reported "No MCP
    // client config was found on this machine" -- which is about the machine,
    // when the fault is the word. Uninstall said "Nothing was covered, so
    // nothing was changed", which reads as confirmation.
    const said = await run(["install", "--client", "cursur"]);
    expect(said.code).toBe(2);
    expect(said.stderr).toContain("cursur");
    expect(said.stderr).toContain("did you mean cursor");
    expect(said.stdout).not.toContain("was found on this machine");
  });

  it("refuses it on uninstall too, where the wrong answer reads as reassurance", async () => {
    const said = await run(["uninstall", "--client", "clod-code"]);
    expect(said.code).toBe(2);
    expect(said.stderr).toContain("clod-code");
    expect(said.stdout).not.toContain("nothing was changed");
  });

  it("still takes the four it knows", async () => {
    for (const known of ["claude-code", "claude-desktop", "cursor", "codex"]) {
      const said = await run(["install", "--client", known, "--print"]);
      expect(said.stderr).not.toContain("is not a client this knows");
    }
  });
});

describe("refusing a flag before acting on the session", () => {
  it("says nothing about which session it picked", async () => {
    const dir = workspace();
    const journal = join(dir, "j.db");
    await run(
      ["proxy", "--manifest", POLICY, "--journal", journal],
      `${HELLO}\n${call(2, "update_customer", { id: "c_001", notes: "changed" })}\n`,
    );

    const said = await run(["undo", "--to", "0", "--manifest", POLICY, "--journal", journal]);
    expect(said.code).toBe(2);
    expect(said.stderr).toContain("--to needs a positive whole number");
    // It used to announce "no session named, so the most recent: <id>" first,
    // which reads as though that session had been acted on.
    expect(said.stdout).not.toContain("most recent");
  });

  it("answers a --to past the end of the run without listing the commands", async () => {
    const dir = workspace();
    const journal = join(dir, "j.db");
    await run(
      ["proxy", "--manifest", POLICY, "--journal", journal],
      `${HELLO}\n${call(2, "update_customer", { id: "c_001", notes: "changed" })}\n`,
    );

    const said = await run(["undo", "--to", "99", "--manifest", POLICY, "--journal", journal]);
    expect(said.code).toBe(2);
    expect(said.stderr).toContain("past the end of this run, which goes up to 1");
    // The bound in that sentence was read off the run, so it is a fact about
    // the journal, and `install`, `watch` and the rest answer none of it.
    expect(said.stderr).not.toContain("synartesis install");
    expect(said.stderr.split("\n").filter((line) => line.trim() !== "")).toHaveLength(1);
  });
});

describe("undo with no session named", () => {
  it("reaches past an empty session a client left open to the one that did something", async () => {
    // Clients open a session every time they start, whether or not anything
    // is called, and the real journal this was found in had 107 empty
    // sessions out of 114. The newest was usually empty and still open, so
    // 0.8.5's guard against undoing a live session refused -- about a session
    // with nothing in it -- and --yes then printed "Nothing was recorded in
    // it".
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
    const worked = readFileSync(state, "utf8");

    // The client restarted: a new session, nothing in it, not ended.
    const open = await import("../src/journal/journal.js");
    const j = open.openJournal(journal, { mustExist: true });
    const empty = j.beginRun("claude-ai");
    j.close();

    const undone = await run(["undo", "--manifest", manifest, "--journal", journal]);
    expect(undone.stderr).not.toContain("has not ended");
    expect(undone.stdout).toContain("the most recent with something to undo");
    expect(undone.stdout).not.toContain(empty.slice(0, 8));
    expect(readFileSync(state, "utf8")).not.toBe(worked);
  });
});

describe("reading the session list past the empty ones", () => {
  it("shows the newest session that did something, and folds the empty ones in list", async () => {
    const dir = workspace();
    const journal = join(dir, "j.db");
    await run(
      ["proxy", "--manifest", POLICY, "--journal", journal],
      `${HELLO}\n${call(2, "update_customer", { id: "c_001", notes: "by the agent" })}\n`,
    );
    const open = await import("../src/journal/journal.js");
    const j = open.openJournal(journal, { mustExist: true });
    const empties = [j.beginRun("claude-ai"), j.beginRun("claude-ai"), j.beginRun("claude-ai")];
    for (const id of empties) {
      j.endRun(id, "complete");
    }
    j.close();

    const shown = await run(["show", "--journal", journal]);
    expect(shown.stdout).toContain("update_customer");

    const listed = await run(["list", "--journal", journal]);
    expect(listed.stdout).toContain("3 sessions with nothing in them");
    for (const id of empties) {
      expect(listed.stdout).not.toContain(id.slice(0, 8));
    }
    // The contract scripts read still lists every one.
    const json = z.array(z.object({ id: z.string() })).parse(
      JSON.parse((await run(["list", "--json", "--journal", journal])).stdout),
    );
    expect(json).toHaveLength(4);
  });
});
