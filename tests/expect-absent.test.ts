/**
 * A pre-read whose job is to find nothing.
 *
 * Every other pre-read is a before-image: it captures what a call is about to
 * replace, and finding nothing means there is nothing to put back. For a
 * handful of calls that reading is exactly inverted — moving a file onto a
 * free path is undone by moving it back, and it is finding *something* there
 * that puts the call beyond undo, because one inverse cannot both move the
 * file back and restore what it landed on.
 *
 * Both halves were measured against the real server before this existed. As a
 * plain reversible rule, the safe move came back `partial` with the file still
 * moved, and the dangerous one came back `rolled_back` with the overwritten
 * file gone — a confident wrong undo, which is the one thing this must never
 * do. `expect: absent` is what tells the two apart.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { openJournal, type ActionRow, type Journal } from "../src/journal/journal.js";
import { parseManifest } from "../src/manifest/load.js";
import { ManifestError } from "../src/errors.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { connectStdioUpstream } from "../src/proxy/upstream.js";
import { rollback } from "../src/rollback/rollback.js";
import type { Gate } from "../src/gate/gate.js";
import { autoApproveGate } from "./helpers/harness.js";

const FS_SERVER = resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");
const TESTED_AGAINST = "2026.7.10";

const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Bench {
  readonly client: Client;
  readonly journal: Journal;
  readonly router: Router;
  readonly runId: string;
  readonly root: string;
  rows(): readonly ActionRow[];
}

/** The shipped policy, pointed at a directory that exists only for this test. */
async function bench(gate: Gate = autoApproveGate): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "synartesis-absent-"));
  dirs.push(root);
  const journal = openJournal(join(root, "journal.db"));
  closers.push(() => {
    journal.close();
  });
  const manifest = parseManifest(
    readFileSync("manifests/filesystem.yaml", "utf8").replace(
      /servers:\n  fs:\n    command:.*\n    args:.*\n/,
      `servers:\n  fs:\n    command: "node"\n    args: ["${FS_SERVER}", "${root}"]\n`,
    ),
    "manifests/filesystem.yaml",
  );
  const upstream = await connectStdioUpstream({
    name: "fs",
    command: "node",
    args: [FS_SERVER, root],
    stderr: "ignore",
  });
  closers.push(() => upstream.close());
  const proxy = createProxyServer({ upstreams: [upstream], manifest, journal, gate });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "absent", version: "0" });
  await Promise.all([proxy.server.connect(st), client.connect(ct)]);
  closers.push(async () => {
    await client.close();
  });
  const runId = await proxy.ready;
  return {
    client,
    journal,
    router: createRouter([upstream], manifest),
    runId,
    root,
    rows: () => journal.getActions(runId),
  };
}

const refuse: Gate = {
  decide: async () =>
    await Promise.resolve({ approved: false, awaiting: true, reason: "ask a person" }),
};

