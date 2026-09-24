import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ToyCrmStore } from "../fixtures/toy-crm/store.js";

/**
 * `kill -9` on an undo, again and again, with real processes.
 *
 * The in-process stress test can only pretend to crash: it throws. This one
 * sends SIGKILL to `synartesis undo` at a random moment -- while it starts
 * the server, while it reads, between claiming an action and sending its
 * inverse, after sending it -- and starts it again, the way a person whose
 * terminal died would. However many times that happens, the store must end
 * up exactly as it was before the agent touched it, with nothing applied
 * twice.
 */

const FIXTURE = resolve("dist/toy-crm.js");
const CLI = resolve("dist/cli.js");
const ROUNDS = Number(process.env["SYNARTESIS_KILL_ROUNDS"] ?? "3");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly killed: boolean;
}

/** How far an undo has got: rows it has finished, and rows it has claimed. */
function progress(journal: string): number {
  const db = new Database(journal, { readonly: true, fileMustExist: true });
  try {
    return z
      .object({ n: z.number() })
      .parse(db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status IN ('rolled_back', 'rolling_back')").get()).n;
  } finally {
    db.close();
  }
}

/**
 * Runs the CLI and SIGKILLs it the moment `killAt` more actions have been
 * claimed or undone. Watching the journal rather than a clock is what puts
 * the kill inside the undo: the whole walk takes milliseconds after a start-up
 * that takes far longer, so a timer almost always fires in the start-up.
 */
function undo(args: readonly string[], journal: string, killAt: number | undefined): Promise<Ran> {
  return new Promise((done) => {
    const from = progress(journal);
    const child = spawn("node", [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let killed = false;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", () => undefined);
    const watch =
      killAt === undefined
        ? undefined
        : setInterval(() => {
            if (!killed && progress(journal) - from >= killAt) {
              killed = true;
              child.kill("SIGKILL");
            }
          }, 1);
    child.on("close", (code) => {
      if (watch !== undefined) {
        clearInterval(watch);
      }
      done({ code, stdout, killed });
    });
  });
}

async function session(dir: string, state: string, manifest: string, journal: string): Promise<void> {
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [CLI, "proxy", "--manifest", manifest, "--journal", journal],
      stderr: "ignore",
    }),
  );
  const ids = ["c_001", "c_002", "c_003"];
  for (let i = 0; i < 120; i += 1) {
    await client.callTool({
      name: "update_customer",
      arguments: { id: ids[i % 3], notes: `pass ${String(i)} ${"~".repeat((i % 24) * 40)}`, plan: i % 2 === 0 ? "free" : "enterprise" },
    });
  }
  for (let i = 0; i < 5; i += 1) {
    await client.callTool({
      name: "create_customer",
      arguments: { name: `Made ${String(i)}`, email: `m${String(i)}@e.x`, plan: "pro", notes: "made" },
    });
  }
  await client.callTool({ name: "delete_customer", arguments: { id: "c_002" } });
  await client.callTool({ name: "update_customer", arguments: { id: "c_001", name: "Renamed at the end" } });
  await client.close();
  void dir;
}

describe("undo, killed with SIGKILL at random moments and run again", () => {
  it(`ends exactly where the agent started, over ${String(ROUNDS)} rounds`, async () => {
    const seeded = new ToyCrmStore().__snapshot().customers;
    for (let round = 1; round <= ROUNDS; round += 1) {
      const dir = mkdtempSync(join(tmpdir(), "synartesis-kill-"));
      dirs.push(dir);
      const state = join(dir, "crm.json");
      const manifest = join(dir, "synartesis.yaml");
      const journal = join(dir, "journal.db");
      writeFileSync(
        manifest,
        readFileSync("manifests/toy-crm.yaml", "utf8").replace(
          'args: ["dist/toy-crm.js"]',
          `args: ["${FIXTURE}", "--state", "${state}"]`,
        ),
      );
      await session(dir, state, manifest, journal);

      const pick = random(round * 2654435761);
      const args = ["undo", "--manifest", manifest, "--journal", journal];
      const outcomes: string[] = [];
      let finished = false;
      for (let attempt = 0; attempt < 30 && !finished; attempt += 1) {
        // Killed on most attempts, at a random point from start-up to the
        // last inverse; the last few are left to finish.
        const kill = attempt < 12 && pick() < 0.85 ? Math.floor(pick() * 30) : undefined;
        const ran = await undo(args, journal, kill);
        outcomes.push(`${ran.killed ? `killed@${String(kill)}` : `exit ${String(ran.code)}`} (${String(progress(journal))} undone)`);
        finished = !ran.killed && ran.code === 0 && ran.stdout.includes("all undone");
        if (!ran.killed && !finished && process.env["SYNARTESIS_KILL_TRACE"] !== undefined) {
          console.log(ran.stdout.split("\n").filter((line) => /stopped|halted|R E S U L T|reason|lease|still running|sent/.test(line)).slice(0, 8).join("\n"));
          break;
        }
      }

      const now = z.object({ customers: z.unknown() }).parse(JSON.parse(readFileSync(state, "utf8")));
      if (process.env["SYNARTESIS_KILL_TRACE"] !== undefined) {
        console.log(`round ${String(round)}: ${outcomes.join(", ")}`);
      }
      expect({ round, finished, outcomes }).toMatchObject({ round, finished: true });
      expect(now.customers, `round ${String(round)}: ${outcomes.join(", ")}`).toEqual(seeded);
    }
  }, 900_000);
});
