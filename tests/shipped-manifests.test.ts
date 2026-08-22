import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { parseManifest } from "../src/manifest/load.js";

describe("the manifests that ship with this", () => {
  it("does not call a move reversible, because it is only sometimes", () => {
    // Moving onto a file that already exists overwrites it, and moving back
    // restores the source while leaving nothing where the destination's
    // contents were. Declared reversible, undo reported rolled_back over a
    // file it had destroyed.
    const manifest = parseManifest(
      readFileSync("manifests/filesystem.yaml", "utf8"),
      "manifests/filesystem.yaml",
    );
    const move = manifest.tools.find((rule) => rule.match === "fs.move_file");
    expect(move?.class).not.toBe("reversible");
    expect(move?.gate).toBe("always");
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
