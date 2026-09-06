import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { draftManifest } from "../init/draft.js";
import { parseManifest } from "../manifest/load.js";
import { onPath } from "../invocation.js";
import { ConfigError, saveServers, serversAt, type ConfigSite, type ServerEntry } from "./clients.js";

/**
 * Wrapping a client's servers, and putting them back.
 *
 * One policy file covers everything, but each server keeps its own entry in
 * the client config and its own proxy process, selected with `--server`. A
 * single proxy carrying several servers has to qualify tool names to keep them
 * apart, which renames every tool the agent already knows -- the opposite of
 * what installing this is supposed to cost you.
 */

/** Where the original entries are kept, so uninstall restores rather than guesses. */
export function recordPathFor(manifestPath: string): string {
  return resolve(dirname(manifestPath), "installed.json");
}

interface InstalledRecord {
  readonly version: 1;
  /** Keyed by keyFor: config path, scope and server name. */
  readonly wrapped: Record<string, { readonly original: ServerEntry; readonly at: readonly string[] }>;
}

const EMPTY: InstalledRecord = { version: 1, wrapped: {} };

/**
 * Read back only what this wrote. Anything else in the file is ignored rather
 * than trusted into a shape it may not have: what hangs on it is whether
 * uninstall restores an entry or reports that it cannot.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): InstalledRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const wrapped = value["wrapped"];
  if (!isRecord(wrapped)) {
    return undefined;
  }
  const kept: Record<string, { original: ServerEntry; at: readonly string[] }> = {};
  for (const [key, entry] of Object.entries(wrapped)) {
    if (!isRecord(entry)) {
      continue;
    }
    const original = entry["original"];
    const at = entry["at"];
    if (!isRecord(original)) {
      continue;
    }
    if (!Array.isArray(at) || !at.every((step): step is string => typeof step === "string")) {
      continue;
    }
    kept[key] = { original, at };
  }
  return { version: 1, wrapped: kept };
}

/**
 * How a wrapped server is named in the record.
 *
 * A unit separator rather than a space: config paths and scopes both contain
 * spaces, so a space here lets two different servers produce the same key.
 * Exported because `status` has to ask the same question, and when it spelled
 * the key itself the two drifted apart and it reported everything it had just
 * installed as unrecorded.
 */
export function keyFor(site: ConfigSite, server: string): string {
  return [site.path, site.scope, server].join("\u001f");
}

export function readRecord(manifestPath: string): InstalledRecord {
  const path = recordPathFor(manifestPath);
  if (!existsSync(path)) {
    return EMPTY;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = asRecord(parsed);
    if (record !== undefined) {
      return record;
    }
  } catch {
    // A record we cannot read must not stop an install; the worst it costs is
    // that uninstall cannot restore what this file forgot, and the timestamped
    // backup of the config still holds it.
  }
  return EMPTY;
}

function writeRecord(manifestPath: string, record: InstalledRecord): void {
  mkdirSync(dirname(recordPathFor(manifestPath)), { recursive: true, mode: 0o700 });
  writeFileSync(recordPathFor(manifestPath), `${JSON.stringify(record, undefined, 2)}\n`);
}

/** How the wrapped entry invokes us, worked out the same way `init` prints it. */
function proxyEntry(manifestPath: string, server: string, original: ServerEntry): ServerEntry {
  const command = onPath("synartesis")
    ? { command: "synartesis", args: ["proxy"] }
    : { command: "npx", args: ["-y", "synartesis", "proxy"] };
  return {
    ...command,
    args: [...command.args, "--manifest", resolve(manifestPath), "--server", server],
    // The agent's environment, not ours: the upstream is started by the proxy
    // from the manifest, but a client that set `env` here meant it for the
    // server, and the manifest reads `${VAR}` out of exactly this environment.
    ...(original.env === undefined ? {} : { env: original.env }),
    ...(original.cwd === undefined ? {} : { cwd: original.cwd }),
  };
}

export function isWrapped(entry: ServerEntry): boolean {
  const args = entry.args ?? [];
  return (
    args.includes("proxy") &&
    (entry.command === "synartesis" ||
      entry.command === "synartesis-proxy" ||
      args.includes("synartesis") ||
      args.some((arg) => arg.endsWith("dist/cli.js") || arg.endsWith("dist/proxy.js")))
  );
}

export interface PlannedServer {
  readonly name: string;
  readonly original: ServerEntry;
  readonly wrapped: ServerEntry;
  /** The bundled policy adopted for it, when one matched. */
  readonly adopted?: string;
  readonly tools?: number;
}

export interface SitePlan {
  readonly site: ConfigSite;
  readonly servers: readonly PlannedServer[];
  readonly skipped: readonly { readonly name: string; readonly why: string }[];
}

/**
 * What installing would do, without doing any of it.
 *
 * The manifest is drafted here too, so `--dry-run` reports which servers have
 * a policy that ships and which will land as TODOs -- that being the
 * difference between working immediately and needing an afternoon.
 */
