import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManifestError } from "../src/errors.js";
import { loadManifest, parseManifest } from "../src/manifest/load.js";
import { upstreamEnv } from "../src/proxy/environment.js";

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

/**
 * A `verify:` read that names something that does not exist.
 *
 * Every other call in a policy is checked against the servers at load time,
 * because a mistyped tool name is indistinguishable at run time from the
 * resource simply not being there. `verify` was left out of that check, and it
 * is the one call whose failure is silent: the proxy catches it, appends "the
 * drift check could not be planned" to the action, and carries on -- so the
 * policy still loads, `synartesis check` still passes, and drift detection for
 * that tool quietly does not exist.
 */
const VERIFY = (block: string): string => `
version: 1
servers:
  crm:
    command: node
    args: ["dist/toy-crm.js"]
tools:
  - match: "crm.create_customer"
    class: compensable
    inverse:
      tool: "crm.delete_customer"
      args:
        id: "$result.id"
${block}
`;

describe("a verify read that names nothing real", () => {
  it("is refused when its server is not declared", () => {
    const thrown = expectRejection(
      VERIFY(`    verify:
      tool: "billing.get_customer"
      args:
        id: "$result.id"`),
    );
    expect(thrown.message).toContain("billing");
  });

  it("is refused when the tool is not qualified by a server", () => {
    const thrown = expectRejection(
      VERIFY(`    verify:
      tool: "get_customer"
      args:
        id: "$result.id"`),
    );
    expect(thrown.message.length).toBeGreaterThan(0);
  });

  it("is refused when it reads a namespace it cannot be given", () => {
    // A compensable tool declares no snapshot, so $snapshot. resolves to
    // nothing here however well-formed it looks.
    const thrown = expectRejection(
      VERIFY(`    verify:
      tool: "crm.get_customer"
      args:
        id: "$snapshot.id"`),
    );
    expect(thrown.message).toContain("$snapshot");
  });

  it("accepts one that names a declared server and a readable namespace", () => {
    expect(() =>
      parseManifest(
        VERIFY(`    verify:
      tool: "crm.get_customer"
      args:
        id: "$result.id"`),
        "manifest.yaml",
      ),
    ).not.toThrow();
  });
});

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
  const withEnv = (lines: readonly string[]): string =>
    [
      "version: 1",
      "servers:",
      "  api:",
      "    command: node",
      "    env:",
      ...lines,
      "tools: []",
    ].join("\n");

  it("keeps the reference as written, and fills it in when the server starts", () => {
    // Two shipped manifests tell people to write ${VAR} so a token never lands
    // in a file that gets committed. It is filled in at start, not at read,
    // so one server's missing token is not every server's problem.
    const manifest = parseManifest(
      withEnv([
        '      TOKEN: "${SYNARTESIS_TEST_TOKEN}"',
        '      MIXED: "Bearer ${SYNARTESIS_TEST_TOKEN}"',
        '      PLAIN: "left alone"',
      ]),
      "manifest.yaml",
    );
    const spec = manifest.servers["api"];
    if (spec === undefined) {
      throw new Error("no server");
    }
    expect(spec.env?.["TOKEN"]).toBe("${SYNARTESIS_TEST_TOKEN}");

    process.env["SYNARTESIS_TEST_TOKEN"] = "s3cret";
    try {
      expect(upstreamEnv("api", spec, { kind: "manifest" })).toEqual({
        TOKEN: "s3cret",
        MIXED: "Bearer s3cret",
        PLAIN: "left alone",
      });
    } finally {
      delete process.env["SYNARTESIS_TEST_TOKEN"];
    }
  });

  it("says which variable is missing, when the server that needs it starts", () => {
    delete process.env["SYNARTESIS_ABSENT"];
    const manifest = parseManifest(withEnv(['      TOKEN: "${SYNARTESIS_ABSENT}"']), "manifest.yaml");
    const spec = manifest.servers["api"];
    if (spec === undefined) {
      throw new Error("no server");
    }
    expect(() => upstreamEnv("api", spec, { kind: "manifest" })).toThrow(/SYNARTESIS_ABSENT/);
  });

  it("does not let one server's unset variable stop the policy loading", () => {
    // The shape of the bug: undo of a filesystem session refused because the
    // GitHub token was not exported in that terminal.
    delete process.env["SYNARTESIS_ONLY_GITHUB_NEEDS_THIS"];
    const manifest = parseManifest(
      [
        "version: 1",
        "servers:",
        "  fs:",
        "    command: node",
        "  github:",
        "    command: node",
        "    env:",
        '      TOKEN: "${SYNARTESIS_ONLY_GITHUB_NEEDS_THIS}"',
        "tools: []",
      ].join("\n"),
      "manifest.yaml",
    );
    const fs = manifest.servers["fs"];
    if (fs === undefined) {
      throw new Error("no server");
    }
    expect(() => upstreamEnv("fs", fs, { kind: "manifest" })).not.toThrow();
  });

  it("still refuses a malformed reference at load, with a line", () => {
    expect(() => parseManifest(withEnv(['      TOKEN: "${1BAD}"']), "manifest.yaml")).toThrow(
      /manifest\.yaml:\d+/,
    );
  });
});

