import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { parseManifest } from "../src/manifest/load.js";
import { createPolicyResolver } from "../src/manifest/match.js";

describe("the manifests that ship with this", () => {
  it("never calls a move plainly reversible, because it is only sometimes", () => {
    // Moving onto a file that already exists overwrites it, and moving back
    // restores the source while leaving nothing where the destination's
    // contents were. Declared plainly reversible, undo reported rolled_back
    // over a file it had destroyed -- measured, not supposed.
    //
    // It is reversible now, but only under `expect: absent`, which is what
    // makes the pre-read decide between the two cases. Take that one line out
    // and the rule reverts to exactly the bug above, so it is the line this
    // test is really about.
    const manifest = parseManifest(
      readFileSync("manifests/filesystem.yaml", "utf8"),
      "manifests/filesystem.yaml",
    );
    const move = manifest.tools.find((rule) => rule.match === "fs.move_file");
    if (move?.class === "reversible") {
      expect(move.snapshot?.expect).toBe("absent");
      // And the inverse must work from the arguments alone: under expect:
      // absent there is no captured state, so a $snapshot. reference would
      // resolve to nothing and the move would silently lose its inverse.
      expect(JSON.stringify(move.inverse?.args)).not.toContain("$snapshot");
    } else {
      expect(move?.gate).toBe("always");
    }
  });

  it("says what absence looks like wherever it takes a snapshot", () => {
    // A snapshot with no absent_when has to read every failed pre-read as
    // "there is nothing here", so a resource that exists and cannot be read is
    // offered for approval as a creation. That was fixed for files and left
    // undone for github, which has three snapshots of its own.
    process.env["GITHUB_PERSONAL_ACCESS_TOKEN"] = "test-token";
    process.env["MEMORY_FILE_PATH"] = "/tmp/memory.json";
    for (const name of ["filesystem", "git", "github", "memory", "toy-crm"]) {
      const path = `manifests/${name}.yaml`;
      const manifest = parseManifest(readFileSync(path, "utf8"), path);
      for (const rule of manifest.tools) {
        if (rule.snapshot === undefined) {
          continue;
        }
        expect(rule.snapshot.absentWhen, `${name}: ${rule.match}`).toBeDefined();
        expect(rule.snapshot.absentWhen?.length, `${name}: ${rule.match}`).toBeGreaterThan(0);
      }
    }
  });

  it("loads every manifest it ships", () => {
    // The two that read the environment say so plainly when it is not set,
    // which is the behaviour, not a fault; supplied here so the rest of each
    // file is still checked.
    process.env["GITHUB_PERSONAL_ACCESS_TOKEN"] = "test-token";
    process.env["MEMORY_FILE_PATH"] = "/tmp/memory.json";
    for (const name of ["filesystem", "git", "github", "memory", "toy-crm"]) {
      const path = `manifests/${name}.yaml`;
      expect(() => parseManifest(readFileSync(path, "utf8"), path)).not.toThrow();
    }
  });
});

describe("what the published package carries", () => {
  it("leaves the fixtures behind", () => {
    // The toy CRM and the demo agent exist to make this repo's walkthrough
    // work, and that walkthrough is explicitly run from a clone. Shipping them
    // to everyone who installs puts a server and a harness on their disk that
    // nothing in the package can use -- and a policy pointing at a binary that
    // is not there.
    const pkg: unknown = JSON.parse(readFileSync("package.json", "utf8"));
    const files =
      typeof pkg === "object" && pkg !== null && "files" in pkg && Array.isArray(pkg.files)
        ? pkg.files.map(String)
        : [];
    expect(files).toContain("!dist/toy-crm.*");
    expect(files).toContain("!dist/demo-agent.*");
    // Source maps are generated for local development and never shipped:
    // nothing enables them at runtime, so they were 385kB of an install
    // that Node never read.
    expect(files).toContain("!dist/*.map");
    expect(files).toContain("!manifests/toy-crm.yaml");
    // And the things a user does need are still declared.
    expect(files).toContain("dist");
    expect(files).toContain("manifests");
  });
});

describe("the github policy, against what v1.12 actually exposes", () => {
  // The tool list is copied from github-mcp-server's own README at v1.12.2,
  // the version the policy was written for. 1.12 renamed the tools the old
  // policy used, and a policy naming tools that do not exist took GitHub down
  // for everyone who had wrapped it. This fails if that happens again.
  const exposed = new Set(
    readFileSync("fixtures/github-mcp-server-1.12.2-tools.txt", "utf8").split("\n").filter(Boolean),
  );
  process.env["GITHUB_PERSONAL_ACCESS_TOKEN"] ??= "test-token";
  const manifest = parseManifest(readFileSync("manifests/github.yaml", "utf8"), "manifests/github.yaml");
  const resolver = createPolicyResolver(manifest);

  it("calls only tools the server has", () => {
    for (const rule of manifest.tools) {
      for (const call of [rule.snapshot?.tool, rule.inverse?.tool, rule.verify?.tool]) {
        if (call !== undefined) {
          expect(exposed.has(call.replace(/^github\./, "")), `${rule.match} calls ${call}`).toBe(true);
        }
      }
      if (!rule.match.includes("*")) {
        expect(exposed.has(rule.match.replace(/^github\./, "")), rule.match).toBe(true);
      }
    }
  });

  it("holds the tool that creates as well as updates, and the write that looks like a read", () => {
    expect(resolver.resolve("github.issue_write").policy.gate).toBe("always");
    // Ends in _read, marks notifications read: a write.
    expect(resolver.resolve("github.mark_all_notifications_read").policy.class).toBe("irreversible");
    expect(resolver.resolve("github.issue_read").policy.class).toBe("readonly");
    expect(resolver.resolve("github.projects_get").policy.class).toBe("readonly");
  });

  it("classes every tool ending in _read, _get or _list as a read only if it is one", () => {
    // A suffix rule is a guess about names, so every tool it catches is
    // listed here and checked against what it does.
    const writesNamedLikeReads = new Set(["mark_all_notifications_read"]);
    for (const tool of exposed) {
      if (/_(read|get|list)$/.test(tool)) {
        const cls = resolver.resolve(`github.${tool}`).policy.class;
        expect(cls, tool).toBe(writesNamedLikeReads.has(tool) ? "irreversible" : "readonly");
      }
    }
  });
});
