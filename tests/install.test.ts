import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ConfigError,
  readDocument,
  readServers,
  saveServers,
  serversAt,
  withServers,
  writeDocument,
  type ConfigSite,
} from "../src/install/clients.js";
import {
  applyInstall,
  applyUninstall,
  isWrapped,
  keyFor,
  planInstall,
  readRecord,
} from "../src/install/install.js";

/**
 * Installing rewrites a file the user did not open, in an application they did
 * not start. What is asserted here is mostly what must NOT happen to it.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-install-"));
  dirs.push(dir);
  return dir;
}

/**
 * Drafting a policy starts the server to ask what tools it has, so these are
 * real servers against a real directory rather than names in a fixture.
 *
 * The local build, the way tests/init.test.ts does it, not `npx -y`. On a cold
 * CI runner npx fetches the package first and the test times out; nothing here
 * is about whether a download works.
 */
const FS_SERVER = resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");

function configFor(dir: string): Record<string, unknown> {
  return {
    coworkUserFilesPath: "/somewhere/else",
    preferences: { theme: "dark", nested: { kept: true } },
    mcpServers: {
      filesystem: { command: "node", args: [FS_SERVER, dir] },
      // A second entry so the multi-server behaviour is covered. It is the
      // same server under another name, which is all these assertions need.
      notes: { command: "node", args: [FS_SERVER, dir], env: { NOTE: join(dir, "n.json") } },
      remote: { type: "http", url: "https://example.com/mcp" },
    },
  };
}

function siteIn(dir: string, config: unknown = configFor(dir)): ConfigSite {
  const path = join(dir, "claude_desktop_config.json");
  writeFileSync(path, `${JSON.stringify(config, undefined, 2)}\n`);
  return {
    client: "claude-desktop",
    label: "Claude Desktop",
    format: "json",
    path,
    scope: "global",
    at: ["mcpServers"],
  };
}

describe("planning an install", () => {
  it("adopts the policy that ships, rather than drafting TODOs for a server we know", async () => {
    const dir = scratch();
    const { plans } = await planInstall([siteIn(dir)], join(dir, "synartesis.yaml"));
    const byName = new Map(plans[0]?.servers.map((server) => [server.name, server]));
    expect(byName.get("filesystem")?.adopted).toBe("filesystem");
    expect(byName.get("notes")?.adopted).toBe("filesystem");
  });

  it("leaves a remote server alone, because the upstream here is a process", async () => {
    const dir = scratch();
    const { plans } = await planInstall([siteIn(dir)], join(dir, "synartesis.yaml"));
    expect(plans[0]?.servers.map((server) => server.name)).not.toContain("remote");
    expect(plans[0]?.skipped.map((skip) => skip.name)).toContain("remote");
  });
});

