import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Where MCP clients keep their list of servers, and how to change it safely.
 *
 * Nothing in this project has ever read one of these files. Covering a server
 * meant reading your client's JSON, retyping the command into `init`, then
 * editing the JSON back to point at the proxy -- two hand edits across two
 * files, for every server, which is most of the reason anyone gives up before
 * seeing an undo work.
 *
 * These files belong to the user and were not opened by them when we write to
 * one, so every write here is backed up first and lands by rename.
 */

export type ClientId = "claude-code" | "claude-desktop" | "cursor";

/** A server entry as the client wrote it, with any keys we do not know kept. */
export interface ServerEntry {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly type?: string;
  readonly url?: string;
  readonly [key: string]: unknown;
}

export interface ConfigSite {
  readonly client: ClientId;
  readonly label: string;
  readonly path: string;
  /** Which list this is, when a client keeps more than one. */
  readonly scope: string;
  /**
   * Path to the server map inside the document. Claude Code keeps one per
   * project under `projects`, so this is not always a single key.
   */
  readonly at: readonly string[];
}

const LABELS: Readonly<Record<ClientId, string>> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
};

export function labelFor(client: ClientId): string {
  return LABELS[client];
}

/** Claude Desktop's config, which is the one place that differs per platform. */
function claudeDesktopPath(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env["APPDATA"] ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "Claude", "claude_desktop_config.json");
  }
}

/**
 * Every place on this machine that could hold servers for a supported client.
 *
 * Sites are returned whether or not they currently list anything: a config
 * that exists but has no servers is a useful thing to report, and quite
 * different from a client that is not installed.
 */
export function discover(cwd: string): readonly ConfigSite[] {
  const home = homedir();
  const sites: ConfigSite[] = [];

  // Claude Code keeps a per-project map inside one file, keyed by absolute
  // path, and may also keep a global one. Both are worth offering; the
  // project's own is the one that matches where you are standing.
  const claudeCode = join(home, ".claude.json");
  if (existsSync(claudeCode)) {
    const document = readJson(claudeCode);
    const projects = document?.["projects"];
    const here = resolve(cwd);
    if (isRecord(projects) && Object.prototype.hasOwnProperty.call(projects, here)) {
      sites.push({
        client: "claude-code",
        label: LABELS["claude-code"],
        path: claudeCode,
        scope: `project ${here}`,
        at: ["projects", here, "mcpServers"],
      });
    }
    sites.push({
      client: "claude-code",
      label: LABELS["claude-code"],
      path: claudeCode,
      scope: "global",
      at: ["mcpServers"],
    });
  }

  // A project file, which is the one people commit and share.
  const projectFile = join(resolve(cwd), ".mcp.json");
  if (existsSync(projectFile)) {
    sites.push({
      client: "claude-code",
      label: LABELS["claude-code"],
      path: projectFile,
      scope: "project file",
      at: ["mcpServers"],
    });
  }

  const desktop = claudeDesktopPath();
  if (existsSync(desktop)) {
    sites.push({
      client: "claude-desktop",
      label: LABELS["claude-desktop"],
      path: desktop,
      scope: "global",
      at: ["mcpServers"],
    });
  }

  for (const [path, scope] of [
    [join(resolve(cwd), ".cursor", "mcp.json"), "project"],
    [join(home, ".cursor", "mcp.json"), "global"],
  ] as const) {
    if (existsSync(path)) {
      sites.push({ client: "cursor", label: LABELS.cursor, path, scope, at: ["mcpServers"] });
    }
  }

  return sites;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export class ConfigError extends Error {}

/** The whole document, or a refusal. A file we cannot parse is not one to rewrite. */
export function readDocument(site: ConfigSite): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(site.path, "utf8");
  } catch (error: unknown) {
    throw new ConfigError(`cannot read ${site.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    // Refuse rather than repair. Rewriting a file we did not understand is how
    // someone's client stops starting.
    throw new ConfigError(
      `${site.path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        `Fix it or move it aside; synartesis will not rewrite a file it cannot read.`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ConfigError(`${site.path} is not a JSON object, so it has no server list to change`);
  }
  return parsed;
}

/** The server map at this site, or an empty one where the key is absent. */
export function readServers(document: Record<string, unknown>, at: readonly string[]): Record<string, ServerEntry> {
  let node: unknown = document;
  for (const key of at) {
    if (!isRecord(node)) {
      return {};
    }
    node = node[key];
  }
  if (!isRecord(node)) {
    return {};
  }
  const servers: Record<string, ServerEntry> = {};
  for (const [name, entry] of Object.entries(node)) {
    if (isRecord(entry)) {
      servers[name] = entry;
    }
  }
  return servers;
}

/**
 * A copy of the document with the server map replaced. Every other key, at
 * every level, is carried through untouched -- these files hold a great deal
 * that is nothing to do with us, and Claude Code's holds 28 projects' history.
 */
export function withServers(
  document: Record<string, unknown>,
  at: readonly string[],
  servers: Record<string, ServerEntry>,
): Record<string, unknown> {
  const head = at[0];
  if (head === undefined) {
    throw new ConfigError("no path to the server list");
  }
  const rest = at.slice(1);
  const below = document[head];
  const child =
    rest.length === 0 ? servers : withServers(isRecord(below) ? below : {}, rest, servers);
  return { ...document, [head]: child };
}

/** Two spaces unless the file plainly uses something else, so the diff stays small. */
function indentOf(path: string): string | number {
  try {
    const line = /\n([ \t]+)"/.exec(readFileSync(path, "utf8"));
    const found = line?.[1];
    if (found === undefined) {
      return 2;
    }
    return found.startsWith("\t") ? "\t" : found.length;
  } catch {
    return 2;
  }
}

export function backupPathFor(path: string): string {
  return `${path}.synartesis-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Write the document back, having first copied the original aside.
 *
 * Through a temporary file and a rename, because a partial write of
 * claude_desktop_config.json stops the client starting -- a far worse outcome
 * than failing to install. Rename is atomic within a directory, so the file is
 * either the old one or the new one and never half of either.
 */
export function writeDocument(site: ConfigSite, document: Record<string, unknown>): string {
  const backup = backupPathFor(site.path);
  const original = readFileSync(site.path);
  writeFileSync(backup, original);

  const temporary = join(dirname(site.path), `.synartesis-write-${String(process.pid)}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(document, undefined, indentOf(site.path))}\n`);
    renameSync(temporary, site.path);
  } catch (error: unknown) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to clean up, or nothing we can do about it.
    }
    throw new ConfigError(
      `could not write ${site.path}: ${error instanceof Error ? error.message : String(error)}. ` +
        `The original is untouched, and a copy is at ${backup}.`,
    );
  }
  return backup;
}
