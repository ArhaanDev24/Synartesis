import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

import Database from "better-sqlite3";
import { join } from "node:path";

import { openJournal } from "../src/journal/journal.js";
import { findJournal, findManifest, home } from "../src/locate.js";

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

describe("when the work is not happening in a project at all", () => {
  const savedHome = process.env["SYNARTESIS_HOME"];

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env["SYNARTESIS_HOME"];
    } else {
      process.env["SYNARTESIS_HOME"] = savedHome;
    }
  });

  it("falls back to one home, so nothing has to be set up per directory", () => {
    const home = workspace();
    const elsewhere = workspace();
    process.env["SYNARTESIS_HOME"] = home;
    process.chdir(elsewhere);

    // Nothing here and nothing above it. Requiring a directory per server is
    // how a home fills up with synartesis-this and synartesis-that.
    expect(findManifest()).toBe(join(home, "synartesis.yaml"));
    expect(findJournal(undefined, findManifest())).toBe(join(home, "journal.db"));
  });

  it("still prefers a policy belonging to the directory you are in", () => {
    const home = workspace();
    const project = workspace();
    process.env["SYNARTESIS_HOME"] = home;
    writeFileSync(join(home, "synartesis.yaml"), "version: 1\n");
    writeFileSync(join(project, "synartesis.yaml"), "version: 1\n");
    process.chdir(project);

    expect(findManifest()).toBe(join(project, "synartesis.yaml"));
  });
});

describe("files found by walking up that belong to someone else", () => {
  it("are passed over, so a policy planted in a shared directory is never used", () => {
    // On a shared machine /tmp is writable by anybody. A policy planted there
    // names the commands the proxy starts.
    const dir = workspace();
    const inner = join(dir, "project");
    mkdirSync(inner);
    writeFileSync(join(dir, "synartesis.yaml"), "version: 1\n");
    process.chdir(inner);
    const real = process.getuid?.bind(process);
    if (real === undefined) {
      return;
    }
    const spy = vi.spyOn(process, "getuid").mockReturnValue(real() + 1);
    try {
      expect(findManifest()).not.toBe(join(dir, "synartesis.yaml"));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("SYNARTESIS_HOME set to nothing", () => {
  it("is the same as unset, not the current directory", () => {
    const saved = process.env["SYNARTESIS_HOME"];
    process.env["SYNARTESIS_HOME"] = "";
    try {
      expect(home()).toBe(join(homedir(), ".synartesis"));
    } finally {
      if (saved === undefined) {
        delete process.env["SYNARTESIS_HOME"];
      } else {
        process.env["SYNARTESIS_HOME"] = saved;
      }
    }
  });
});

describe("a database that is somebody else's, at a journal's path", () => {
  it("is refused and left exactly as it was", () => {
    const dir = workspace();
    const path = join(dir, "journal.db");
    const other = new Database(path);
    other.exec("CREATE TABLE photos (id INTEGER)");
    other.close();
    const before = readFileSync(path);
    expect(() => openJournal(path)).toThrow(/not a Synartesis journal/);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});
