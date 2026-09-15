/**
 * The next thing to type.
 *
 * What is under test here is not the wording but the judgement: that the hint
 * names the session somebody actually meant, that a held call outranks
 * everything else, and that a program reading this output never sees any of
 * it. A hint that is usually right is worse than none, because the second time
 * it misleads somebody they stop reading the line -- and it is the same line
 * that carries the answer when it matters.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { asInstalled } from "./helpers/installed.js";

import { afterStatus, didYouMean, LEAVE_IT_RUNNING } from "../src/hints.js";
import { openJournal } from "../src/journal/journal.js";

/** The --json shape this file reads; parsed rather than asserted. */
const withIds = z.array(z.object({ id: z.string() }));

const CLI = resolve("dist/cli.js");
const POLICY = resolve("manifests/toy-crm.yaml");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-hint-"));
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
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

/** One agent session against the toy CRM, making the calls given. */
async function session(journal: string, ...calls: readonly string[]): Promise<void> {
  await run(["proxy", "--manifest", POLICY, "--journal", journal], `${HELLO}\n${calls.join("\n")}\n`);
}

describe("which session a hint points at", () => {
  it("skips the sessions that only read, and names the one that wrote", async () => {
    const journal = join(workspace(), "j.db");
    // The one that changed something, then two that did not: a session that
    // only reads, and a session that connects and calls nothing at all. Both
    // of those are newer, and both are the kind of session a client opens
    // without anybody asking it to.
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "changed" }));
    await session(journal, call(2, "get_customer", { id: "c_001" }));
    await session(journal);

    const listed = await run(["list", "--journal", journal]);
    const hint = listed.stdout.split("\n").filter((line) => line.includes("synartesis show"));
    expect(hint).toHaveLength(1);

    // The run it names must be the first one, not either of the two newer
    // sessions above it in the list.
    const rows = listed.stdout
      .split("\n")
      .filter((line) => /^ {2}[0-9a-f]{8}\b/.test(line))
      .map((line) => line.trim().slice(0, 8));
    expect(rows).toHaveLength(3);
    const named = /synartesis show ([0-9a-f]{8})/.exec(hint[0] ?? "")?.[1];
    expect(named).toBe(rows[rows.length - 1]);
  });

  it("says nothing at all when every session only read", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "get_customer", { id: "c_001" }));

    const listed = await run(["list", "--journal", journal]);
    // Offering an undo of a session that read a record is how somebody learns
    // this line is not worth reading.
    expect(listed.stdout).not.toContain("synartesis show");
  });

  it("stops offering an undo once the session has been undone", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "changed" }));
    const undone = await run(["undo", "--manifest", POLICY, "--journal", journal]);
    expect(undone.code).toBe(0);

    const listed = await run(["list", "--journal", journal]);
    expect(listed.stdout).not.toContain("synartesis show");
  });
});

describe("what outranks what", () => {
  it("names the held call rather than the session that changed something", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "changed" }));
    // send_email is irreversible, so it is held.
    await session(journal, call(2, "send_email", { to: "a@b.c", subject: "s", body: "b" }));

    const listed = await run(["list", "--journal", journal]);
    // An agent stopped mid-task waiting on a person who does not know it is
    // waiting beats anything else this could say.
    expect(listed.stdout).toContain("waiting on you");
    expect(listed.stdout).toContain("synartesis approve");
    expect(listed.stdout).not.toContain("synartesis show");
  });

  it("offers --all once more than one is held, and an id while there is only one", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "send_email", { to: "a@b.c", subject: "one", body: "b" }));
    const one = await run(["list", "--journal", journal]);
    expect(one.stdout).toMatch(/synartesis approve [0-9a-f]{8}/);

    await session(journal, call(2, "send_email", { to: "a@b.c", subject: "two", body: "b" }));
    const two = await run(["list", "--journal", journal]);
    // Copying two ids out of a list is the clunky thing this exists to avoid.
    expect(two.stdout).toContain("synartesis approve --all");
  });
});

describe("who the hint is for", () => {
  it("is absent from --json, which nothing but a program reads", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "send_email", { to: "a@b.c", subject: "s", body: "b" }));

    for (const command of ["list", "gates"]) {
      const said = await run([command, "--json", "--journal", journal]);
      // Parsed, not merely searched: a hint on stdout would make this throw,
      // which is exactly what it would do to the caller's parser.
      expect(() => JSON.parse(said.stdout) as unknown, command).not.toThrow();
      expect(said.stdout, command).not.toContain("waiting on you");
    }
  });

  it("is absent when somebody has said they do not want it", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "send_email", { to: "a@b.c", subject: "s", body: "b" }));

    const said = await run(["list", "--journal", journal], undefined, { SYNARTESIS_NO_HINTS: "1" });
    expect(said.stdout).not.toContain("waiting on you");
    // And the command itself still works.
    expect(said.code).toBe(0);
    expect(said.stdout).toContain("S E S S I O N S");
  });
});

