/**
 * Which tools have no policy, said before an agent finds out.
 *
 * An unmatched tool has always been fail-closed: irreversible, and held for a
 * person the first time it is called (D4). That is the safe end of the trade
 * and is not in question here. What was missing is that nobody said which
 * tools those were. `check` connects to every server and reads its entire
 * tool list in order to verify the policies -- so the answer was in hand, and
 * thrown away, and the first anybody heard of it was an agent stopping
 * mid-task on a call nobody knew was guarded.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { parseManifest } from "../src/manifest/load.js";
import { ungoverned } from "../src/manifest/standing.js";

const FIXTURE = resolve("dist/toy-crm.js");
const CLI = resolve("dist/cli.js");
const PROXY = resolve("dist/proxy.js");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The toy policy, with one tool's rule taken out so a gap exists to find. */
function workspace(drop?: string): { dir: string; manifest: string } {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-ungoverned-"));
  dirs.push(dir);
  let text = readFileSync("manifests/toy-crm.yaml", "utf8").replace(
    'args: ["dist/toy-crm.js"]',
    `args: ["${FIXTURE}", "--state", "${join(dir, "crm.json")}"]`,
  );
  if (drop !== undefined) {
    const from = text.indexOf(`  - match: "crm.${drop}"`);
    const to = text.indexOf("  - match:", from + 10);
    text = text.slice(0, from) + (to === -1 ? "" : text.slice(to));
  }
  const manifest = join(dir, "synartesis.yaml");
  writeFileSync(manifest, text);
  return { dir, manifest };
}

function run(command: string, args: readonly string[]): Promise<{ out: string; err: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", fail);
    child.on("close", () => {
      done({ out, err });
    });
    // An initialize is enough to get the proxy past startup; it is the startup
    // line this reads, not anything it serves.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      })}\n`,
    );
    child.stdin.end();
  });
}

describe("tools no policy covers", () => {
  it("finds the ones a manifest does not claim, and only those", () => {
    const manifest = parseManifest(
      readFileSync("manifests/toy-crm.yaml", "utf8"),
      "manifests/toy-crm.yaml",
    );
    const found = ungoverned(
      manifest,
      new Map([["crm", ["get_customer", "send_email", "invent_something", "also_new"]]]),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.server).toBe("crm");
    // Sorted, and carrying neither of the two the policy does claim.
    expect(found[0]?.tools).toEqual(["also_new", "invent_something"]);
  });

  it("says nothing when every advertised tool is claimed", () => {
    const manifest = parseManifest(
      readFileSync("manifests/toy-crm.yaml", "utf8"),
      "manifests/toy-crm.yaml",
    );
    expect(ungoverned(manifest, new Map([["crm", ["get_customer", "send_email"]]]))).toEqual([]);
  });

  it("covers every tool the real filesystem server offers", async () => {
    // The policy that ships, against the server that ships with it. This is
    // the setup nearly everybody runs, and if it had a gap the answer to "does
    // Synartesis interrupt me constantly" would be yes.
    const server = resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");
    const dir = mkdtempSync(join(tmpdir(), "synartesis-fscover-"));
    dirs.push(dir);
    const manifest = join(dir, "synartesis.yaml");
    writeFileSync(
      manifest,
      readFileSync("manifests/filesystem.yaml", "utf8")
        .replace(/^ {4}command:.*$/m, '    command: "node"')
        .replace(/^ {4}args:.*$/m, `    args: ["${server}", "${dir}"]`),
    );
    const checked = await run("node", [CLI, "check", "--manifest", manifest]);
    expect(checked.out).toContain("Every tool these servers offer has a policy");
  }, 30000);

  it("covers every tool the real memory server offers", async () => {
    // The second shipped policy whose undo is proven. If the server grows a
    // tool, this fails here rather than in front of somebody's agent.
    const server = resolve("node_modules/@modelcontextprotocol/server-memory/dist/index.js");
    const dir = mkdtempSync(join(tmpdir(), "synartesis-memcover-"));
    dirs.push(dir);
    process.env["MEMORY_FILE_PATH"] = join(dir, "memory.json");
    const manifest = join(dir, "synartesis.yaml");
    writeFileSync(
      manifest,
      readFileSync("manifests/memory.yaml", "utf8")
        .replace(/^ {4}command:.*$/m, '    command: "node"')
        .replace(/^ {4}args:.*$/m, `    args: ["${server}"]`),
    );
    const checked = await run("node", [CLI, "check", "--manifest", manifest]);
    expect(checked.out).toContain("Every tool these servers offer has a policy");
  }, 30000);

  it("names them in check rather than describing the rule", async () => {
    const space = workspace("send_email");
    const checked = await run("node", [CLI, "check", "--manifest", space.manifest]);

    // The tool itself, not a sentence about what happens to tools like it.
    expect(checked.out).toContain("send_email");
    expect(checked.out).toContain("no policy");
    // And not the two it does still claim, or the list means nothing.
    expect(checked.out).not.toContain("get_customer");
  }, 30000);

  it("names them at proxy startup, where the agent is about to meet them", async () => {
    const space = workspace("send_email");
    const started = await run("node", [
      PROXY, "--manifest", space.manifest, "--journal", join(space.dir, "journal.db"),
    ]);

    // level 40 is warn: this is the only line at startup that predicts an
    // interruption, and info would bury it among the ordinary ones.
    const logLine = z.looseObject({ level: z.number(), tools: z.array(z.string()) });
    const warned = started.err
      .split("\n")
      .filter((line) => line.includes("no policy covers"))
      .map((line) => logLine.parse(JSON.parse(line)));
    expect(warned).toHaveLength(1);
    expect(warned[0]?.level).toBe(40);
    expect(warned[0]?.tools).toEqual(["send_email"]);
  }, 30000);

  it("says so plainly when a policy leaves nothing uncovered", async () => {
    const space = workspace();
    const started = await run("node", [
      PROXY, "--manifest", space.manifest, "--journal", join(space.dir, "journal.db"),
    ]);
    expect(started.err).not.toContain("no policy covers");
    const ready = started.err
      .split("\n")
      .find((line) => line.includes("proxy ready"));
    // Counted either way. Absent, a policy with no gaps and a build that
    // forgot to look would read the same from here.
    expect(z.looseObject({ ungoverned: z.number() }).parse(JSON.parse(ready ?? "{}")).ungoverned)
      .toBe(0);
  }, 30000);
});
