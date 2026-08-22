import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import { openJournal } from "../src/journal/journal.js";

/** Loose on purpose: this helper writes the file back, so it must not drop fields. */
const stateSchema = z.looseObject({
  customers: z.record(
    z.string(),
    z.looseObject({ id: z.string(), plan: z.string(), notes: z.string() }),
  ),
});

function readState(path: string): z.infer<typeof stateSchema> {
  return stateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

const FIXTURE = resolve("dist/toy-crm.js");
const PROXY = resolve("dist/proxy.js");
const CLI = resolve("dist/cli.js");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Workspace {
  readonly dir: string;
  readonly manifest: string;
  readonly journal: string;
  readonly state: string;
}

function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-cli-"));
  dirs.push(dir);
  const state = join(dir, "crm.json");
  const manifest = join(dir, "synartesis.yaml");
  writeFileSync(
    manifest,
    readFileSync("manifests/toy-crm.yaml", "utf8").replace(
      'args: ["dist/toy-crm.js"]',
      `args: ["${FIXTURE}", "--state", "${state}"]`,
    ),
  );
  return { dir, manifest, journal: join(dir, "journal.db"), state };
}

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Where {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function run(
  command: string,
  args: readonly string[],
  stdin?: string,
  where: Where = {},
): Promise<Ran> {
  return new Promise<Ran>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(where.cwd === undefined ? {} : { cwd: where.cwd }),
      ...(where.env === undefined ? {} : { env: where.env }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", rejectRun);
    child.on("close", (code) => {
      resolveRun({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function frames(...calls: readonly { name: string; arguments: Record<string, unknown> }[]): string {
  const lines = [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agent", version: "0" },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ...calls.map((params, index) =>
      JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params }),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Anything on the proxy's stderr that is not a structured log below error
 * level. A stray plain line would mean something wrote outside the logger.
 */
function problems(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      const parsed = z
        .looseObject({ level: z.number() })
        .safeParse(((): unknown => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return undefined;
          }
        })());
      return !parsed.success || parsed.data.level >= 50;
    });
}

async function damage(space: Workspace): Promise<void> {
  const result = await run(
    "node",
    [PROXY, "--manifest", space.manifest, "--journal", space.journal],
    frames(
      { name: "update_customer", arguments: { id: "c_001", plan: "free", notes: "WRONG" } },
      { name: "delete_customer", arguments: { id: "c_002" } },
      { name: "create_customer", arguments: { name: "Bogus", email: "b@e.com" } },
    ),
  );
  expect(problems(result.stderr)).toEqual([]);
}

const runsSchema = z.array(z.looseObject({ id: z.string(), actions: z.number() }));

async function runs(journalPath: string): Promise<z.infer<typeof runsSchema>> {
  const listed = await run("node", [CLI, "list", "--json", "--journal", journalPath]);
  expect(listed.code).toBe(0);
  return runsSchema.parse(JSON.parse(listed.stdout));
}

async function onlyRunId(journalPath: string): Promise<string> {
  const all = await runs(journalPath);
  const first = all[0];
  if (first === undefined) {
    throw new Error("no runs recorded");
  }
  return first.id;
}

describe("the proxy under an abrupt disconnect", () => {
  it("finishes a call whose pre-read is still in flight when stdin closes", async () => {
    const space = workspace();
    await damage(space);

    // The client's pipe closes immediately after the last frame. A shutdown
    // that counted a call as in-flight only after its pre-read would abort the
    // read and block a write the agent was entitled to make.
    const journal = openJournal(space.journal);
    const runId = journal.listRuns()[0]?.id ?? "";
    const actions = journal.getActions(runId);
    expect(actions.map((a) => a.status)).toEqual(["applied", "applied", "applied"]);
    expect(actions.every((a) => a.error === undefined)).toBe(true);
    journal.close();
  });
});

describe("the cli", () => {
  it("lists runs", async () => {
    const space = workspace();
    await damage(space);
    const listed = await run("node", [CLI, "list", "--journal", space.journal]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("agent");
    expect(listed.stdout).toContain("complete");
    expect(await runs(space.journal)).toMatchObject([{ label: "agent", actions: 3 }]);
  });

  it("undoes a run against state left behind by a process that has exited", async () => {
    const space = workspace();
    await damage(space);
    const damagedText = readFileSync(space.state, "utf8");
    const damaged = readState(space.state);
    expect(damaged.customers["c_001"]?.plan).toBe("free");
    expect(damaged.customers["c_002"]).toBeUndefined();

    const runId = await onlyRunId(space.journal);

    const dry = await run("node", [
      CLI, "undo", runId, "--dry-run", "--manifest", space.manifest, "--journal", space.journal,
    ]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("would call");
    // A dry run reads state but changes nothing.
    expect(readFileSync(space.state, "utf8")).toBe(damagedText);

    const undone = await run("node", [
      CLI, "undo", runId, "--manifest", space.manifest, "--journal", space.journal,
    ]);
    expect(undone.code).toBe(0);
    expect(undone.stdout).toContain("rolled_back");

    const restored = readState(space.state);
    expect(restored.customers["c_001"]).toMatchObject({
      plan: "pro",
      notes: "founding customer",
    });
    expect(restored.customers["c_002"]).toBeDefined();
    expect(restored.customers["c_004"]).toBeUndefined();
  });

  it("refuses and exits non-zero when the resource drifted", async () => {
    const space = workspace();
    await damage(space);

    const state = readState(space.state);
    const target = state.customers["c_001"];
    if (target === undefined) {
      throw new Error("c_001 missing");
    }
    target.notes = "a human corrected this";
    writeFileSync(space.state, JSON.stringify(state, null, 2));

    const undone = await run("node", [
      CLI, "undo", await onlyRunId(space.journal), "--manifest", space.manifest, "--journal", space.journal,
    ]);

    expect(undone.code).toBe(1);
    expect(undone.stdout).toContain("drift");
    expect(undone.stdout).toContain("a human corrected this");
    // Nothing was clobbered.
    const after = readState(space.state);
    expect(after.customers["c_001"]?.notes).toBe("a human corrected this");
  });

  it("exits 2 on bad usage and on an unknown run", async () => {
    const space = workspace();
    await damage(space);
    expect((await run("node", [CLI, "wat", "--journal", space.journal])).code).toBe(2);
    const missing = await run("node", [CLI, "undo", "nope", "--journal", space.journal]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("no run matches");
  });

  it("opens the screen when it is given nothing to do", async () => {
    const space = workspace();
    await damage(space);
    // Being handed nothing used to be treated as a mistake and answered with a
    // page of commands and a failure code. Wanting to see what happened is not
    // a mistake, and it is the commonest reason to run this at all.
    const opened = await run("node", [CLI, "--journal", space.journal]);
    expect(opened.code).toBe(0);
    // Piped, so it prints one still frame of what is there rather than taking
    // over the terminal.
    expect(opened.stdout).toContain("agent");
    expect(opened.stdout).toContain("3 actions");
  });
});

describe("the gate, driven from a second process", () => {
  async function agentAgainst(space: Workspace): Promise<Client> {
    const client = new Client({ name: "rogue-agent", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "node",
        args: [PROXY, "--manifest", space.manifest, "--journal", space.journal],
        stderr: "ignore",
      }),
    );
    return client;
  }

  const email = {
    name: "send_email",
    arguments: { to: "ada@example.com", subject: "Hi", body: "Automated" },
  };

  /** The send_email row, whatever state the decision left it in. */
  function gatedOrApproved(journal: ReturnType<typeof openJournal>): string {
    const id = journal
      .listRuns()
      .flatMap((entry) => journal.getActions(entry.id))
      .find((action) => action.tool === "send_email")?.id;
    if (id === undefined) {
      throw new Error("no send_email action was journalled");
    }
    return id;
  }

  function gatedAction(journalPath: string): string {
    const journal = openJournal(journalPath);
    const id = journal.listGated()[0]?.id;
    journal.close();
    if (id === undefined) {
      throw new Error("nothing is awaiting approval");
    }
    return id;
  }

  it("refuses at once and tells the agent how to get approval", async () => {
    const space = workspace();
    const client = await agentAgainst(space);

    const started = performance.now();
    const thrown = await client.callTool(email).catch((error: unknown) => error);
    const elapsed = performance.now() - started;

    // The whole point: no held connection. A client's own tool timeout is
    // shorter than any useful window for a person to decide, so waiting is
    // not something the two can ever agree on.
    expect(elapsed).toBeLessThan(2000);
    expect(thrown).toBeInstanceOf(McpError);
    expect(String(thrown)).toContain("Synartesis is holding this call for approval");
    // Not the literal string "synartesis approve": whether the short form is
    // available depends on whether it has been installed on this machine, and
    // the point is that whatever is printed can actually be run. The test
    // below executes it.
    expect(String(thrown)).toMatch(/approve [0-9a-f]{8}/);
    await client.close();
  });

  it("lets the same call through once a person has approved it", async () => {
    const space = workspace();
    const first = await agentAgainst(space);
    await first.callTool(email).catch(() => undefined);
    await first.close();

    const actionId = gatedAction(space.journal);
    const approved = await run("node", [
      CLI, "approve", actionId, "--by", "arhaan", "--journal", space.journal,
    ]);
    expect(approved.code).toBe(0);

    // A different session entirely: people restart their client, and an
    // approval stranded in a dead one would be no approval at all.
    const second = await agentAgainst(space);
    const result = await second.callTool(email);
    expect(result.isError).toBeFalsy();

    // And it is spent: the next identical call has to be approved again.
    const again = await second.callTool(email).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(McpError);
    await second.close();
  });

  it("records who approved the call that actually ran", async () => {
    const space = workspace();
    const first = await agentAgainst(space);
    await first.callTool(email).catch(() => undefined);
    await first.close();

    await run("node", [
      CLI, "approve", gatedAction(space.journal), "--by", "arhaan", "--journal", space.journal,
    ]);
    const second = await agentAgainst(space);
    await second.callTool(email);
    await second.close();

    const journal = openJournal(space.journal);
    const applied = journal
      .listRuns()
      .flatMap((run_) => journal.getActions(run_.id))
      .filter((action) => action.status === "applied" && action.tool === "send_email");
    expect(applied).toHaveLength(1);
    expect(applied[0]?.approvedBy).toBe("arhaan");
    journal.close();
  });

  it("leaves a denied call refused, and says who refused it", async () => {
    const space = workspace();
    const client = await agentAgainst(space);
    await client.callTool(email).catch(() => undefined);

    const actionId = gatedAction(space.journal);
    await run("node", [
      CLI, "deny", actionId, "--by", "arhaan", "--reason", "we do not email customers",
      "--journal", space.journal,
    ]);

    const thrown = await client.callTool(email).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(McpError);

    // The agent keeps working after a refusal.
    const after = await client.callTool({ name: "get_customer", arguments: { id: "c_001" } });
    expect(after.isError).toBeFalsy();
    await client.close();

    const journal = openJournal(space.journal);
    const denied = journal
      .listRuns()
      .flatMap((run_) => journal.getActions(run_.id))
      .find((action) => action.status === "denied");
    expect(denied?.error).toContain("we do not email customers");
    journal.close();
  });

  it("tells the agent a command that actually runs", async () => {
    const space = workspace();
    const client = await agentAgainst(space);
    const thrown = await client.callTool(email).catch((error: unknown) => error);
    await client.close();

    // Whoever approves may be in any directory, so the instruction has to
    // carry everything it needs. Three separate bugs have been exactly this:
    // output naming a command that fails the moment somebody follows it.
    const suggested = /Ask them to run: (.+?)\s+---/.exec(String(thrown))?.[1];
    expect(suggested).toBeDefined();
    expect(suggested).toContain(space.journal);

    const ran = await new Promise<number>((resolveRun) => {
      const child = spawn(suggested ?? "", { shell: true, stdio: "ignore", cwd: tmpdir() });
      child.on("close", (code) => {
        resolveRun(code ?? -1);
      });
    });
    expect(ran).toBe(0);

    const journal = openJournal(space.journal);
    expect(journal.getAction(gatedOrApproved(journal))?.approvedBy).toBeTruthy();
    journal.close();
  });

  it("says a journal is missing rather than inventing an empty one", async () => {
    const space = workspace();
    const absent = join(space.dir, "nowhere", "journal.db");
    const listed = await run("node", [CLI, "gates", "--journal", absent]);

    expect(listed.code).toBe(1);
    expect(listed.stderr).toContain("no journal at");
    // An empty journal here would report "nothing waiting", which reads
    // exactly like a real answer.
    expect(existsSync(absent)).toBe(false);
  });

  it("records the logged-in user when nobody is named", async () => {
    const space = workspace();
    const client = await agentAgainst(space);
    await client.callTool(email).catch(() => undefined);
    await client.close();

    const actionId = gatedAction(space.journal);
    // No --by. "unknown" is a poor thing to find in an audit trail when the
    // machine knows who is logged in.
    await run("node", [CLI, "approve", actionId, "--journal", space.journal]);

    const journal = openJournal(space.journal);
    const who = journal.getAction(actionId)?.approvedBy;
    journal.close();
    expect(who).toBe(process.env["USER"] ?? process.env["LOGNAME"]);
    expect(who).not.toBe("unknown");
  });

  it("reports a decision that arrives after the action is settled", async () => {
    const space = workspace();
    const client = await agentAgainst(space);
    await client.callTool(email).catch(() => undefined);
    await client.close();

    const actionId = gatedAction(space.journal);
    await run("node", [CLI, "approve", actionId, "--journal", space.journal]);
    const late = await run("node", [CLI, "deny", actionId, "--journal", space.journal]);
    expect(late.code).toBe(1);
    expect(late.stderr).toContain("no longer awaiting approval");
  });
});

describe("setting up without a project to set it up in", () => {
  it("writes the policy into one home, and adds the next server to the same file", async () => {
    const home = mkdtempSync(join(tmpdir(), "synartesis-home-"));
    dirs.push(home);
    const elsewhere = mkdtempSync(join(tmpdir(), "synartesis-elsewhere-"));
    dirs.push(elsewhere);
    const env = { ...process.env, SYNARTESIS_HOME: home };

    const first = await run("node", [CLI, "init", "crm", "--", "node", FIXTURE], undefined, {
      cwd: elsewhere,
      env,
    });
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);

    const manifest = join(home, "synartesis.yaml");
    expect(existsSync(manifest)).toBe(true);
    // Nothing was left in the directory the command happened to be run from.
    expect(existsSync(join(elsewhere, "synartesis.yaml"))).toBe(false);

    const second = await run("node", [CLI, "init", "other", "--", "node", FIXTURE], undefined, {
      cwd: elsewhere,
      env,
    });
    expect(second.code).toBe(0);
    const text = readFileSync(manifest, "utf8");
    // One file with both servers in it, rather than a directory each.
    expect(text).toContain("crm:");
    expect(text).toContain("other:");
  });
});

describe("the help on where things are", () => {
  it("says the journal is in the home, since that is where it is", async () => {
    // "default .synartesis/journal.db" read as a path relative to here, and
    // someone following it would go looking in the wrong directory for the
    // record of everything their agent had done.
    const help = await run("node", [CLI, "--help"]);
    expect(help.stdout).toContain("~/.synartesis");
    expect(help.stdout).toContain("SYNARTESIS_HOME");
    expect(help.stdout).not.toContain("default .synartesis/journal.db");
  });
});

describe("defaulting to the most recent run", () => {
  it("does it once there is more than one run, which is when it matters", async () => {
    // --help says show and undo default to the most recent run. That held only
    // while exactly one run existed; the second one turned both into an error
    // listing every id and telling you to name one -- and offering --all,
    // which neither command takes.
    const space = workspace();
    const journal = openJournal(space.journal);
    const ids: string[] = [];
    for (const label of ["first", "second", "third"]) {
      const id = journal.beginRun(label);
      journal.endRun(id, "complete");
      ids.push(id);
    }
    journal.close();
    const newest = ids[ids.length - 1] ?? "";

    const shown = await run("node", [CLI, "show", "--json", "--journal", space.journal]);
    expect(shown.code).toBe(0);
    const parsed: unknown = JSON.parse(shown.stdout);
    expect(parsed).toMatchObject({ run: { id: newest, label: "third" } });

    const plain = await run("node", [CLI, "show", "--journal", space.journal]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(newest);
  });
});
