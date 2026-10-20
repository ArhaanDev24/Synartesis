import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError } from "../src/install/clients.js";
import { clientEnvFor, clientEnvsFor } from "../src/install/entry-env.js";
import { declaredNames, upstreamEnv } from "../src/proxy/environment.js";

/**
 * What undo starts a server with, read from the client entry that wraps it.
 *
 * Only ever exercised through a spawned CLI before, which coverage cannot see
 * and which never reached the refusal: two entries wrapping one server with
 * different settings are two different stores sharing a name, and undoing one
 * with the other's settings acts on the wrong one.
 */

const dirs: string[] = [];
let saved: string | undefined;
afterEach(() => {
  process.env["HOME"] = saved;
  delete process.env["SYN_ENTRY_TOKEN"];
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-entry-"));
  dirs.push(dir);
  saved = process.env["HOME"];
  process.env["HOME"] = dir;
  return dir;
}

const MANIFEST = "/work/synartesis.yaml";

function wrapped(server: string, env: Record<string, string>, manifest = MANIFEST): Record<string, unknown> {
  return { command: "synartesis", args: ["proxy", "--manifest", manifest, "--server", server], env };
}

function write(path: string, servers: Record<string, unknown>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: servers }));
}

describe("the environment a client gives a wrapped server", () => {
  it("fills in the client's own references, the way that client would", () => {
    const dir = home();
    process.env["SYN_ENTRY_TOKEN"] = "t0k";
    write(join(dir, ".cursor", "mcp.json"), { memory: wrapped("memory", { TOKEN: "${env:SYN_ENTRY_TOKEN}", FILE: "/m.json" }) });
    const found = clientEnvFor(MANIFEST, "memory", dir);
    expect(found?.env).toEqual({ TOKEN: "t0k", FILE: "/m.json" });
    expect(found?.from).toContain("Cursor");
  });

  it("is the same answer when two clients wrap it the same way", () => {
    const dir = home();
    write(join(dir, ".cursor", "mcp.json"), { memory: wrapped("memory", { FILE: "/m.json" }) });
    write(join(dir, ".gemini", "settings.json"), { memory: wrapped("memory", { FILE: "/m.json" }) });
    expect(clientEnvFor(MANIFEST, "memory", dir)?.env).toEqual({ FILE: "/m.json" });
  });

  it("refuses when two clients wrap it differently, and names both", () => {
    const dir = home();
    write(join(dir, ".cursor", "mcp.json"), { memory: wrapped("memory", { FILE: "/one.json" }) });
    write(join(dir, ".gemini", "settings.json"), { memory: wrapped("memory", { FILE: "/other.json" }) });
    expect(() => clientEnvFor(MANIFEST, "memory", dir)).toThrow(ConfigError);
    expect(() => clientEnvFor(MANIFEST, "memory", dir)).toThrow(/Cursor.*Gemini CLI|Gemini CLI.*Cursor/);
  });

  it("ignores entries for another policy, and says so by finding nothing", () => {
    const dir = home();
    write(join(dir, ".cursor", "mcp.json"), { memory: wrapped("memory", { FILE: "/m.json" }, "/elsewhere/synartesis.yaml") });
    expect(clientEnvFor(MANIFEST, "memory", dir)).toBeUndefined();
  });

  it("reads past a config it cannot parse", () => {
    const dir = home();
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "mcp.json"), "{ broken");
    write(join(dir, ".gemini", "settings.json"), { memory: wrapped("memory", { FILE: "/m.json" }) });
    expect(clientEnvFor(MANIFEST, "memory", dir)?.env).toEqual({ FILE: "/m.json" });
  });
});

describe("two entries wrapping one server differently", () => {
  it("are both offered, so the one a session used can be picked", () => {
    const dir = home();
    write(join(dir, ".cursor", "mcp.json"), { memory: wrapped("memory", { FILE: "/one.json" }) });
    write(join(dir, ".gemini", "settings.json"), { memory: wrapped("memory", { FILE: "/other.json" }) });
    expect(clientEnvsFor(MANIFEST, "memory", dir).map((one) => one.env["FILE"]).sort()).toEqual([
      "/one.json",
      "/other.json",
    ]);
  });
});

describe("the launcher's own variables in a client entry", () => {
  it("are neither given to the server nor fingerprinted, under the proxy or under undo", () => {
    // SYNARTESIS_NOTIFY in the entry was stripped under the proxy and passed
    // under undo, so the fingerprints never matched and every undo refused.
    const entry = { SYNARTESIS_NOTIFY: "0", npm_config_registry: "https://r.example", FILE: "/m.json" };
    const spec = { command: "node", args: [] };
    const env = upstreamEnv("memory", spec, { kind: "client", env: entry, own: false });
    expect(env).toEqual({ FILE: "/m.json" });
    expect(declaredNames(spec, entry)).toEqual(["FILE"]);
  });

  it("does not reach into this process's own environment when told to keep out", () => {
    process.env["SYN_ENTRY_TOKEN"] = "the app's own key";
    const spec = { command: "node", args: [], env: { TOKEN: "${SYN_ENTRY_TOKEN}" } };
    expect(() => upstreamEnv("memory", spec, { kind: "client", env: {}, own: false })).toThrow(/SYN_ENTRY_TOKEN/);
  });
});
