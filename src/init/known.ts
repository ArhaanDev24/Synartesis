import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseManifest } from "../manifest/load.js";
import type { ToolPolicy } from "../manifest/types.js";

/**
 * Policies that already exist, for the servers most people start with.
 *
 * Writing a snapshot and an inverse for every write a server offers is the
 * whole barrier to getting anything out of this, and for these four that work
 * is done and ships in manifests/. init was asking people to do it again from
 * scratch, fourteen TODOs at a time, against a file already in the package.
 *
 * Matched on the command line, because that is the part a person typed and can
 * see. Longest marker first: server-github must not be read as server-git.
 */
const KNOWN: readonly { readonly marker: string; readonly manifest: string }[] = [
  { marker: "server-filesystem", manifest: "filesystem" },
  { marker: "server-github", manifest: "github" },
  { marker: "github-mcp-server", manifest: "github" },
  { marker: "server-memory", manifest: "memory" },
  { marker: "mcp-server-git", manifest: "git" },
  { marker: "server-git", manifest: "git" },
];

/** The bundled manifests, whether running from dist/ or from src/. */
function manifestsDir(): string | undefined {
  for (const up of ["../manifests/", "../../manifests/"]) {
    const candidate = fileURLToPath(new URL(up, import.meta.url));
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface KnownPolicy {
  /** What the bundled file calls this server, e.g. `fs`. */
  readonly key: string;
  readonly rules: readonly ToolPolicy[];
  readonly name: string;
  /** The file's own `tools:` block, comments and all. */
  readonly source: string;
}

export function knownPolicyFor(command: string, args: readonly string[]): KnownPolicy | undefined {
  const line = [command, ...args].join(" ");
  const hit = KNOWN.find((entry) => line.includes(entry.marker));
  const dir = manifestsDir();
  if (hit === undefined || dir === undefined) {
    return undefined;
  }
  const path = `${dir}${hit.manifest}.yaml`;
  if (!existsSync(path)) {
    return undefined;
  }
  // A bundled policy that no longer parses must not stop init working; the
  // drafted TODOs are always a correct answer, just a slower one.
  try {
    const text = readFileSync(path, "utf8");
    const source = toolsBlock(text);
    const key = serverKey(text);
    if (source === undefined || key === undefined) {
      return undefined;
    }
    // Parsed with a stand-in servers block rather than the file's own. Two of
    // these read the environment -- memory wants MEMORY_FILE_PATH, github a
    // token -- and loading the real one fails when those are unset, which is
    // right for running a server and pointless for reading its tool rules.
    const rules = parseManifest(
      `version: 1\nservers:\n  ${key}:\n    command: "true"\ntools:\n${source}\n`,
      path,
    ).tools;
    return { key, rules, name: hit.manifest, source };
  } catch {
    return undefined;
  }
}

/**
 * The file's tools: section verbatim. Taken as text rather than re-serialised
 * from the parsed rules, because the comments are the most useful thing in
 * these files: they say why a move is gated and why an inverse reads $result
 * instead of $. Losing them would make an adopted policy harder to edit than
 * one written by hand.
 */
function toolsBlock(text: string): string | undefined {
  const at = text.search(/^tools:[ \t]*$/m);
  if (at === -1) {
    return undefined;
  }
  const body = text.slice(text.indexOf("\n", at) + 1);
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    // A new top-level key ends the block.
    if (/^[^\s#]/.test(line)) {
      break;
    }
    lines.push(line);
  }
  return lines.join("\n").replace(/\s+$/, "");
}

/** The first server the file declares, which is the one its rules qualify. */
function serverKey(text: string): string | undefined {
  const at = text.search(/^servers:[ \t]*$/m);
  if (at === -1) {
    return undefined;
  }
  const body = text.slice(text.indexOf("\n", at) + 1);
  for (const line of body.split("\n")) {
    if (/^[^\s#]/.test(line)) {
      return undefined;
    }
    const named = /^ {2}([A-Za-z0-9_-]+):[ \t]*$/.exec(line);
    if (named?.[1] !== undefined) {
      return named[1];
    }
  }
  return undefined;
}

/** Every tool name a rule needs to exist: the one it matches, and its own calls. */
export function toolsReferencedBy(rule: ToolPolicy, key: string): readonly string[] {
  const local = (qualified: string | undefined): string | undefined =>
    qualified === undefined || !qualified.startsWith(`${key}.`)
      ? undefined
      : qualified.slice(key.length + 1);
  return [local(rule.snapshot?.tool), local(rule.inverse?.tool)].filter(
    (name): name is string => name !== undefined,
  );
}