describe("installing and uninstalling", () => {
  it("puts the config back exactly as it was", async () => {
    const dir = scratch();
    const site = siteIn(dir);
    const before = readFileSync(site.path, "utf8");
    const manifest = join(dir, "synartesis.yaml");

    const { plans, yaml } = await planInstall([site], manifest);
    applyInstall(plans, manifest, yaml);
    expect(readFileSync(site.path, "utf8")).not.toBe(before);

    applyUninstall([site], manifest);
    // Compared as data: the write reformats, and what matters is the content.
    expect(JSON.parse(readFileSync(site.path, "utf8"))).toEqual(JSON.parse(before));
  });

  it("keeps every key that is nothing to do with us", async () => {
    const dir = scratch();
    const site = siteIn(dir);
    const manifest = join(dir, "synartesis.yaml");
    const { plans, yaml } = await planInstall([site], manifest);
    applyInstall(plans, manifest, yaml);

    const after: unknown = JSON.parse(readFileSync(site.path, "utf8"));
    expect(after).toMatchObject({
      coworkUserFilesPath: "/somewhere/else",
      preferences: { theme: "dark", nested: { kept: true } },
    });
  });

  it("carries the server's own env onto the entry that replaces it", async () => {
    const dir = scratch();
    const site = siteIn(dir);
    const manifest = join(dir, "synartesis.yaml");
    const { plans, yaml } = await planInstall([site], manifest);
    applyInstall(plans, manifest, yaml);

    const servers = readServers(readDocument(site), site.at);
    expect(servers["notes"]?.env).toEqual({ NOTE: join(dir, "n.json") });
  });

  it("gives each server its own --server, so no tool is renamed", async () => {
    const dir = scratch();
    const site = siteIn(dir);
    const manifest = join(dir, "synartesis.yaml");
    const { plans, yaml } = await planInstall([site], manifest);
    applyInstall(plans, manifest, yaml);

    // A proxy carrying two servers has to qualify tool names to keep them
    // apart. One entry per server is what keeps the names the agent knows.
    const servers = readServers(readDocument(site), site.at);
    for (const name of ["filesystem", "notes"]) {
      const args = servers[name]?.args ?? [];
      expect(args).toContain("--server");
      expect(args[args.indexOf("--server") + 1]).toBe(name);
    }
  });

  it("does nothing the second time", async () => {
    const dir = scratch();
    const site = siteIn(dir);
    const manifest = join(dir, "synartesis.yaml");
    const first = await planInstall([site], manifest);
    applyInstall(first.plans, manifest, first.yaml);
    const settled = readFileSync(site.path, "utf8");

    const second = await planInstall([site], manifest);
    expect(second.plans[0]?.servers).toHaveLength(0);
    applyInstall(second.plans, manifest, second.yaml);
    expect(readFileSync(site.path, "utf8")).toBe(settled);
  });

  it("backs the original up before writing", async () => {
    const dir = scratch();
    const site = siteIn(dir);
    const before = readFileSync(site.path, "utf8");
    const manifest = join(dir, "synartesis.yaml");
    const { plans, yaml } = await planInstall([site], manifest);
    const [applied] = applyInstall(plans, manifest, yaml);
    expect(readFileSync(applied?.backup ?? "", "utf8")).toBe(before);
  });

  it("leaves a wrapped entry it cannot restore, rather than deleting a server", async () => {
    const dir = scratch();
    const site = siteIn(dir);
    const manifest = join(dir, "synartesis.yaml");
    const { plans, yaml } = await planInstall([site], manifest);
    applyInstall(plans, manifest, yaml);

    // The record is what says how to put things back. Losing it must not turn
    // uninstall into something that removes servers.
    rmSync(join(dir, "installed.json"));
    const [restored] = applyUninstall([site], manifest);
    expect(restored?.servers).toHaveLength(0);
    expect(restored?.unknown).toEqual(expect.arrayContaining(["filesystem", "notes"]));
    const servers = readServers(readDocument(site), site.at);
    expect(Object.keys(servers)).toEqual(expect.arrayContaining(["filesystem", "notes"]));
  });
});

describe("the record's key", () => {
  /**
   * This one is here because it was wrong. `status` spelled the key itself
   * with spaces while the record was written with another separator, so every
   * server it had just installed came back reported as unrecorded.
   */
  it("tells two servers apart even where paths and scopes contain spaces", () => {
    const a: ConfigSite = {
      client: "claude-desktop",
      label: "Claude Desktop",
      format: "json",
      path: "/Application Support/c.json",
      scope: "global x",
      at: ["mcpServers"],
    };
    const b: ConfigSite = { ...a, path: "/Application", scope: "Support/c.json global" };
    expect(keyFor(a, "fs")).not.toBe(keyFor(b, "fs"));
  });

  it("is the same string the record was written under", async () => {
    const dir = scratch();
    const site = siteIn(dir);
    const manifest = join(dir, "synartesis.yaml");
    const { plans, yaml } = await planInstall([site], manifest);
    applyInstall(plans, manifest, yaml);
    expect(Object.keys(readRecord(manifest).wrapped)).toContain(keyFor(site, "filesystem"));
  });
});

describe("refusing rather than repairing", () => {
  it("will not rewrite a config it cannot parse", () => {
    const dir = scratch();
    const path = join(dir, "claude_desktop_config.json");
    writeFileSync(path, '{ "mcpServers": { oops }');
    const site: ConfigSite = {
      client: "claude-desktop",
      label: "Claude Desktop",
      format: "json",
      path,
      scope: "global",
      at: ["mcpServers"],
    };
    expect(() => readDocument(site)).toThrow(ConfigError);
    // Untouched: a file we did not understand is not one to write over.
    expect(readFileSync(path, "utf8")).toBe('{ "mcpServers": { oops }');
  });

  it("treats a config with no server list as having none, not as an error", () => {
    const dir = scratch();
    const site = siteIn(dir, { preferences: { theme: "dark" } });
    expect(readServers(readDocument(site), site.at)).toEqual({});
  });
});

describe("recognising our own entry", () => {
  it("knows the forms install writes and the one a person pasted", () => {
    expect(isWrapped({ command: "synartesis", args: ["proxy", "--manifest", "/x"] })).toBe(true);
    expect(isWrapped({ command: "npx", args: ["-y", "synartesis", "proxy"] })).toBe(true);
    expect(isWrapped({ command: "node", args: ["/some/dist/cli.js", "proxy"] })).toBe(true);
    expect(isWrapped({ command: "npx", args: ["-y", "@modelcontextprotocol/server-git"] })).toBe(false);
  });
});

