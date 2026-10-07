import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveServers, type ConfigSite } from "../src/install/clients.js";
import { isWrapped } from "../src/install/install.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function site(path: string, at: readonly string[] = ["mcpServers"]): ConfigSite {
  return { client: "cursor", label: "Cursor", format: "json", path, scope: "global", at };
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-config-"));
  dirs.push(dir);
  return dir;
}

const wrapped = { command: "synartesis", args: ["proxy", "--server", "fs"] };

describe("rewriting a client's config", () => {
  it.skipIf(process.platform === "win32")("keeps a config that only its owner could read that way, and its backup too", () => {
    const path = join(scratch(), "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { fs: { command: "npx", env: { TOKEN: "secret" } } } }));
    chmodSync(path, 0o600);
    const backup = saveServers(site(path), { fs: wrapped });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("writes through a symlink rather than replacing it", () => {
    const dir = scratch();
    mkdirSync(join(dir, "dotfiles"));
    const real = join(dir, "dotfiles", "mcp.json");
    const link = join(dir, "mcp.json");
    writeFileSync(real, JSON.stringify({ mcpServers: { fs: { command: "npx" } } }));
    symlinkSync(real, link);
    saveServers(site(link), { fs: wrapped });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toMatchObject({ mcpServers: { fs: wrapped } });
  });

  it("keeps what in the server list is not a server", () => {
    const path = join(scratch(), "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { "//": "work servers", fs: { command: "npx" } } }));
    saveServers(site(path), { fs: wrapped });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcpServers: { "//": "work servers", fs: wrapped } });
  });

  it("keeps the copy of the file as it was, however many lists in it one install rewrites", () => {
    // Claude Code keeps one list per project in one file, so one install
    // writes it once per project; each write pruned the backups to five.
    const dir = scratch();
    const path = join(dir, ".claude.json");
    const projects = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [`/p${String(i)}`, { mcpServers: { fs: { command: "npx" } } }]),
    );
    const original = JSON.stringify({ projects });
    writeFileSync(path, original);
    const backups = new Set<string>();
    for (const project of Object.keys(projects)) {
      backups.add(saveServers(site(path, ["projects", project, "mcpServers"]), { fs: wrapped }));
    }
    expect(backups.size).toBe(1);
    const [only] = [...backups];
    expect(readFileSync(only ?? "", "utf8")).toBe(original);
    expect(readdirSync(dir).filter((name) => name.includes("synartesis-backup"))).toHaveLength(1);
  });
});

describe("recognising an entry install wrote", () => {
  it("knows its own entry on Windows, where the path is written with backslashes", () => {
    expect(
      isWrapped({ command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\a\\synartesis\\dist\\cli.js", "proxy"] }),
    ).toBe(true);
  });
});