describe("after reading every resource for real", () => {
  it("offers the undo it has just established would go through", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "changed" }));

    const live = await run(["show", "--live", "--manifest", POLICY, "--journal", journal]);
    expect(live.code).toBe(0);
    expect(live.stdout).toMatch(/synartesis undo [0-9a-f]{8} --dry-run/);
  });

  it("offers nothing of the sort for a session that never applied anything", async () => {
    const journal = join(workspace(), "j.db");
    // Held, so the call never went out and there is nothing to put back. The
    // drift check finds nothing moved -- which is true, and not a reason to
    // offer an undo.
    await session(journal, call(2, "send_email", { to: "a@b.c", subject: "s", body: "b" }));

    const live = await run(["show", "--live", "--manifest", POLICY, "--journal", journal]);
    expect(live.stdout).toContain("nothing here was ever applied");
    expect(live.stdout).not.toContain("--dry-run");
  });
});

describe("a hint is meant to be pasted", () => {
  it("repeats the journal back when it was not the default one", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "changed" }));

    const listed = await run(["list", "--journal", journal]);
    const line = listed.stdout.split("\n").find((one) => one.includes("synartesis show"));
    expect(line).toContain(`--journal ${journal}`);

    // And the whole line, run as it was printed, must actually work. This is
    // the only assertion here that matters: without the path it resolved
    // against the default journal and answered "no run matches".
    const pasted = (line ?? "").trim().replace(/^.*?synartesis /, "").split(/\s+/);
    const shown = await run(pasted);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("S E S S I O N");
  });

  it("stays short when the journal was the one it would have found anyway", async () => {
    const dir = workspace();
    // journal.db, in a home of its own: that is where this looks when nobody
    // says, so there is nothing to repeat back.
    const journal = join(dir, "journal.db");
    await session(journal, call(2, "send_email", { to: "a@b.c", subject: "s", body: "b" }));

    const listed = await run(["list"], undefined, { SYNARTESIS_HOME: dir });
    const line = listed.stdout.split("\n").find((one) => one.includes("synartesis approve"));
    expect(line).toBeDefined();
    expect(line).not.toContain("--journal");
  });

  it("carries --replan, since that is what was planned", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "changed" }));

    const planned = await run([
      "undo", "--replan", "--dry-run", "--manifest", POLICY, "--journal", journal,
    ]);
    // Without this the offered command applies the inverses recorded at
    // capture time, which is the opposite of the plan just shown.
    expect(planned.stdout).toContain("--replan");
    const line = planned.stdout.split("\n").find((one) => one.includes("synartesis undo"));
    expect(line).toContain(`--manifest ${POLICY}`);
    expect(line).toContain(`--journal ${journal}`);
  });

  it("leaves --replan off when it was not asked for", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "changed" }));

    const planned = await run(["undo", "--dry-run", "--manifest", POLICY, "--journal", journal]);
    const line = planned.stdout.split("\n").find((one) => one.includes("nothing was written"));
    expect(line).not.toContain("--replan");
  });
});

describe("a dry run is not a result", () => {
  it("says nothing was written, and how to write it", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "changed" }));

    const planned = await run(["undo", "--dry-run", "--manifest", POLICY, "--journal", journal]);
    // The result line says `rolled_back`, which is the one thing in this
    // output that reads as the undo having happened.
    expect(planned.stdout).toContain("rolled_back");
    expect(planned.stdout).toContain("nothing was written");
    expect(planned.stdout).toMatch(/synartesis undo [0-9a-f]{8}/);
  });

  it("says no such thing after a real undo, which did write", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "update_customer", { id: "c_001", notes: "changed" }));

    const done = await run(["undo", "--manifest", POLICY, "--journal", journal]);
    expect(done.stdout).not.toContain("nothing was written");
  });
});

describe("what approving does", () => {
  it("says the call goes back to the agent, rather than leaving it a mystery", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "send_email", { to: "a@b.c", subject: "s", body: "b" }));

    const said = await run(["approve", "--all", "--by", "arhaan", "--journal", journal]);
    expect(said.code).toBe(0);
    // Nothing is called from here. Somebody who approves and then waits for
    // something to happen is waiting on a thing already handed back.
    expect(said.stdout).toContain("the agent can make that call again now");
  });

  it("points at the next one while any are still held", async () => {
    const journal = join(workspace(), "j.db");
    await session(journal, call(2, "send_email", { to: "a@b.c", subject: "one", body: "b" }));
    await session(journal, call(2, "send_email", { to: "a@b.c", subject: "two", body: "b" }));

    const gates = await run(["gates", "--json", "--journal", journal]);
    const held = withIds.parse(JSON.parse(gates.stdout));
    expect(held).toHaveLength(2);

    const said = await run(["approve", held[0]?.id ?? "", "--by", "arhaan", "--journal", journal]);
    expect(said.stdout).toContain("waiting on you");
    expect(said.stdout).toMatch(/synartesis approve [0-9a-f]{8}/);
  });
});

