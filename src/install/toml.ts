import type { ServerEntry } from "./clients.js";

/**
 * Codex keeps its servers in TOML, and this reads and edits that file without
 * ever re-serialising it.
 *
 * The obvious approach -- parse to an object, change it, write it back -- would
 * need a TOML library and would destroy the file on the way through. A real
 * config.toml is mostly things that are nothing to do with us: marketplaces,
 * plugin tables, a shell environment policy, and comments explaining why each
 * is there. A serialiser keeps the data and throws away the comments and the
 * order, which is most of what makes the file readable.
 *
 * So this finds the `[mcp_servers.NAME]` tables by line, and rewrites only the
 * `command` and `args` lines inside them. Every other byte of the file is
 * carried through untouched, including the `[mcp_servers.NAME.env]` subtable,
 * which belongs to the server and is none of our business.
 */

export interface TomlTable {
  readonly name: string;
  /** Index of the header line. */
  readonly start: number;
  /** One past the last line belonging to this table. */
  readonly end: number;
}

// A single `[table]`. An array of tables is `[[x]]`, and taking everything
// between the first bracket and the last read one as a table called "[x".
const HEADER = /^\s*\[(?!\[)([^[\]]+)\]\s*$/;

/** Every `[mcp_servers.NAME]` table, excluding its `.env` and other subtables. */
export function serverTables(lines: readonly string[]): TomlTable[] {
  const tables: TomlTable[] = [];
  let open: { name: string; start: number } | undefined;

  const close = (at: number): void => {
    if (open !== undefined) {
      tables.push({ name: open.name, start: open.start, end: at });
      open = undefined;
    }
  };

  lines.forEach((line, index) => {
    const header = HEADER.exec(line)?.[1];
    if (header === undefined) {
      return;
    }
    const parts = header.split(".");
    // Exactly two parts: `mcp_servers.github` is the server, and
    // `mcp_servers.github.env` is a subtable of it that we leave alone.
    if (parts[0] === "mcp_servers" && parts.length === 2 && parts[1] !== undefined) {
      close(index);
      open = { name: unquote(parts[1]), start: index };
      return;
    }
    close(index);
  });
  close(lines.length);
  return tables;
}

/**
 * The exact inverse of `quote`. Reading `\\"` back as `\\"` rather than `"` is
 * how an argument survives being written and read again.
 */
function unquote(text: string): string {
  const trimmed = text.trim();
  if (/^'.*'$/s.test(trimmed)) {
    // Literal strings in TOML: no escapes inside them at all.
    return trimmed.slice(1, -1);
  }
  if (!/^".*"$/s.test(trimmed)) {
    return trimmed;
  }
  return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

/** A `key = value` line, where value is a quoted string or a single-line array. */
function readKey(lines: readonly string[], table: TomlTable, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
  for (let index = table.start + 1; index < table.end; index += 1) {
    const line = lines[index];
    if (line === undefined || HEADER.test(line)) {
      break;
    }
    const value = pattern.exec(line)?.[1];
    if (value !== undefined) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Split on the commas that separate items, not on the ones inside them.
 *
 * `split(",")` tore `["--flag", "a,b"]` into three pieces and left the quotes
 * stranded in the values -- and because a write re-emits every entry it was
 * given, that damage reached servers nobody had asked to change.
 */
function splitItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const character of inner) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    // Only basic strings take escapes; a literal string has none.
    if (character === "\\" && quote === '"') {
      current += character;
      escaped = true;
      continue;
    }
    if (quote === undefined && (character === '"' || character === "'")) {
      quote = character;
      current += character;
      continue;
    }
    if (character === quote) {
      quote = undefined;
      current += character;
      continue;
    }
    if (character === "," && quote === undefined) {
      items.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  items.push(current);
  return items;
}

function parseArray(value: string | undefined): string[] | undefined {
  if (value === undefined || !value.startsWith("[")) {
    return undefined;
  }
  // Single-line arrays only. A multi-line one is left alone rather than
  // half-understood: a config we cannot read exactly is one we must not write.
  if (!value.endsWith("]")) {
    return undefined;
  }
  const inner = value.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }
  // A trailing comma is legal TOML and leaves an empty last item.
  return splitItems(inner)
    .map((item) => item.trim())
    .filter((item, index, all) => item !== "" || index !== all.length - 1)
    .map(unquote);
}

/** The `[mcp_servers.*]` entries, as the JSON clients would have expressed them. */
export function readServers(text: string): Record<string, ServerEntry> {
  const lines = text.split("\n");
  const servers: Record<string, ServerEntry> = {};
  for (const table of serverTables(lines)) {
    const command = readKey(lines, table, "command");
    const entry: Record<string, unknown> = {};
    if (command !== undefined) {
      entry["command"] = unquote(command);
    }
    const args = parseArray(readKey(lines, table, "args"));
    if (args !== undefined) {
      entry["args"] = args;
    }
    const url = readKey(lines, table, "url");
    if (url !== undefined) {
      entry["url"] = unquote(url);
    }
    // Codex switches a server off here rather than removing it. Wrapping one
    // that is off would start a process nobody asked for.
    const enabled = readKey(lines, table, "enabled");
    if (enabled !== undefined) {
      entry["enabled"] = enabled.trim() === "true";
    }
    servers[table.name] = entry;
  }
  return servers;
}

const quote = (text: string): string => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The file with `command` and `args` replaced inside the named tables.
 *
 * Lines are replaced where they exist and inserted straight after the header
 * where they do not, so a table that had no `args` gets one in the place a
 * person would have written it.
 */
export function writeServers(text: string, servers: Record<string, ServerEntry>): string {
  const lines = text.split("\n");
  // What is in the file now, so an entry that is not actually changing can be
  // left alone. Callers pass the whole map with one entry replaced, and
  // re-emitting the rest from parsed values is how a parsing mistake reaches a
  // server nobody touched. Untouched lines are never rewritten.
  const current = readServers(text);

  // Back to front, so an edit never moves a table this loop has yet to reach.
  for (const table of serverTables(lines).reverse()) {
    const wanted = servers[table.name];
    if (wanted === undefined || wanted.command === undefined) {
      continue;
    }
    const now = current[table.name];
    if (
      now?.command === wanted.command &&
      JSON.stringify(now.args ?? []) === JSON.stringify(wanted.args ?? [])
    ) {
      continue;
    }
    setKey(lines, table, "command", quote(wanted.command));
    setKey(lines, table, "args", `[${(wanted.args ?? []).map(quote).join(", ")}]`);
  }
  return lines.join("\n");
}

function setKey(lines: string[], table: TomlTable, key: string, value: string): void {
  const pattern = new RegExp(`^(\\s*)${key}\\s*=`);
  for (let index = table.start + 1; index < table.end; index += 1) {
    const line = lines[index];
    if (line === undefined || HEADER.test(line)) {
      break;
    }
    const indent = pattern.exec(line)?.[1];
    if (indent !== undefined) {
      lines[index] = `${indent}${key} = ${value}`;
      return;
    }
  }
  lines.splice(table.start + 1, 0, `${key} = ${value}`);
}
