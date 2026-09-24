import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { openJournal } from "../src/journal/journal.js";

/**
 * One yes, many agents, one email.
 *
 * Several proxies share a journal: a person with two terminals, a client that
 * restarts, an agent that fans out. An approval is for one call. If eight
 * sessions retry that exact call in the same instant, each reading the
 * standing approval before any has spent it, exactly one may go through --
 * or one person's yes has sent eight irreversible emails. Separate processes,
 * started together, released together.
 */

const FIXTURE = resolve("dist/toy-crm.js");
const CLI = resolve("dist/cli.js");
const AGENTS = 8;
const ROUNDS = Number(process.env["SYNARTESIS_RACE_ROUNDS"] ?? "3");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function agent(manifest: string, journal: string): Promise<Client> {
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [CLI, "proxy", "--manifest", manifest, "--journal", journal],
      stderr: "ignore",
    }),
  );
  return client;
}

const email = { name: "send_email", arguments: { to: "ada@example.com", subject: "Once", body: "Only once." } };

describe("one approval, raced by many agents at once", () => {
  it(`sends exactly one email, over ${String(ROUNDS)} rounds of ${String(AGENTS)} agents`, async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const dir = mkdtempSync(join(tmpdir(), "synartesis-race-"));
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

      // Held once, approved once.
      const first = await agent(manifest, journal);
      await first.callTool(email).catch(() => undefined);
      await first.close();
      const opened = openJournal(journal);
      const held = opened.listGated()[0]?.id ?? "";
      opened.close();
      const approved = spawnSync("node", [CLI, "approve", held, "--by", "arhaan", "--unattended", "--journal", journal], {
        encoding: "utf8",
      });
      expect(approved.status).toBe(0);

      // Every agent connected and waiting before any of them asks.
      const agents = await Promise.all(Array.from({ length: AGENTS }, () => agent(manifest, journal)));
      const results = await Promise.all(
        agents.map((one) =>
          one.callTool(email).then(
            (result) => (result.isError === true ? "error" : "sent"),
            (error: unknown) => (String(error).includes("holding this call") ? "held" : `threw: ${String(error)}`),
          ),
        ),
      );
      await Promise.all(agents.map((one) => one.close()));

      const outbox = z.object({ outbox: z.array(z.unknown()) }).parse(JSON.parse(readFileSync(state, "utf8"))).outbox;
      expect({ round, sent: results.filter((one) => one === "sent").length, results }).toMatchObject({ round, sent: 1 });
      expect(outbox, `round ${String(round)}: ${results.join(", ")}`).toHaveLength(1);
      // The rest were told to wait, not lost in an error.
      expect(results.filter((one) => one === "held")).toHaveLength(AGENTS - 1);
    }
  }, 600_000);
});