describe("what a started server inherits", () => {
  const spec = { command: "node", args: [] } as const;

  it("inherits the proxy's environment under --server, minus the launcher's", () => {
    // SYNARTESIS_TOKEN is the proxy's own HTTP bearer; the npm ones were
    // measured -- npx adds twenty-six, and a server started through npx itself
    // would pick up npm_config_package and resolve the wrong thing.
    const saved = { ...process.env };
    process.env["SLACK_BOT_TOKEN"] = "xoxb-real";
    process.env["SYNARTESIS_TOKEN"] = "proxy-secret";
    process.env["npm_config_package"] = "synartesis";
    process.env["INIT_CWD"] = "/somewhere";
    try {
      const env = upstreamEnv("slack", spec, { kind: "inherit" }) ?? {};
      expect(env["SLACK_BOT_TOKEN"]).toBe("xoxb-real");
      expect(env["SYNARTESIS_TOKEN"]).toBeUndefined();
      expect(env["npm_config_package"]).toBeUndefined();
      expect(env["INIT_CWD"]).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  it("lets what the policy declares win over what was inherited", () => {
    const saved = { ...process.env };
    process.env["MEMORY_FILE_PATH"] = "/from/the/client";
    try {
      const env =
        upstreamEnv("memory", { ...spec, env: { MEMORY_FILE_PATH: "/from/the/policy" } }, {
          kind: "inherit",
        }) ?? {};
      expect(env["MEMORY_FILE_PATH"]).toBe("/from/the/policy");
    } finally {
      process.env = saved;
    }
  });

  it("puts the client entry's environment over the terminal's for an undo", () => {
    const saved = { ...process.env };
    process.env["AWS_PROFILE"] = "from-the-shell";
    try {
      const env =
        upstreamEnv("memory", spec, {
          kind: "client",
          env: { MEMORY_FILE_PATH: "/where/the/session/wrote" },
        }) ?? {};
      expect(env["MEMORY_FILE_PATH"]).toBe("/where/the/session/wrote");
      // The shell underneath, because the client passes its whole environment
      // on and a server that relied on it has to work under undo too.
      expect(env["AWS_PROFILE"]).toBe("from-the-shell");
    } finally {
      process.env = saved;
    }
  });

  it("gives the desktop window's servers only the entry, never its own environment", () => {
    const saved = { ...process.env };
    process.env["ANTHROPIC_API_KEY"] = "sk-the-persons-model-key";
    try {
      const env =
        upstreamEnv("memory", spec, { kind: "client", env: { MEMORY_FILE_PATH: "/x" }, own: false }) ?? {};
      expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(env["MEMORY_FILE_PATH"]).toBe("/x");
    } finally {
      process.env = saved;
    }
  });
});

describe("a template written the way another tool spells it", () => {
  const policy = (value: string): string => `version: 1
servers:
  crm:
    command: node
tools:
  - match: "crm.update_customer"
    class: reversible
    snapshot:
      tool: "crm.get_customer"
      args:
        id: "$.id"
      absent_when: "no customer"
    inverse:
      tool: "crm.update_customer"
      args:
        id: ${value}
`;

  it("refuses {{args.id}}, which was sent to the server as those characters", () => {
    const error = expectRejection(policy('"{{args.id}}"'));
    expect(error.message).toContain('write "$.id" instead');
    expect(error.message).toContain(":16");
  });

  it("refuses ${args.id} with the line it is on and the spelling that works", () => {
    const error = expectRejection(policy('"${snapshot.id}"'));
    expect(error.message).toContain('write "$snapshot.id" instead');
    expect(error.message).toContain(":16");
  });

  it("still loads the spelling that works", () => {
    expect(() => parseManifest(policy('"$.id"'), "manifest.yaml")).not.toThrow();
  });
});
