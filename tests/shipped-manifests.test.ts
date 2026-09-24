import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

import { parseManifest } from "../src/manifest/load.js";
import { createPolicyResolver } from "../src/manifest/match.js";
import { knownPolicyFor } from "../src/init/known.js";

/** Read from the directory, so a policy added later cannot be left out of these. */
const SHIPPED = readdirSync("manifests")
  .filter((file) => file.endsWith(".yaml"))
  .map((file) => file.slice(0, -".yaml".length));

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
    for (const name of SHIPPED) {
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
    for (const name of SHIPPED) {
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

describe.each([
  {
    name: "playwright",
    fixture: "fixtures/playwright-mcp-1.64.0-tools.txt",
    held: ["browser_run_code_unsafe", "browser_evaluate", "browser_file_upload", "browser_drop"],
  },
  {
    name: "chrome-devtools",
    fixture: "fixtures/chrome-devtools-mcp-1.10.1-tools.txt",
    held: ["evaluate_script", "upload_file"],
  },
])("the $name policy, against what the server actually exposes", ({ name, fixture, held }) => {
  // Each line is a tool name and whether the server marks it read-only, from
  // the real server's tools/list at the version the policy was written for.
  const exposed = new Map(
    readFileSync(fixture, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [tool = "", how = ""] = line.split(" ");
        return [tool, how === "read"] as const;
      }),
  );
  const path = `manifests/${name}.yaml`;
  const manifest = parseManifest(readFileSync(path, "utf8"), path);
  const resolver = createPolicyResolver(manifest);

  it("never lets code or a file from your disk through without a person", () => {
    // Recording rather than holding is right for a click. It is not for
    // running code the agent wrote, or sending a file off this machine.
    for (const tool of held) {
      expect(exposed.has(tool), tool).toBe(true);
      expect(resolver.resolve(`${name}.${tool}`).policy.gate, tool).toBe("always");
    }
  });

  it("has a rule for every tool, so none is held by accident or let through by one", () => {
    for (const tool of exposed.keys()) {
      expect(resolver.resolve(`${name}.${tool}`).matched, tool).toBe(true);
    }
    for (const rule of manifest.tools) {
      expect(rule.match.includes("*"), `${rule.match} is a pattern`).toBe(false);
      expect(exposed.has(rule.match.slice(name.length + 1)), rule.match).toBe(true);
    }
  });

  it("classes as a read exactly what the server marks read-only", () => {
    for (const [tool, read] of exposed) {
      expect(resolver.resolve(`${name}.${tool}`).policy.class === "readonly", tool).toBe(read);
    }
  });

  it("records everything else as a call that cannot be undone", () => {
    for (const [tool, read] of exposed) {
      if (!read) {
        expect(resolver.resolve(`${name}.${tool}`).policy.class, tool).toBe("irreversible");
      }
    }
  });
});

describe("the read-only pack", () => {
  // Each started for real and its tools/list read; every tool it offered is a
  // read. Several do not mark their tools read-only, so before these every
  // search was held.
  const probed = readFileSync("fixtures/read-only-pack-tools.txt", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [server = "", tool = ""] = line.split(" ");
      return [server, tool] as const;
    });

  it("covers every tool each server offers, as a read", () => {
    for (const [server, tool] of probed) {
      const path = `manifests/${server}.yaml`;
      const found = createPolicyResolver(parseManifest(readFileSync(path, "utf8"), path)).resolve(
        `${server}.${tool}`,
      );
      expect(found.matched, `${server}.${tool}`).toBe(true);
      expect(found.policy.class, `${server}.${tool}`).toBe("readonly");
    }
  });

  it("is what install adopts for each", () => {
    for (const [command, args, name] of [
      ["uvx", ["mcp-server-fetch"], "fetch"],
      ["npx", ["-y", "@brave/brave-search-mcp-server"], "brave"],
      ["npx", ["-y", "exa-mcp-server"], "exa"],
      ["npx", ["-y", "tavily-mcp@latest"], "tavily"],
      ["uvx", ["awslabs.aws-documentation-mcp-server@latest"], "aws-docs"],
    ] as const) {
      expect(knownPolicyFor(command, args)?.name).toBe(name);
    }
  });
});
