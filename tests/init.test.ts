import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseManifest } from "../src/manifest/load.js";
import { draftManifest } from "../src/init/draft.js";

const FIXTURE = resolve("dist/toy-crm.js");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-init-"));
  dirs.push(dir);
  return dir;
}

describe("drafting a manifest", () => {
  it("produces a manifest that loads", async () => {
    const yaml = (await draftManifest({ name: "crm", command: "node", args: [FIXTURE] })).yaml;
    const manifest = parseManifest(yaml, "drafted.yaml");
    expect(Object.keys(manifest.servers)).toEqual(["crm"]);
    expect(manifest.tools.map((t) => t.match).sort()).toEqual([
      "crm.create_customer",
      "crm.delete_customer",
      "crm.get_customer",
      "crm.restore_customer",
      "crm.send_email",
      "crm.update_customer",
    ]);
  });

  it("classifies everything it cannot vouch for as irreversible and gated", async () => {
    const manifest = parseManifest(
      (await draftManifest({ name: "crm", command: "node", args: [FIXTURE] })).yaml,
      "drafted.yaml",
    );
    const byMatch = new Map(manifest.tools.map((t) => [t.match, t]));
    // D4: a drafted manifest must be safe before it is convenient. Nothing is
    // assumed reversible just because a name looks harmless.
    expect(byMatch.get("crm.update_customer")?.class).toBe("irreversible");
    expect(byMatch.get("crm.delete_customer")?.gate).toBe("always");
  });

  it("trusts a server's own readOnlyHint, and says that it did", async () => {
    const yaml = (await draftManifest({ name: "crm", command: "node", args: [FIXTURE] })).yaml;
    const manifest = parseManifest(yaml, "drafted.yaml");
    const read = manifest.tools.find((t) => t.match === "crm.get_customer");
    expect(read?.class).toBe("readonly");
    expect(yaml).toContain("readOnlyHint");
  });

  it("records how to start the server so the manifest is self-contained", async () => {
    const yaml = (await draftManifest({ name: "crm", command: "node", args: [FIXTURE] })).yaml;
    const manifest = parseManifest(yaml, "drafted.yaml");
    expect(manifest.servers["crm"]?.command).toBe("node");
    expect(manifest.servers["crm"]?.args).toEqual([FIXTURE]);
  });

  it("leaves each tool's description in the file so the author knows what it does", async () => {
    const yaml = (await draftManifest({ name: "crm", command: "node", args: [FIXTURE] })).yaml;
    expect(yaml).toContain("Delete a customer");
    expect(yaml).toContain("TODO");
  });

  it("refuses to invent a policy for a server it cannot reach", async () => {
    await expect(
      draftManifest({ name: "crm", command: "node", args: [join(tempDir(), "missing.js")] }),
    ).rejects.toThrow();
  });

  it("merges into an existing manifest instead of discarding it", async () => {
    const dir = tempDir();
    const existing = join(dir, "synartesis.yaml");
    writeFileSync(
      existing,
      `version: 1
servers:
  other: { command: node, args: ["other.js"] }
tools:
  - match: "other.ping"
    class: readonly
`,
    );
    const yaml = (await draftManifest({
      name: "crm",
      command: "node",
      args: [FIXTURE],
      existing: readFileSync(existing, "utf8"),
    })).yaml;
    const manifest = parseManifest(yaml, "merged.yaml");
    expect(Object.keys(manifest.servers).sort()).toEqual(["crm", "other"]);
    expect(manifest.tools.some((t) => t.match === "other.ping")).toBe(true);
    expect(manifest.tools.some((t) => t.match === "crm.get_customer")).toBe(true);
  });
});

describe("a server we already have a finished policy for", () => {
  const FS_SERVER = resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");

  it("uses it, instead of asking for fourteen TODOs to be filled in", async () => {
    // The whole barrier to getting value out of this is writing snapshot and
    // inverse for every write tool. For the servers most people start with,
    // that work is already done and shipped in manifests/ -- and init was
    // making them do it again from scratch.
    const dir = tempDir();
    const yaml = (await draftManifest({
      name: "files",
      command: "node",
      args: [FS_SERVER, dir],
    })).yaml;
    const manifest = parseManifest(yaml, "drafted.yaml");
    const byMatch = new Map(manifest.tools.map((t) => [t.match, t]));

    const write = byMatch.get("files.write_file");
    expect(write?.class).toBe("reversible");
    expect(write?.snapshot).toBeDefined();
    expect(write?.inverse).toBeDefined();
    // Renamed to whatever the person called the server, not left as fs.
    expect(yaml).not.toContain("fs.write_file");
    expect(yaml).not.toContain("TODO");
  });

  it("still gates what the bundled policy says cannot be undone", async () => {
    const dir = tempDir();
    const manifest = parseManifest(
      (await draftManifest({ name: "files", command: "node", args: [FS_SERVER, dir] })).yaml,
      "drafted.yaml",
    );
    const byMatch = new Map(manifest.tools.map((t) => [t.match, t]));
    // Adopting a known policy must not quietly turn a gate off.
    expect(byMatch.get("files.move_file")?.gate).toBe("always");
    expect(byMatch.get("files.create_directory")?.class).toBe("irreversible");
  });

  it("leaves an unknown server exactly as it was", async () => {
    const manifest = parseManifest(
      (await draftManifest({ name: "crm", command: "node", args: [FIXTURE] })).yaml,
      "drafted.yaml",
    );
    const byMatch = new Map(manifest.tools.map((t) => [t.match, t]));
    expect(byMatch.get("crm.update_customer")?.class).toBe("irreversible");
  });
});