describe("the moment right after installing", () => {
  it("says what to do with the thing just wired up, before any journal exists", () => {
    // Driven directly rather than through `status`, which reads the MCP client
    // configs of whatever machine it runs on: the branch under test needs
    // every server covered and no journal yet, and a test that only holds on a
    // machine set up that way is a test that tells you nothing.
    expect(afterStatus(undefined)).toBe(LEAVE_IT_RUNNING);
  });

  it("names a session instead, once there is one to name", () => {
    const journal = openJournal(":memory:");
    try {
      expect(afterStatus(journal)).toBe(LEAVE_IT_RUNNING);
      const runId = journal.beginRun("an agent");
      const pending = journal.recordPending({
        runId,
        server: "crm",
        tool: "update_customer",
        args: { id: "c_001" },
        class: "reversible",
      });
      journal.markApplied(pending.actionId, {
        result: {},
        inverse: { server: "crm", tool: "update_customer", args: { id: "c_001" } },
      });

      const hint = afterStatus(journal);
      expect(hint).not.toBe(LEAVE_IT_RUNNING);
      expect(hint?.run).toBe(`show ${runId.slice(0, 8)}`);
    } finally {
      journal.close();
    }
  });
});

describe("a word that is not a command", () => {
  it("names the one that was probably meant", async () => {
    // Pointed at a journal that is not there, deliberately. The check used to
    // sit after the journal was opened, so this answered with a paragraph
    // about journals -- and a test run without --journal passes either way on
    // any machine that has ever run a proxy, which is every machine a person
    // develops this on and none of the ones somebody installs it on.
    const said = await run(["lst", "--journal", join(workspace(), "nope.db")]);
    expect(said.code).toBe(2);
    expect(said.stderr).toContain("did you mean list?");
    expect(said.stderr).not.toContain("there is no journal");
  });

  it("says so before it goes looking for anything, for every command word", async () => {
    // The same for a word that is nobody's typo: it must still be reported as
    // the word it is, not as whatever the next step would have complained
    // about.
    const said = await run(["nonsense", "--journal", join(workspace(), "nope.db")]);
    expect(said.code).toBe(2);
    expect(said.stderr).toContain("unknown command nonsense");
    expect(said.stderr).not.toContain("there is no journal");
  });

  it("names the flag that was probably meant", async () => {
    const said = await run(["list", "--jounral", "x"]);
    expect(said.code).toBe(2);
    expect(said.stderr).toContain("did you mean --journal?");
  });

  it("answers with five commands rather than the whole page", async () => {
    const said = await run(["nonsense"]);
    expect(said.code).toBe(2);
    // The full page is what --help is for, and it is forty lines.
    expect(said.stderr.split("\n").length).toBeLessThan(15);
    expect(said.stderr).toContain("synartesis install");
    expect(said.stderr).toContain("--help");
    // Flags, paths and exit codes all belong to the page, not to this.
    expect(said.stderr).not.toContain("Exit codes");
    expect(said.stderr).not.toContain("--older-than");
  });

  it("still prints the whole page when it was asked for", async () => {
    const said = await run(["--help"]);
    expect(said.code).toBe(0);
    expect(said.stdout).toContain("Exit codes");
    expect(said.stdout).toContain("--older-than");
  });
});

describe("guessing at what was meant", () => {
  it("guesses when the word is close, and keeps quiet when it is not", () => {
    expect(didYouMean("lst", ["list", "show", "undo"])).toBe("list");
    expect(didYouMean("shwo", ["list", "show", "undo"])).toBe("show");
    // Nothing here is a near miss for anything, and a wrong guess costs more
    // than no guess: it sends somebody off to try a command they did not mean.
    expect(didYouMean("zzzzzzzz", ["list", "show", "undo"])).toBeUndefined();
    expect(didYouMean("proxy", ["list", "show", "undo"])).toBeUndefined();
  });

  it("keeps quiet rather than guessing wildly at a longer word", () => {
    const flags = ["--live", "--to", "--json", "--force", "--journal", "--help"];
    // Half the length of what was typed was the old ceiling, and on a word of
    // eight characters that is four edits -- enough to reach anything. It
    // answered --server with --live and --token with --to, neither of which
    // anybody meant, and a wrong guess sends somebody off to read about a flag
    // that was never the subject.
    expect(didYouMean("--server", flags)).toBeUndefined();
    expect(didYouMean("--token", flags)).toBeUndefined();
    // Two characters is never enough to guess from: every one-letter flag is
    // one edit from every other.
    expect(didYouMean("-x", ["-h", "-v"])).toBeUndefined();
  });

  it("counts a swapped pair as the single mistake it feels like", () => {
    // The commonest typo there is. Plain Levenshtein calls it two edits, which
    // at a ceiling tight enough to throw out the nonsense above would put
    // every one of these out of reach.
    expect(didYouMean("shwo", ["show", "list"])).toBe("show");
    expect(didYouMean("pruen", ["prune", "proxy"])).toBe("prune");
    expect(didYouMean("--jounral", ["--journal", "--json"])).toBe("--journal");
  });

  it("does not turn a one-letter word into a command", () => {
    // Half of one character is zero, and the ceiling is at least one, so `l`
    // is one edit from nothing here. It must not silently become `list`.
    expect(didYouMean("q", ["list", "show", "undo"])).toBeUndefined();
  });
});
