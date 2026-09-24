import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { Upstream } from "../src/proxy/upstream.js";
import { startAll, startTogether } from "../src/proxy/upstream.js";

/**
 * Servers start together.
 *
 * Every path that starts more than one server waited for each before starting
 * the next. Three servers that each take 800ms to come up -- an npx server
 * resolving its package takes longer -- cost 2.4 seconds before the client got
 * a reply; now it is the slowest one.
 */

const CLI = resolve("dist/cli.js");
const SLOW = resolve("tests/helpers/slow-server.mjs");
const DELAY = 800;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function threeSlowServers(): { manifest: string; journal: string } {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-startup-"));
  dirs.push(dir);
  const server = (name: string): string =>
    `  ${name}:\n    command: node\n    args: ["${SLOW}", "--state", "${join(dir, `${name}.json`)}"]\n    env: { SLOW_SERVER_MS: "${String(DELAY)}" }\n`;
  const manifest = join(dir, "synartesis.yaml");
  writeFileSync(manifest, `version: 1\nservers:\n${server("a")}${server("b")}${server("c")}tools: []\n`);
  return { manifest, journal: join(dir, "journal.db") };
}

/** Milliseconds from starting the proxy to its answer to initialize. */
function timeToFirstAnswer(args: readonly string[]): Promise<number> {
  return new Promise((done, fail) => {
    const started = performance.now();
    const child = spawn("node", [CLI, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    child.on("error", fail);
    child.stdout.once("data", () => {
      done(performance.now() - started);
      child.kill();
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`,
    );
  });
}

describe("starting several servers", () => {
  it("costs the slowest one, not the sum of them", async () => {
    const { manifest, journal } = threeSlowServers();
    const took = await timeToFirstAnswer(["proxy", "--manifest", manifest, "--journal", journal]);
    // One after another this can be no less than 3 x 800ms, and measured
    // 2968ms. Together it is one delay plus the proxy's own start; the bound
    // sits under the sequential floor with room for a slow CI runner.
    expect(took).toBeLessThan(DELAY * 2.75);
  }, 30_000);

  it("closes the ones that started when one does not, and says which failed", async () => {
    const closed: string[] = [];
    const fake = (name: string): Upstream => ({
      name,
      client: new Client({ name: "never-connected", version: "0" }),
      close: () => {
        closed.push(name);
        return Promise.resolve();
      },
    });
    const attempt = startAll(["a", "b", "c"], (name) =>
      name === "b" ? Promise.reject(new Error("b would not start")) : Promise.resolve(fake(name)),
    );
    await expect(attempt).rejects.toThrow("b would not start");
    expect(closed.sort()).toEqual(["a", "c"]);
  });

  it("keeps the order they were asked for, whichever answered first", async () => {
    const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
    const { started } = await startTogether([30, 1, 15], async (ms) => {
      await wait(ms);
      return { name: String(ms), client: new Client({ name: "never-connected", version: "0" }), close: () => Promise.resolve() };
    });
    expect(started.map((one) => one.name)).toEqual(["30", "1", "15"]);
  });
});
