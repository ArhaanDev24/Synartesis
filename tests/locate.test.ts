import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findJournal, findManifest } from "../src/locate.js";

const originalCwd = process.cwd();
const dirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): string {
  // Resolved, because macOS reaches the same directory through /var and
  // /private/var and process.cwd() only ever reports the latter.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "synartesis-locate-")));
  dirs.push(dir);
  return dir;
}

describe("finding the policy and the journal", () => {
  it("uses what it was told, whatever else is lying around", () => {
    const dir = workspace();
    writeFileSync(join(dir, "synartesis.yaml"), "version: 1\n");
    process.chdir(dir);
    expect(findManifest("elsewhere.yaml")).toBe("elsewhere.yaml");
    expect(findJournal("elsewhere.db")).toBe("elsewhere.db");
  });

  it("finds a policy in the directory you are standing in", () => {
    const dir = workspace();
    const manifest = join(dir, "synartesis.yaml");
    writeFileSync(manifest, "version: 1\n");
    process.chdir(dir);
    expect(findManifest()).toBe(manifest);
  });

  it("finds one further up, the way a repo root is found", () => {
    const dir = workspace();
    const manifest = join(dir, "synartesis.yaml");
    writeFileSync(manifest, "version: 1\n");
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    expect(findManifest()).toBe(manifest);
  });

  it("prefers a journal already sitting beside the policy", () => {
    const dir = workspace();
    const manifest = join(dir, "synartesis.yaml");
    writeFileSync(manifest, "version: 1\n");
    const journal = join(dir, "journal.db");
    writeFileSync(journal, "");
    process.chdir(realpathSync(tmpdir()));
    expect(findJournal(undefined, manifest)).toBe(journal);
  });

  it("still finds the nested default an older setup uses", () => {
    const dir = workspace();
    mkdirSync(join(dir, ".synartesis"), { recursive: true });
    const journal = join(dir, ".synartesis", "journal.db");
    writeFileSync(journal, "");
    process.chdir(dir);
    expect(findJournal()).toBe(journal);
  });

  it("puts a journal that does not exist yet beside the policy", () => {
    const dir = workspace();
    const manifest = join(dir, "synartesis.yaml");
    writeFileSync(manifest, "version: 1\n");
    process.chdir(dir);
    // So the proxy that creates it and the cli that reads it agree without
    // either being told where to look.
    expect(findJournal(undefined, manifest)).toBe(join(dir, "journal.db"));
  });
});
