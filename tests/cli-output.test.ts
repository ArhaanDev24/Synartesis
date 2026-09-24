import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { asInstalled } from "./helpers/installed.js";

/** The --json shapes these tests read; parsed rather than asserted. */
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
  const dir = mkdtempSync(join(tmpdir(), "synartesis-out-"));
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
      // The short command list this file reads is written as `synartesis ...`
      // only where that command exists, so the test says which world it is in
      // rather than inheriting one from the machine.
      env: { ...process.env, ...asInstalled(dirs) },
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

describe("what the timeline says about an approval that moved", () => {
  it("never reports the approver as having denied it", async () => {
    const dir = workspace();
    const journal = join(dir, "j.db");
    const email = { to: "a@b.c", subject: "s", body: "b" };

    // Held, because send_email is irreversible and always gated.
    await run(["proxy", "--manifest", POLICY, "--journal", journal], `${HELLO}\n${call(2, "send_email", email)}\n`);
    const gates = await run(["gates", "--json", "--journal", journal]);
    const held = withIds.parse(JSON.parse(gates.stdout));
    expect(held).toHaveLength(1);

    await run(["approve", held[0]?.id.slice(0, 8) ?? "", "--by", "arhaan", "--journal", journal, "--unattended"]);
    // The agent tries again in a new session; the approval moves to that call.
    await run(["proxy", "--manifest", POLICY, "--journal", journal], `${HELLO}\n${call(2, "send_email", email)}\n`);

    const runs = withIds.parse(
      JSON.parse((await run(["list", "--json", "--journal", journal])).stdout),
    );
    const first = runs[runs.length - 1]?.id ?? "";
    const shown = await run(["show", first, "--journal", journal]);

    // The bug this guards: "denied by arhaan", printed about the person who
    // had just approved the call, beside a call that then went through.
    expect(shown.stdout).not.toContain("denied by");
    expect(shown.stdout).toContain("approved by arhaan");
    // And the footer must agree with the rows above it.
    expect(shown.stdout).not.toMatch(/\d+ denied/);
    expect(shown.stdout).toContain("used");
  });
});

describe("a count and its noun agree", () => {
  it("says one action, not one actions", async () => {
    const dir = workspace();
    const journal = join(dir, "j.db");
    await run(
      ["proxy", "--manifest", POLICY, "--journal", journal],
      `${HELLO}\n${call(2, "update_customer", { id: "c_001", notes: "one" })}\n`,
    );

    const runs = withIds.parse(
      JSON.parse((await run(["list", "--json", "--journal", journal])).stdout),
    );
    const shown = await run(["show", runs[0]?.id.slice(0, 8) ?? "", "--journal", journal]);
    expect(shown.stdout).toContain("1 action:");
    expect(shown.stdout).not.toContain("1 actions");

    // prune's summary counted the same way and got it wrong in two places
    // on one line: "1 runs and 1 actions removed".
    const pruned = await run(["prune", "--older-than", "0", "--dry-run", "--journal", journal]);
    expect(pruned.stdout).toContain("1 run and 1 action would go");
    expect(pruned.stdout).not.toMatch(/\b1 (runs|actions)\b/);
  });
});

describe("arguments on one line", () => {
  it("never breaks the layout on a multi-line value", async () => {
    const dir = workspace();
    const journal = join(dir, "j.db");
    await run(
      ["proxy", "--manifest", POLICY, "--journal", journal],
      `${HELLO}\n${call(2, "update_customer", { id: "c_001", notes: "first line\nsecond line" })}\n`,
    );
    const runs = withIds.parse(
      JSON.parse((await run(["list", "--json", "--journal", journal])).stdout),
    );
    const shown = await run(["show", runs[0]?.id ?? "", "--journal", journal]);

    // Every argument line begins with whitespace and stays one line; a raw
    // newline in a value used to split it and left "second line" at column 0.
    for (const line of shown.stdout.split("\n")) {
      if (line.includes("second line")) {
        expect(line.startsWith(" ")).toBe(true);
      }
    }
    expect(shown.stdout).toContain("first line second line");
  });
});

describe("a tidy journal is not a usage error", () => {
  it("close says so and succeeds", async () => {
    const dir = workspace();
    const journal = join(dir, "j.db");
    await run(["proxy", "--manifest", POLICY, "--journal", journal], HELLO);

    const closed = await run(["close", "--journal", journal]);
    expect(closed.code).toBe(0);
    expect(closed.stdout).toContain("nothing is open");
    // The forty lines of unrelated help that used to come with it.
    expect(closed.stderr).not.toContain("synartesis install");
  });

  it("names the problem without reciting every command", async () => {
    const dir = workspace();
    const journal = join(dir, "j.db");
    await run(["proxy", "--manifest", POLICY, "--journal", journal], HELLO);

    const missing = await run(["undo", "deadbeef", "--journal", journal]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("no run matches deadbeef");
    expect(missing.stderr.split("\n").filter((l) => l.trim() !== "")).toHaveLength(1);
  });

  it("still recites them for a command it does not know", async () => {
    const bogus = await run(["nonsense"]);
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain("unknown command nonsense");
    expect(bogus.stderr).toContain("synartesis install");
  });
});

describe("asking what version this is", () => {
  it("answers to every spelling somebody might try", async () => {
    for (const spelling of ["--version", "-V", "-v", "version"]) {
      const said = await run([spelling]);
      expect(said.code, spelling).toBe(0);
      expect(said.stdout.trim(), spelling).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("answers help as a bare word too", async () => {
    const said = await run(["help"]);
    expect(said.code).toBe(0);
    expect(said.stdout).toContain("synartesis install");
  });
});
