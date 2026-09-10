import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { openJournal, type Journal } from "../src/journal/journal.js";
import { loadManifest, parseManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { connectStdioUpstream, type Upstream } from "../src/proxy/upstream.js";
import { rollback } from "../src/rollback/rollback.js";
import { inspect } from "../src/rollback/inspect.js";
import { autoApproveGate } from "./helpers/harness.js";

/**
 * What the shipped filesystem policy actually does, against the real server.
 *
 * Everything else about recovery is checked against a fixture this repository
 * also writes, which proves the engine and nothing about the policies. A
 * policy that names a real tool and resolves a subtly wrong inverse produces a
 * confident, verified-looking, wrong undo -- the state matched, the inverse
 * went out, the report says success. Drift detection cannot catch that,
 * because nothing was wrong with the drift.
 *
 * So this makes the mutation, undoes it, and compares bytes. It is the only
 * thing in the suite entitled to say the filesystem adapter works.
 */

const FS_SERVER = resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");

/**
 * The version these guarantees were established against. A server that has
 * changed its tools or its error strings has not been tested here, whatever
 * this file says.
 */
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
}

/** The shipped policy, pointed at a directory that exists only for this test. */
async function bench(options: { realGate?: boolean } = {}): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "synartesis-fs-adapter-"));
  dirs.push(root);
  const journal = openJournal(join(root, "journal.db"));
  closers.push(() => {
    journal.close();
  });

  const shipped = readFileSync("manifests/filesystem.yaml", "utf8");
  const source = shipped.replace(
    /servers:\n  fs:\n    command:.*\n    args:.*\n/,
    `servers:\n  fs:\n    command: "node"\n    args: ["${FS_SERVER}", "${root}"]\n`,
  );
  const manifest = parseManifest(source, "manifests/filesystem.yaml");

  const upstream: Upstream = await connectStdioUpstream({
    name: "fs",
    command: "node",
    args: [FS_SERVER, root],
    stderr: "ignore",
  });
  closers.push(() => upstream.close());

  const proxy = createProxyServer({
    upstreams: [upstream],
    manifest,
    journal,
    // The real gate refuses and waits to be asked again, which is what a
    // person actually meets. Most cases here are about restoration, so they
    // take the instant yes instead.
    ...(options.realGate === true ? {} : { gate: autoApproveGate }),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "adapter", version: "0" });
  await Promise.all([proxy.server.connect(st), client.connect(ct)]);
  closers.push(async () => {
    await client.close();
  });
  const runId = await proxy.ready;
  return { client, journal, router: createRouter([upstream], manifest), runId, root };
}

describe(`the shipped filesystem policy, against server ${TESTED_AGAINST}`, () => {
  it("restores an overwritten file byte for byte", async () => {
    const active = await bench();
    const path = join(active.root, "notes.md");
    const original = "# Notes\n\nline one\nline two\néè unicode, and a trailing space \n";
    writeFileSync(path, original);

    await active.client.callTool({
      name: "write_file",
      arguments: { path, content: "destroyed\n" },
    });
    expect(readFileSync(path, "utf8")).toBe("destroyed\n");

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });

    expect(report.status).toBe("rolled_back");
    // Bytes, not "looks right". Trailing whitespace and non-ascii included,
    // because those are what a lossy snapshot quietly drops.
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("restores after several writes to the same file", async () => {
    const active = await bench();
    const path = join(active.root, "log.txt");
    const original = "first\n";
    writeFileSync(path, original);

    for (const content of ["second\n", "third\n", "fourth\n"]) {
      await active.client.callTool({ name: "write_file", arguments: { path, content } });
    }

    const preview = await rollback({
      journal: active.journal, router: active.router, runId: active.runId, dryRun: true,
    });
    expect(preview.halted).toBeUndefined();

    const report = await rollback({
      journal: active.journal, router: active.router, runId: active.runId,
    });
    expect(report.status).toBe("rolled_back");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("refuses to undo over an edit somebody else made", async () => {
    const active = await bench();
    const path = join(active.root, "shared.txt");
    writeFileSync(path, "original\n");
    await active.client.callTool({ name: "write_file", arguments: { path, content: "agent\n" } });

    writeFileSync(path, "a colleague wrote this\n");

    const report = await rollback({
      journal: active.journal, router: active.router, runId: active.runId,
    });
    expect(report.status).toBe("partial");
    expect(readFileSync(path, "utf8")).toBe("a colleague wrote this\n");
  });

  it("tells absence apart from a read that failed", async () => {
    const active = await bench({ realGate: true });
    const path = join(active.root, "fresh.txt");

    // The file does not exist, so the pre-read reports absence -- which this
    // policy declares. There is nothing to restore, so the write is held
    // rather than pretended to be reversible: this server has no delete.
    const created = await active.client
      .callTool({ name: "write_file", arguments: { path, content: "new\n" } })
      .catch((error: unknown) => error);

    const message = created instanceof Error ? created.message : JSON.stringify(created);
    expect(message).toMatch(/approval|cannot be undone|nothing was captured/i);
    // And it really was held: nothing was written.
    expect(existsSync(path)).toBe(false);
  });

  it("reports an untouched file as unchanged, and a touched one as changed", async () => {
    const active = await bench();
    const quiet = join(active.root, "quiet.txt");
    const touched = join(active.root, "touched.txt");
    writeFileSync(quiet, "before\n");
    writeFileSync(touched, "before\n");
    await active.client.callTool({ name: "write_file", arguments: { path: quiet, content: "after\n" } });
    await active.client.callTool({ name: "write_file", arguments: { path: touched, content: "after\n" } });

    writeFileSync(touched, "somebody else\n");

    const found = await inspect({
      journal: active.journal, router: active.router, runId: active.runId,
    });
    const byFile = new Map(
      found.resources.map((r) => [r.seq, r.condition] as const),
    );
    expect(byFile.get(1)).toBe("unchanged");
    expect(byFile.get(2)).toBe("changed");
  });

  it("is the policy that actually ships, not one written for this test", () => {
    // The bench rewrites only the command that starts the server. If the
    // shipped rules changed, these guarantees are about nothing.
    const shipped = loadManifest("manifests/filesystem.yaml");
    const write = shipped.tools.find((tool) => tool.match === "fs.write_file");
    expect(write?.class).toBe("reversible");
    expect(write?.snapshot?.tool).toBe("fs.read_text_file");
    expect(write?.snapshot?.absentWhen ?? []).not.toHaveLength(0);
  });
});
