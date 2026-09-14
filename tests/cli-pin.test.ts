import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("dist/cli.js");
const POLICY = resolve("manifests/toy-crm.yaml");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-pin-"));
  dirs.push(dir);
  return dir;
}

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[]): Promise<Ran> {
  return new Promise<Ran>((done, fail) => {
    const child = spawn("node", [CLI, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", fail);
    child.on("close", (code) => {
      done({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end();
  });
}

/** The lines of a printed block, indented back to column zero. */
function block(stdout: string): string {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => line.trim() === "pins:");
  expect(start).toBeGreaterThanOrEqual(0);
  const taken: string[] = [];
  for (const line of lines.slice(start)) {
    if (line.trim() === "" || !line.startsWith("  ")) {
      break;
    }
    taken.push(line.slice(2));
  }
  return taken.join("\n");
}

describe("synartesis pin, end to end", () => {
  it("prints a block, and a manifest carrying it passes check", async () => {
    const printed = await run(["pin", "--manifest", POLICY]);
    expect(printed.code).toBe(0);
    const pins = block(printed.stdout);
    expect(pins).toContain("crm:");
    expect(pins).toMatch(/update_customer: "sha256:[0-9a-f]{64}"/);

    const dir = workspace();
    const pinned = join(dir, "pinned.yaml");
    writeFileSync(pinned, `${readFileSync(POLICY, "utf8")}\n${pins}\n`);

    const checked = await run(["check", "--manifest", pinned]);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("pinned");
  });

  it("refuses to start the proxy once a pinned shape has moved", async () => {
    const printed = await run(["pin", "--manifest", POLICY]);
    const dir = workspace();
    const pinned = join(dir, "pinned.yaml");
    writeFileSync(
      pinned,
      `${readFileSync(POLICY, "utf8")}\n${block(printed.stdout)}\n`.replace(
        /update_customer: "sha256:[0-9a-f]{8}/,
        'update_customer: "sha256:deadbeef',
      ),
    );

    // The proxy, not just check: check is advisory, the proxy is what serves.
    const served = await run(["proxy", "--manifest", pinned, "--journal", join(dir, "j.db")]);
    expect(served.code).toBe(1);
    expect(served.stderr).toContain("no longer matches the policy written for it");
    expect(served.stderr).toContain("update_customer");
  });

  it("says so plainly when nothing is pinned", async () => {
    const checked = await run(["check", "--manifest", POLICY]);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("run `synartesis pin`");
  });
});