describe(`moving a file, against server ${TESTED_AGAINST}`, () => {
  it("is undone when the destination was free", async () => {
    const live = await bench();
    const from = join(live.root, "one.txt");
    const to = join(live.root, "two.txt");
    writeFileSync(from, "hello\n");

    await live.client.callTool({
      name: "move_file",
      arguments: { source: from, destination: to },
    });
    expect(existsSync(to)).toBe(true);
    expect(existsSync(from)).toBe(false);

    // Recorded as recoverable, which it was not before: the pre-read found
    // nothing, and that used to mean "there is nothing to put back".
    const row = live.rows()[0];
    expect(row?.status).toBe("applied");
    expect(row?.inverse).toBeDefined();

    const report = await rollback({
      journal: live.journal,
      router: live.router,
      runId: live.runId,
    });
    expect(report.status).toBe("rolled_back");
    expect(readFileSync(from, "utf8")).toBe("hello\n");
    expect(existsSync(to)).toBe(false);
  }, 30000);

  it("is held when something is already at the destination", async () => {
    const live = await bench(refuse);
    const from = join(live.root, "one.txt");
    const to = join(live.root, "two.txt");
    writeFileSync(from, "source\n");
    writeFileSync(to, "PRECIOUS\n");

    const attempt = await live.client
      .callTool({ name: "move_file", arguments: { source: from, destination: to } })
      .catch((error: unknown) => error);

    expect(String(attempt)).toContain("holding this call for approval");
    // The whole point of holding it: the file is still there to argue about.
    expect(readFileSync(to, "utf8")).toBe("PRECIOUS\n");
    expect(readFileSync(from, "utf8")).toBe("source\n");
  }, 30000);

  it("records no inverse when a person allows the overwrite anyway", async () => {
    const live = await bench();
    const from = join(live.root, "one.txt");
    const to = join(live.root, "two.txt");
    writeFileSync(from, "source\n");
    writeFileSync(to, "PRECIOUS\n");

    await live.client.callTool({
      name: "move_file",
      arguments: { source: from, destination: to },
    });

    // The overwrite really happened, despite this server describing move_file
    // as failing when the destination exists. It renames over the top, because
    // that is what rename(2) does. Pinned here so a version that starts
    // matching its own documentation shows up as a failing test rather than a
    // surprise in somebody's undo.
    expect(readFileSync(to, "utf8")).toBe("source\n");
    expect(existsSync(from)).toBe(false);

    // This is the failure that made the naive version dangerous: with an
    // inverse, undo moves the file back, says `rolled_back`, and PRECIOUS is
    // gone for good. Without one, undo says it cannot be undone and leaves it.
    const row = live.rows()[0];
    expect(row?.status).toBe("applied");
    expect(row?.inverse).toBeUndefined();
    expect(row?.error).toContain("expected nothing and found something");

    const report = await rollback({
      journal: live.journal,
      router: live.router,
      runId: live.runId,
    });
    expect(report.status).toBe("partial");
    expect(report.steps.some((step) => step.kind === "permanent")).toBe(true);
    // And it did not quietly move anything back over the top.
    expect(readFileSync(to, "utf8")).toBe("source\n");
  }, 30000);

  it("still refuses to step over an edit made since", async () => {
    // `verify` survives the absent pre-read, so drift detection still works
    // on a move -- which it would not if absence had cleared the read the way
    // a genuinely missing prior state does.
    const live = await bench();
    const from = join(live.root, "one.txt");
    const to = join(live.root, "two.txt");
    writeFileSync(from, "hello\n");
    await live.client.callTool({
      name: "move_file",
      arguments: { source: from, destination: to },
    });

    writeFileSync(to, "somebody else got here first\n");
    const report = await rollback({
      journal: live.journal,
      router: live.router,
      runId: live.runId,
    });
    expect(report.halted).toBeDefined();
    expect(readFileSync(to, "utf8")).toBe("somebody else got here first\n");
  }, 30000);
});

describe("what a policy may say about a read that expects nothing", () => {
  const POLICY = (block: string): string => `
version: 1
servers:
  fs:
    command: node
    args: ["x.js"]
tools:
  - match: "fs.read_text_file"
    class: readonly
${block}
`;

  function refused(block: string): string {
    try {
      parseManifest(POLICY(block), "p.yaml");
    } catch (error: unknown) {
      if (error instanceof ManifestError) {
        return error.message;
      }
    }
    throw new Error("expected a refusal");
  }

  it("refuses an inverse that reads a snapshot there cannot be", () => {
    // Under expect: absent nothing is captured, so $snapshot. resolves to
    // nothing at run time and the action is silently recorded with no
    // inverse -- a reversible tool that is quietly not.
    expect(
      refused(`  - match: "fs.move_file"
    class: reversible
    snapshot:
      tool: "fs.read_text_file"
      args: { path: "$.destination" }
      expect: absent
    inverse:
      tool: "fs.write_file"
      args: { path: "$.source", content: "$snapshot.content" }`),
    ).toContain("$snapshot");
  });

  it("refuses it on a class where it means nothing", () => {
    expect(
      refused(`  - match: "fs.move_file"
    class: irreversible
    snapshot:
      tool: "fs.read_text_file"
      args: { path: "$.destination" }
      expect: absent`),
    ).toContain("reversible");
  });

  it("refuses it on a verify read, which runs too late to expect anything", () => {
    expect(
      refused(`  - match: "fs.move_file"
    class: compensable
    inverse:
      tool: "fs.move_file"
      args: { source: "$.destination", destination: "$.source" }
    verify:
      tool: "fs.read_text_file"
      args: { path: "$.destination" }
      expect: absent`),
    ).toContain("expect belongs on a snapshot");
  });
});
