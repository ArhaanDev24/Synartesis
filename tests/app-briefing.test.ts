import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { briefing, CHARTER, noteFor } from "../app/main/briefing.js";
import { parseManifest } from "../src/manifest/load.js";
import { startEngine, type Engine } from "../app/main/engine.js";
import type { Manifest } from "../src/manifest/types.js";

/**
 * What the model is told before anybody says anything.
 *
 * A model arrives knowing how to call tools and nothing about why these ones
 * behave the way they do -- so a held call reads as a malfunction and it goes
 * looking for a way around it. That is the one behaviour this product cannot
 * tolerate, and it is not the model's fault. These tests are about it being
 * told, in terms that are true of the engine actually running.
 */

const FS_SERVER = resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MANIFEST: Manifest = {
  version: 1,
  servers: { fs: { command: "node", args: [] }, crm: { command: "node", args: [] } },
  tools: [
    { match: "fs.read_file", class: "readonly", gate: "never", refusal: "uncertain" },
    { match: "fs.write_file", class: "reversible", gate: "never", refusal: "uncertain" },
    { match: "fs.move_file", class: "irreversible", gate: "always", refusal: "uncertain" },
  ],
};

describe("a server the policy names but nothing is running", () => {
  it("is not announced to the model as connected", () => {
    const said = briefing({
      manifest: parseManifest(
        `version: 1\nservers:\n  fs:\n    command: node\n    args: ["x.js"]\n` +
          `  crm:\n    command: node\n    args: ["y.js"]\ntools: []\n`,
        "m.yaml",
      ),
      session: "0123456789abcdef",
      toolset: (bare) => `synartesis__${bare}`,
      down: ["fs"],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    // The list came straight off the manifest, so a server that failed to
    // start was announced as connected and the model planned around tools
    // that were not there.
    expect(said).toContain("Connected: crm");
    expect(said).not.toContain("Connected: crm, fs");
    expect(said).toContain("Not running: fs");
    expect(said).toContain("Do not plan to use their tools");
  });
});

describe("the briefing", () => {
  it("names the servers, the session and the calls that will stop", () => {
    const said = briefing({
      manifest: MANIFEST,
      session: "0f3a12c9-aaaa-bbbb-cccc-dddddddddddd",
      toolset: (bare) => `synartesis__${bare}`,
      now: new Date("2026-09-13T10:00:00Z"),
    });

    expect(said).toContain(CHARTER);
    expect(said).toContain("Connected: crm, fs");
    expect(said).toContain("session 0f3a12c9");
    // The particular is the point: "some calls are held" cannot be planned
    // around, and a model that knows which ones will stop can pick a route
    // that does not.
    expect(said).toContain("Held for approval: fs.move_file");
    expect(said).not.toContain("fs.read_file,");
    expect(said).toContain("synartesis__undo_session");
    expect(said).toContain("13 September 2026");
  });

  it("says so when there is nothing to act with, rather than implying there is", () => {
    const said = briefing({
      manifest: { version: 1, servers: {}, tools: [] },
      session: "abcdef12",
      toolset: (bare) => bare,
      now: new Date("2026-09-13T10:00:00Z"),
    });
    expect(said).toContain("No servers are connected");
    expect(said).not.toContain("Held for approval");
  });

  it("forbids the workaround in as many words", () => {
    // The single most important sentence in the prompt. A model that reroutes
    // around a held call makes every promise the window shows a lie.
    expect(CHARTER).toMatch(/[Nn]ever\s+look for a different tool/);
    expect(CHARTER).toContain("held");
  });
});

describe("what a tool says about itself", () => {
  it("tells the truth about each of the four classes", () => {
    expect(noteFor("readonly", "never", true)).toContain("read-only");
    expect(noteFor("reversible", "never", true)).toContain("can be put back");
    expect(noteFor("compensable", "never", true)).toContain("further call");
    expect(noteFor("irreversible", "always", true)).toContain("cannot be undone");
    expect(noteFor("irreversible", "always", true)).toContain("held");
    // A write-gated tool is held only sometimes, and saying "always" would
    // teach a model to avoid a tool it is free to use for reads.
    expect(noteFor("compensable", "on_write", true)).toContain("when it would change something");
    expect(noteFor("readonly", "never", true)).not.toContain("held");
  });

  it("says an undescribed tool is treated as the worst case, because it is", () => {
    const said = noteFor("irreversible", "always", false);
    expect(said).toContain("not described in the policy");
    expect(said).toContain("held");
  });
});

describe("a real engine, telling a model what it is holding", () => {
  it("puts the class on every tool it offers", async () => {
    const root = mkdtempSync(join(tmpdir(), "synartesis-briefing-"));
    dirs.push(root);
    const manifestPath = join(root, "synartesis.yaml");
    writeFileSync(
      manifestPath,
      readFileSync("manifests/filesystem.yaml", "utf8").replace(
        /servers:\n  fs:\n    command:.*\n    args:.*\n/,
        `servers:\n  fs:\n    command: "node"\n    args: ["${FS_SERVER}", "${root}"]\n`,
      ),
    );
    const engine: Engine = await startEngine({
      manifestPath,
      journalPath: join(root, "journal.db"),
      label: "briefing-test",
      gateTimeoutMs: 300,
    });
    closers.push(() => engine.close());

    const tools = await engine.tools();
    expect(tools.length).toBeGreaterThan(5);
    // Every one of them, including the ones Synartesis supplies itself.
    for (const tool of tools) {
      expect(tool.description).toContain("[Synartesis:");
    }

    const of = (bare: string): string =>
      tools.find((tool) => tool.name.endsWith(bare))?.description ?? "";

    expect(of("read_file")).toContain("read-only");
    expect(of("write_file")).toContain("can be put back");
    // move_file is reversible now, but only where the destination is free --
    // `expect: absent` decides that from the pre-read, per call, so the model
    // is told what the class says and the proxy holds the calls that turn out
    // not to qualify.
    expect(of("move_file")).toContain("can be put back");
    // create_directory still stops and waits: the filesystem server offers no
    // rmdir, so a directory once made cannot be taken back by anything it has.
    expect(of("create_directory")).toContain("held for the person's approval");
    expect(of("undo_session")).toContain("held for the person's approval");
    expect(of("what_changed")).toContain("read-only");
    // And the server's own words are still there.
    expect(of("read_file").length).toBeGreaterThan(noteFor("readonly", "never", true).length + 20);
  });
});
