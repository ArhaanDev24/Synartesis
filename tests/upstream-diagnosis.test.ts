import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectStdioUpstream } from "../src/proxy/upstream.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-diag-"));
  dirs.push(dir);
  return dir;
}

/** The message a person actually sees when a server will not start. */
async function saidWhenStarting(args: readonly string[]): Promise<string> {
  try {
    await connectStdioUpstream({ name: "fs", command: "node", args: [...args], stderr: "capture" });
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the upstream to fail");
}

describe("what a server that will not start is reported as saying", () => {
  it("names the file that is missing", async () => {
    const said = await saidWhenStarting([join(scratch(), "not-here.js")]);
    // The whole answer, and what was thrown away: node puts this line in the
    // middle of its output and ends with four lines of ceremony.
    expect(said).toContain("Cannot find module");
    expect(said).toContain("not-here.js");
  });

  it("does not answer with the ceremony that follows it", async () => {
    const said = await saidWhenStarting([join(scratch(), "not-here.js")]);
    expect(said).not.toContain("requireStack");
    expect(said).not.toMatch(/Node\.js v\d/);
  });

  it("leads with a syntax error rather than the stack under it", async () => {
    const dir = scratch();
    const file = join(dir, "bad.js");
    writeFileSync(file, "this is not javascript {{{\n");
    const said = await saidWhenStarting([file]);
    expect(said).toContain("SyntaxError");
    expect(said).not.toMatch(/\bat \w/);
  });

  it("repeats a server's own one-line complaint verbatim", async () => {
    const dir = scratch();
    const file = join(dir, "picky.js");
    writeFileSync(file, 'console.error("config error: MEMORY_FILE_PATH is not set");process.exit(1);\n');
    const said = await saidWhenStarting([file]);
    expect(said).toContain("config error: MEMORY_FILE_PATH is not set");
  });

  it("falls back to the tail when nothing names a fault", async () => {
    const dir = scratch();
    const file = join(dir, "quiet.js");
    writeFileSync(file, 'console.error("My Server v1.2 starting");process.exit(3);\n');
    const said = await saidWhenStarting([file]);
    // Not useful, but it is everything there was, and better than silence.
    expect(said).toContain("My Server v1.2 starting");
  });

  it("does not hang on a server that says more than a pipe holds", async () => {
    const dir = scratch();
    const file = join(dir, "flood.js");
    // Around 2.4MB, well past the ~64kB a pipe buffers. Nothing read stderr until after the
    // connect failed, so the child blocked on its own write, never exited,
    // connect never rejected, and `check` sat there for ever with no output.
    writeFileSync(
      file,
      'for (let i = 0; i < 20000; i += 1) console.error("noise ".repeat(20));\n' +
        "process.exit(1);\n",
    );
    const began = Date.now();
    const said = await saidWhenStarting([file]);
    expect(said).toContain("failed during connect");
    // It used to not come back at all. Anything under a few seconds is the
    // point; the number is loose on purpose.
    expect(Date.now() - began).toBeLessThan(5000);
  }, 20000);

  it("drops stack frames even when nothing names a fault", async () => {
    const dir = scratch();
    const file = join(dir, "framed.js");
    writeFileSync(
      file,
      'console.error("something went wrong");\n' +
        'console.error("    at Object.<anonymous> (/x/y.js:1:1)");\n' +
        'console.error("    at Module._compile (node:internal:1:1)");\n' +
        "process.exit(1);\n",
    );
    const said = await saidWhenStarting([file]);
    expect(said).toContain("something went wrong");
    expect(said).not.toContain("Module._compile");
  });

  it("names the server it was trying to start", async () => {
    const said = await saidWhenStarting([join(scratch(), "not-here.js")]);
    expect(said).toContain("fs");
  });
});
