import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManifestError } from "../src/errors.js";
import { loadManifest, parseManifest } from "../src/manifest/load.js";

const VALID = `
version: 1
servers:
  crm:
    command: node
    args: ["dist/toy-crm.js"]
tools:
  - match: "crm.get_customer"
    class: readonly
  - match: "crm.update_customer"
    class: reversible
    snapshot:
      tool: "crm.get_customer"
      args:
        id: "$.id"
    inverse:
      tool: "crm.update_customer"
      args:
        id: "$.id"
        plan: "$snapshot.plan"
  - match: "crm.create_customer"
    class: compensable
    inverse:
      tool: "crm.delete_customer"
      args:
        id: "$result.id"
  - match: "crm.send_*"
    class: irreversible
`;

function expectRejection(source: string): ManifestError {
  const thrown = ((): unknown => {
    try {
      return parseManifest(source, "manifest.yaml");
    } catch (error: unknown) {
      return error;
    }
  })();
  expect(thrown).toBeInstanceOf(ManifestError);
  if (!(thrown instanceof ManifestError)) {
    throw new Error("unreachable");
  }
  return thrown;
}

describe("manifest loading", () => {
  it("parses a well-formed manifest", () => {
    const manifest = parseManifest(VALID, "manifest.yaml");
    expect(Object.keys(manifest.servers)).toEqual(["crm"]);
    expect(manifest.servers["crm"]?.command).toBe("node");
    expect(manifest.tools.map((t) => t.match)).toEqual([
      "crm.get_customer",
      "crm.update_customer",
      "crm.create_customer",
      "crm.send_*",
    ]);
  });

  it("defaults gate to always for irreversible and never for everything else", () => {
    const manifest = parseManifest(VALID, "manifest.yaml");
    const gates = Object.fromEntries(manifest.tools.map((t) => [t.match, t.gate]));
    // D4: an irreversible action is gated unless the manifest says otherwise.
    expect(gates["crm.send_*"]).toBe("always");
    expect(gates["crm.get_customer"]).toBe("never");
    expect(gates["crm.update_customer"]).toBe("never");
  });

  it("names the line of a YAML syntax error", () => {
    const error = expectRejection("version: 1\nservers:\n  crm:\n   - a\n  b: [\n");
    expect(error.message).toMatch(/manifest\.yaml:\d+:\d+/);
  });

  it("names the line of a schema violation", () => {
    const source = `version: 1
servers:
  crm:
    command: node
    args: []
tools:
  - match: "crm.a"
    class: readonly
  - match: "crm.b"
    class: teleporting
`;
    const error = expectRejection(source);
    // "teleporting" is on line 10 and the message has to say so.
    expect(error.message).toContain("manifest.yaml:10");
    expect(error.message).toContain("class");
  });

  it("rejects an unsupported version", () => {
    expect(expectRejection(VALID.replace("version: 1", "version: 2")).message).toContain("version");
  });

  it("rejects unknown keys rather than ignoring them", () => {
    const error = expectRejection(VALID.replace('    class: readonly', '    class: readonly\n    clas: reversible'));
    expect(error.message).toContain("clas");
  });

  it("requires a snapshot only when the inverse actually reads one", () => {
    const needsOne = `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.update_customer"
    class: reversible
    inverse:
      tool: "crm.update_customer"
      args: { id: "$.id", plan: "$snapshot.plan" }
`;
    expect(expectRejection(needsOne).message).toMatch(/snapshot/);

    // Some actions are reversible from their arguments alone: the inverse of
    // moving a file from A to B is moving it from B to A, and no pre-read
    // could add anything.
    const argsOnly = `version: 1
servers: { fs: { command: node, args: [] } }
tools:
  - match: "fs.move_file"
    class: reversible
    inverse:
      tool: "fs.move_file"
      args: { source: "$.destination", destination: "$.source" }
`;
    expect(parseManifest(argsOnly, "manifest.yaml").tools).toHaveLength(1);

    const noInverse = `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.update_customer"
    class: reversible
    snapshot:
      tool: "crm.get_customer"
      args: { id: "$.id" }
`;
    expect(expectRejection(noInverse).message).toMatch(/inverse/);
  });

  it("requires an inverse for a compensable tool", () => {
    const source = `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.create_customer"
    class: compensable
`;
    expect(expectRejection(source).message).toMatch(/inverse/);
  });

  it("rejects an inverse on a readonly or irreversible tool", () => {
    const readonlyInverse = `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.get_customer"
    class: readonly
    inverse:
      tool: "crm.update_customer"
      args: { id: "$.id" }
`;
    expect(expectRejection(readonlyInverse).message).toMatch(/inverse/);
  });

  it("rejects a snapshot or inverse pointing at an undeclared server", () => {
    const source = `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.create_customer"
    class: compensable
    inverse:
      tool: "billing.refund"
      args: { id: "$result.id" }
`;
    const error = expectRejection(source);
    expect(error.message).toContain("billing");
  });

  it("rejects a $snapshot reference when no snapshot is declared", () => {
    const source = `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.create_customer"
    class: compensable
    inverse:
      tool: "crm.delete_customer"
      args: { id: "$snapshot.id" }
`;
    expect(expectRejection(source).message).toMatch(/\$snapshot/);
  });

  it("rejects duplicate match patterns as ambiguous", () => {
    const source = `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.a"
    class: readonly
  - match: "crm.a"
    class: irreversible
`;
    expect(expectRejection(source).message).toMatch(/duplicate/i);
  });

  it("rejects a match that names no server", () => {
    const source = `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "get_customer"
    class: readonly
`;
    expect(expectRejection(source).message).toMatch(/server/);
  });

  it("requires at least one server", () => {
    expect(expectRejection("version: 1\nservers: {}\ntools: []\n").message).toMatch(/server/);
  });

  it("reports a missing file as a manifest error, not a raw ENOENT", () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-manifest-"));
    expect(() => loadManifest(join(dir, "nope.yaml"))).toThrow(ManifestError);
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-manifest-"));
    const path = join(dir, "synartesis.yaml");
    writeFileSync(path, VALID);
    expect(loadManifest(path).tools).toHaveLength(4);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("environment for a server", () => {
  it("takes the value from the shell rather than passing the reference on", () => {
    // Two shipped manifests tell people to write ${VAR} so a token never lands
    // in a file that gets committed. If nothing expands it, what reaches the
    // server is the six characters of the reference.
    process.env["SYNARTESIS_TEST_TOKEN"] = "s3cret";
    try {
      const manifest = parseManifest(
        [
          "version: 1",
          "servers:",
          "  api:",
          "    command: node",
          "    env:",
          '      TOKEN: "${SYNARTESIS_TEST_TOKEN}"',
          '      MIXED: "Bearer ${SYNARTESIS_TEST_TOKEN}"',
          '      PLAIN: "left alone"',
          "tools: []",
        ].join("\n"),
        "manifest.yaml",
      );
      expect(manifest.servers["api"]?.env).toEqual({
        TOKEN: "s3cret",
        MIXED: "Bearer s3cret",
        PLAIN: "left alone",
      });
    } finally {
      delete process.env["SYNARTESIS_TEST_TOKEN"];
    }
  });

  it("says which variable is missing rather than starting a server without it", () => {
    delete process.env["SYNARTESIS_ABSENT"];
    expect(() =>
      parseManifest(
        [
          "version: 1",
          "servers:",
          "  api:",
          "    command: node",
          "    env:",
          '      TOKEN: "${SYNARTESIS_ABSENT}"',
          "tools: []",
        ].join("\n"),
        "manifest.yaml",
      ),
    ).toThrow(/SYNARTESIS_ABSENT/);
  });
});
