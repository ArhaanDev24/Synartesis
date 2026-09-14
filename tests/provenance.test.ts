import { describe, expect, it } from "vitest";

import { parseManifest } from "../src/manifest/load.js";
import { describeStanding, standing, untested, warnUntested } from "../src/manifest/standing.js";
import { knownPolicyFor } from "../src/init/known.js";
import { readFileSync } from "node:fs";

/** Env placeholders resolved so the file parses without a real setup. */
const read = (name: string): string =>
  readFileSync(`manifests/${name}.yaml`, "utf8").replace(/\$\{[A-Z_]+\}/g, "x");

const BASE = `version: 1
servers:
  a:
    command: "true"
`;

describe("what a policy claims about its own testing", () => {
  it("defaults to no claim, which is right for a policy somebody wrote", () => {
    const m = parseManifest(`${BASE}tools: []\n`, "m.yaml");
    expect(standing(m)).toEqual([{ server: "a", provenance: "unstated" }]);
    expect(untested(m)).toEqual([]);
  });

  it("carries live and documented through the loader", () => {
    const live = parseManifest(`${BASE}    provenance: live\ntools: []\n`, "m.yaml");
    const docs = parseManifest(`${BASE}    provenance: documented\ntools: []\n`, "m.yaml");
    expect(standing(live)[0]?.provenance).toBe("live");
    expect(standing(docs)[0]?.provenance).toBe("documented");
  });

  it("names only the untested ones", () => {
    const m = parseManifest(
      `version: 1
servers:
  a:
    command: "true"
    provenance: live
  b:
    command: "true"
    provenance: documented
  c:
    command: "true"
tools: []
`,
      "m.yaml",
    );
    // c has made no claim, so it is not accused of one.
    expect(untested(m)).toEqual(["b"]);
  });

  it("rejects a value that is neither", () => {
    expect(() => parseManifest(`${BASE}    provenance: probably\ntools: []\n`, "m.yaml")).toThrow();
  });

  it("says something for every state, so silence never reads as safe", () => {
    for (const provenance of ["live", "documented", "unstated"] as const) {
      expect(describeStanding({ server: "a", provenance }).length).toBeGreaterThan(10);
    }
    expect(describeStanding({ server: "a", provenance: "unstated" })).not.toBe(
      describeStanding({ server: "a", provenance: "live" }),
    );
  });

  it("warns about undo rather than about correctness", () => {
    const said = warnUntested(["github"]);
    expect(said).toContain("github");
    expect(said).toContain("undo may not work");
    expect(said).toContain("synartesis check");
  });

  it("reads as plural for several servers", () => {
    expect(warnUntested(["a", "b"])).toContain("these policies have");
    expect(warnUntested(["a"])).toContain("this policy has");
  });
});

describe("the shipped policies say where they stand", () => {
  it("marks every one of them", () => {
    for (const name of ["filesystem", "git", "memory", "github"]) {
      const m = parseManifest(read(name), `${name}.yaml`);
      expect(standing(m).every((entry) => entry.provenance !== "unstated")).toBe(true);
    }
  });

  it("only github claims to be untested, which matches its own header", () => {
    expect(untested(parseManifest(read("github"), "g.yaml"))).toEqual(["github"]);
    for (const name of ["filesystem", "git", "memory"]) {
      expect(untested(parseManifest(read(name), `${name}.yaml`))).toEqual([]);
    }
  });
});

describe("adopting a bundled policy carries the claim with it", () => {
  it("reads the claim off the bundled file", () => {
    expect(knownPolicyFor("node", ["x/server-filesystem/dist/index.js"])?.provenance).toBe("live");
    expect(knownPolicyFor("github-mcp-server", ["stdio"])?.provenance).toBe("documented");
    expect(knownPolicyFor("npx", ["-y", "@modelcontextprotocol/server-memory"])?.provenance).toBe(
      "live",
    );
  });

  it("is undefined for a server nothing ships for", () => {
    expect(knownPolicyFor("node", ["some-other-server.js"])).toBeUndefined();
  });
});