export async function planInstall(
  sites: readonly ConfigSite[],
  manifestPath: string,
): Promise<{ readonly plans: readonly SitePlan[]; readonly yaml: string }> {
  let yaml = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined;
  const plans: SitePlan[] = [];
  const claimed = new Set<string>(
    yaml === undefined ? [] : Object.keys(parseManifest(yaml, manifestPath).servers),
  );

  for (const site of sites) {
    const servers = serversAt(site);
    const planned: PlannedServer[] = [];
    const skipped: { name: string; why: string }[] = [];

    for (const [name, entry] of Object.entries(servers)) {
      if (isWrapped(entry)) {
        skipped.push({ name, why: "already covered" });
        continue;
      }
      // Remote servers are addressed by url, not started as a process, and
      // this proxy speaks stdio upstream. Saying so is better than wrapping
      // one into something that cannot connect.
      if (entry.command === undefined) {
        skipped.push({ name, why: entry.url === undefined ? "no command to start" : "remote (http); stdio only today" });
        continue;
      }
      if (entry.enabled === false) {
        skipped.push({ name, why: "switched off in the config" });
        continue;
      }
      // A manifest holds one server per name. Two clients listing a `github`
      // each is ordinary, and the second must not silently redefine the first.
      const key = claimed.has(name) ? `${name}-${site.client}` : name;
      if (claimed.has(key)) {
        skipped.push({ name, why: `already in the policy as ${key}` });
        continue;
      }

      // Drafting starts the server to ask what tools it has, and a server
      // that will not start is a fact about that entry, not a reason to
      // abandon every other one. One unusable command aborted the whole
      // install before this.
      let draft;
      try {
        draft = await draftManifest({
          name: key,
          command: entry.command,
          args: [...(entry.args ?? [])],
          ...(yaml === undefined ? {} : { existing: yaml }),
        });
      } catch (error: unknown) {
        skipped.push({
          name,
          why: `will not start: ${(error instanceof Error ? error.message : String(error)).slice(0, 60)}`,
        });
        continue;
      }
      yaml = draft.yaml;
      claimed.add(key);
      planned.push({
        name,
        original: entry,
        wrapped: proxyEntry(manifestPath, key, entry),
        ...(draft.adopted === undefined
          ? {}
          : { adopted: draft.adopted.server, tools: draft.adopted.tools }),
      });
    }
    plans.push({ site, servers: planned, skipped });
  }

  return { plans, yaml: yaml ?? "" };
}

export interface Applied {
  readonly site: ConfigSite;
  readonly backup: string;
  readonly servers: readonly string[];
}

/** Write the policy first, then the configs. A config pointing at a manifest that
 *  does not exist is a client that will not start. */
export function applyInstall(
  plans: readonly SitePlan[],
  manifestPath: string,
  yaml: string,
): readonly Applied[] {
  // Nothing to wrap means nothing to write. Every server may have been
  // skipped -- already covered, switched off, or unable to start -- and
  // writing an empty policy over a real one, or parsing one that was never
  // drafted, is not the right answer to "there was nothing to do".
  if (!plans.some((plan) => plan.servers.length > 0)) {
    return [];
  }
  // Never write a policy that would not load: one that fails to parse is worse
  // than none, because the client is by then pointing at it.
  parseManifest(yaml, manifestPath);
  mkdirSync(dirname(resolve(manifestPath)), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, yaml);

  const record = readRecord(manifestPath);
  const wrapped = { ...record.wrapped };
  const applied: Applied[] = [];

  for (const plan of plans) {
    if (plan.servers.length === 0) {
      continue;
    }
    const servers = { ...serversAt(plan.site) };
    for (const server of plan.servers) {
      servers[server.name] = server.wrapped;
      wrapped[keyFor(plan.site, server.name)] = { original: server.original, at: plan.site.at };
    }
    const backup = saveServers(plan.site, servers);
    applied.push({ site: plan.site, backup, servers: plan.servers.map((server) => server.name) });
  }

  writeRecord(manifestPath, { version: 1, wrapped });
  return applied;
}

export interface Restored {
  readonly site: ConfigSite;
  readonly backup: string;
  readonly servers: readonly string[];
  readonly unknown: readonly string[];
}

/**
 * Put back what was there. Entries this never wrapped are left exactly as they
 * are, and a wrapped entry whose original was not recorded is reported rather
 * than removed -- deleting a server nobody can restore would be worse than
 * leaving one wrapped.
 */
export function applyUninstall(
  sites: readonly ConfigSite[],
  manifestPath: string,
): readonly Restored[] {
  const record = readRecord(manifestPath);
  const restoredKeys = new Set<string>();
  const restored: Restored[] = [];

  for (const site of sites) {
    const servers = { ...serversAt(site) };
    const put: string[] = [];
    const unknown: string[] = [];

    for (const [name, entry] of Object.entries(servers)) {
      if (!isWrapped(entry)) {
        continue;
      }
      const known = record.wrapped[keyFor(site, name)];
      if (known === undefined) {
        unknown.push(name);
        continue;
      }
      servers[name] = known.original;
      put.push(name);
      restoredKeys.add(keyFor(site, name));
    }

    if (put.length === 0 && unknown.length === 0) {
      continue;
    }
    const backup = put.length === 0 ? "" : saveServers(site, servers);
    restored.push({ site, backup, servers: put, unknown });
  }

  const remaining = Object.fromEntries(
    Object.entries(record.wrapped).filter(([key]) => !restoredKeys.has(key)),
  );
  writeRecord(manifestPath, { version: 1, wrapped: remaining });
  return restored;
}

export { ConfigError };