describe("writing a nested server list", () => {
  it("changes only the map named, leaving every sibling intact", () => {
    const document = {
      projects: {
        "/a": { mcpServers: { one: { command: "x" } }, history: [1, 2, 3] },
        "/b": { mcpServers: { two: { command: "y" } } },
      },
      numStartups: 41,
    };
    const next = withServers(document, ["projects", "/a", "mcpServers"], {
      one: { command: "wrapped" },
    });
    expect(next).toEqual({
      projects: {
        "/a": { mcpServers: { one: { command: "wrapped" } }, history: [1, 2, 3] },
        "/b": { mcpServers: { two: { command: "y" } } },
      },
      numStartups: 41,
    });
  });

  it("lands by rename, so a config is never half-written", () => {
    const dir = scratch();
    const site = siteIn(dir);
    writeDocument(site, { ...configFor(dir), mcpServers: {} });
    // Whatever else happened, what is on disk parses.
    expect(() => {
      JSON.parse(readFileSync(site.path, "utf8"));
    }).not.toThrow();
  });
});

/**
 * Codex keeps its servers in TOML. What matters is not that the servers can be
 * read, but that a file full of things which are nothing to do with us --
 * comments, plugin tables, a long env subtable -- comes back unharmed.
 */
// The startable server is the real one, for the same reason the JSON
// fixtures use it: drafting a policy starts it to ask what tools it has.
const CODEX = `model = "gpt-5.6-sol"

# A comment somebody wrote and would like to keep.
[marketplaces.bundled]
source_type = "local"

[mcp_servers.node_repl]
args = []
command = "SERVER_COMMAND"
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/someone/.codex"
NODE_REPL_TRUSTED_SERVICES = '{"browser":"/x/y.mjs"}'

[mcp_servers.off]
command = "./relative/thing"
args = ["mcp"]
enabled = false

[shell_environment_policy.set]
SOMETHING = "kept"
`;

function codexTextFor(dir: string): string {
  return CODEX.replace("SERVER_COMMAND", "node").replace("args = []", `args = ["${FS_SERVER}", "${dir}"]`);
}

function codexSiteIn(dir: string, text = codexTextFor(dir)): ConfigSite {
  const path = join(dir, "config.toml");
  writeFileSync(path, text);
  return { client: "codex", label: "Codex", format: "toml", path, scope: "global", at: ["mcp_servers"] };
}

describe("a client that keeps its servers in TOML", () => {
  it("reads the servers, and knows which one is switched off", () => {
    const site = codexSiteIn(scratch());
    const servers = serversAt(site);
    expect(Object.keys(servers).sort()).toEqual(["node_repl", "off"]);
    expect(servers["node_repl"]?.command).toBe("node");
    expect(servers["off"]?.enabled).toBe(false);
  });

  it("does not treat the env subtable as a server", () => {
    const site = codexSiteIn(scratch());
    expect(Object.keys(serversAt(site))).not.toContain("node_repl.env");
  });

  it("changes only the two lines it means to", () => {
    const dir = scratch();
    const site = codexSiteIn(dir);
    saveServers(site, {
      ...serversAt(site),
      node_repl: { command: "synartesis", args: ["proxy", "--server", "node_repl"] },
    });

    const after = readFileSync(site.path, "utf8");
    const changed = codexTextFor(dir)
      .split("\n")
      .filter((line, index) => after.split("\n")[index] !== line);
    expect(changed).toHaveLength(2);
    // Everything a serialiser would have thrown away.
    expect(after).toContain("# A comment somebody wrote and would like to keep.");
    expect(after).toContain('NODE_REPL_TRUSTED_SERVICES = \'{"browser":"/x/y.mjs"}\'');
    expect(after).toContain("[shell_environment_policy.set]");
    expect(after).toContain("startup_timeout_sec = 120");
  });

  it("comes back byte for byte after a round trip", async () => {
    const dir = scratch();
    const site = codexSiteIn(dir);
    const before = readFileSync(site.path, "utf8");
    const manifest = join(dir, "synartesis.yaml");

    const { plans, yaml } = await planInstall([site], manifest);
    applyInstall(plans, manifest, yaml);
    expect(readFileSync(site.path, "utf8")).not.toBe(before);

    applyUninstall([site], manifest);
    expect(readFileSync(site.path, "utf8")).toBe(before);
  });

  it("leaves a server that is switched off alone", async () => {
    const dir = scratch();
    const site = codexSiteIn(dir);
    const { plans } = await planInstall([site], join(dir, "synartesis.yaml"));
    expect(plans[0]?.skipped.map((skip) => skip.name)).toContain("off");
  });
});
