import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { draftManifest } from "../init/draft.js";
import { parseManifest } from "../manifest/load.js";
import { pathBinaryMatches } from "../invocation.js";
import {
  ConfigError,
  expandForClient,
  saveServers,
  serversAt,
  type ConfigSite,
  type ServerEntry,
} from "./clients.js";

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
  // Owner-only. This file keeps every original client entry so uninstall can
  // put it back -- which means it keeps every token those entries carried, in
  // plain text, and it was written at the default mode: readable by every
  // account on the machine. `mode` only applies when a file is created, so a
  // record written by an earlier version is tightened explicitly as well.
  const path = recordPathFor(manifestPath);
  writeFileSync(path, `${JSON.stringify(record, undefined, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * How the wrapped entry invokes us.
 *
 * `synartesis` by name only when the one on PATH is the one running: a client
 * config that names an older global is a set of servers that will not start,
 * and nothing about that failure is visible from the client. Otherwise the
 * absolute path of the CLI doing the installing, which is by definition able
 * to serve what it just wrote.
 */
function proxyEntry(
  manifestPath: string,
  server: string,
  original: ServerEntry,
  invoker: { readonly command: string; readonly args: readonly string[] },
): ServerEntry {
  const command = { command: invoker.command, args: [...invoker.args] };
  return {
    // What the client keeps about a server besides how to start it: Copilot
    // CLI's `tools` list, Gemini CLI's `trust` and timeout, a stdio `type`.
    // Dropped, a client that requires one would stop offering the server.
    // Not the ways of reaching it, which are all replaced by the proxy.
    ...Object.fromEntries(Object.entries(original).filter(([key, value]) => kept(key, value))),
    ...command,
    args: [...command.args, "--manifest", resolve(manifestPath), "--server", server],
    // The agent's environment, not ours: the upstream is started by the proxy
    // from the manifest, but a client that set `env` here meant it for the
    // server, and the manifest reads `${VAR}` out of exactly this environment.
    ...(original.env === undefined ? {} : { env: original.env }),
    ...(original.cwd === undefined ? {} : { cwd: original.cwd }),
  };
}

/** Starting and addressing keys, which the proxy's entry replaces. */
const REPLACED = new Set(["command", "args", "env", "cwd", "url", "serverUrl", "httpUrl", "headers"]);

function kept(key: string, value: unknown): boolean {
  if (key === "type") {
    return value === "stdio" || value === "local";
  }
  return !REPLACED.has(key);
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
  /** How far that bundled policy has been tested. */
  readonly provenance?: "live" | "documented";
  readonly tools?: number;
  /** Already in the policy from an earlier install; only the entry changes. */
  readonly again?: boolean;
  /** A hosted server, reached through mcp-remote at this url. */
  readonly bridged?: string;
  /** A hosted server the proxy reaches itself, with the client's headers. */
  readonly direct?: string;
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
export interface Invoker {
  readonly command: string;
  readonly args: readonly string[];
  /** Set when the name on PATH could not be used, and why. */
  readonly note?: string;
}

/** What a client config should run to reach this build of the proxy. */
export function invokerFor(ourVersion: string, cliPath: string): Invoker {
  if (pathBinaryMatches(ourVersion)) {
    return { command: "synartesis", args: ["proxy"] };
  }
  return {
    command: process.execPath,
    args: [cliPath, "proxy"],
    note: "the synartesis on your PATH is a different build, so the entries name this one directly",
  };
}

/** A hosted entry's headers, when it has any. */
function headersOf(entry: ServerEntry): Readonly<Record<string, string>> | undefined {
  const headers = entry["headers"];
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    return undefined;
  }
  const text = Object.entries(headers).filter(
    (pair): pair is [string, string] => typeof pair[1] === "string",
  );
  return text.length === 0 ? undefined : Object.fromEntries(text);
}

/**
 * The environment variable a header's value moves into: `GITHUB_MCP_AUTHORIZATION`
 * for github's Authorization. Named for the server so two servers' tokens
 * cannot collide in one client's config.
 */
export function headerVariable(server: string, header: string): string {
  const part = (text: string): string =>
    text.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const name = `${part(server)}_MCP_${part(header)}`;
  return /^[A-Z_]/.test(name) ? name : `S_${name}`;
}

/** Which transport the client said, in the words each uses for it. */
function transportOf(site: ConfigSite, entry: ServerEntry): "auto" | "http" | "sse" {
  if (entry.type === "sse") {
    return "sse";
  }
  if (typeof entry["httpUrl"] === "string" || entry.type === "http" || entry.type === "streamable-http") {
    return "http";
  }
  // Gemini CLI documents `url` as the SSE endpoint and `httpUrl` as the other.
  if (site.client === "gemini-cli" && typeof entry.url === "string") {
    return "sse";
  }
  return "auto";
}

/** The local process that reaches a hosted server. */
export function bridgeFor(url: string): ServerEntry {
  return { command: "npx", args: ["-y", "mcp-remote", url] };
}

/**
 * Why a hosted server with no headers cannot be covered through mcp-remote
 * here, if it cannot. (One with headers is reached directly instead: mcp-remote
 * takes headers only on its command line, which would put a token in every
 * process listing.)
 */
function unbridgeable(site: ConfigSite, entry: ServerEntry, remote: boolean): string | undefined {
  if (site.format === "toml") {
    return "hosted; covering one in Codex's config is not supported yet";
  }
  if (!remote) {
    return "hosted; install --remote covers it through mcp-remote, which signs you in through your browser";
  }
  return undefined;
}

export async function planInstall(
  sites: readonly ConfigSite[],
  manifestPath: string,
  invoker: Invoker,
  /**
   * Which entries to consider at all. The console connects the one server a
   * person picked; planning every server at its site first meant starting
   * each of them -- downloads for an npx one, a sign-in window for a remote
   * bridge -- and writing a drafted policy for all of them into the file,
   * though only the chosen one was wrapped.
   */
  only?: (site: ConfigSite, name: string) => boolean,
  options: {
    /**
     * Cover hosted servers too, through mcp-remote. Asked for rather than
     * assumed: covering one starts it, which opens a browser to sign in, and
     * runs a package from outside this one.
     */
    readonly remote?: boolean;
    /** What starts the bridge; replaced only by tests, which have no network. */
    readonly bridge?: (url: string) => ServerEntry;
  } = {},
): Promise<{ readonly plans: readonly SitePlan[]; readonly yaml: string }> {
  let yaml = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined;
  const plans: SitePlan[] = [];
  const existing = yaml === undefined ? {} : parseManifest(yaml, manifestPath).servers;
  const claimed = new Set<string>(Object.keys(existing));
  // Policy servers some client entry is already wrapped to, anywhere this run
  // can see. A server in the policy that nothing points at any more is one
  // uninstall unwrapped, and is free to be covered again.
  const pointedAt = new Set<string>();
  for (const site of sites) {
    let entries: Record<string, ServerEntry>;
    try {
      entries = serversAt(site);
    } catch {
      continue;
    }
    for (const entry of Object.values(entries)) {
      const args = entry.args ?? [];
      const manifest = args[args.indexOf("--manifest") + 1];
      const server = args[args.indexOf("--server") + 1];
      if (
        isWrapped(entry) &&
        args.includes("--server") &&
        manifest !== undefined &&
        server !== undefined &&
        resolve(manifest) === resolve(manifestPath)
      ) {
        pointedAt.add(server);
      }
    }
  }

  for (const site of sites) {
    const servers = serversAt(site);
    const planned: PlannedServer[] = [];
    const skipped: { name: string; why: string }[] = [];

    for (const [name, original] of Object.entries(servers)) {
      if (only !== undefined && !only(site, name)) {
        continue;
      }
      if (isWrapped(original)) {
        skipped.push({ name, why: "already covered" });
        continue;
      }
      // A hosted server is addressed by url rather than started, and this
      // proxy starts its servers. mcp-remote is the bridge: a local process
      // that speaks stdio on one side and the hosted server on the other, and
      // does the sign-in itself -- every major hosted server wants OAuth, and
      // it keeps its own tokens, so none of them passes through here.
      // `url` in most clients; Antigravity and Devin say `serverUrl`, and
      // Gemini CLI `httpUrl` for streaming. mcp-remote works out which.
      const address = [original.url, original["serverUrl"], original["httpUrl"]].find(
        (one): one is string => typeof one === "string",
      );
      const hosted = original.command === undefined && address !== undefined;
      // With a token in its headers, reached directly: the proxy sends the
      // same headers to the same address the client did, so nothing new is
      // trusted and no browser opens. The values move into the wrapped
      // entry's env, where the client already keeps secrets and fills in its
      // own references; the policy names the variables.
      const headers = headersOf(original);
      const native =
        hosted && headers !== undefined && site.format !== "toml"
          ? {
              url: address,
              transport: transportOf(site, original),
              headers: Object.fromEntries(
                Object.keys(headers).map((header) => [header, `\${${headerVariable(name, header)}}`]),
              ),
              env: Object.fromEntries(
                Object.entries(headers).map(([header, value]) => [headerVariable(name, header), value]),
              ),
            }
          : undefined;
      if (hosted && native === undefined) {
        const why = unbridgeable(site, original, options.remote === true);
        if (why !== undefined) {
          skipped.push({ name, why });
          continue;
        }
      }
      const entry: ServerEntry =
        native !== undefined
          ? { ...original, env: { ...(original.env ?? {}), ...native.env } }
          : hosted
            ? (options.bridge ?? bridgeFor)(address)
            : original;
      if (entry.command === undefined && native === undefined) {
        skipped.push({ name, why: "no command to start" });
        continue;
      }
      if (original.enabled === false || original.disabled === true) {
        skipped.push({ name, why: "switched off in the config" });
        continue;
      }
      if (typeof original["unreadable"] === "string") {
        skipped.push({ name, why: `left alone: ${original["unreadable"]}. Put args on one line, or wrap it by hand` });
        continue;
      }
      // A manifest holds one server per name. Two clients listing a `github`
      // each is ordinary, and the second must not silently redefine the first.
      // Installed before, and unwrapped by uninstall since, which leaves the
      // policy behind on purpose. The collision rule below exists for two
      // clients that each list a `github`, and cannot tell that from this: so
      // the second install used to add a duplicate `filesystem-claude-desktop`,
      // and the third skipped it as "already in the policy as ..." -- which
      // reads as covered and left it unwrapped. The same command and
      // arguments, under a name nothing else is wrapped to, is the same
      // server: wrap the entry to it again and draft nothing.
      const again = [name, `${name}-${site.client}`].find((candidate) => {
        const spec = existing[candidate];
        const args = entry.args ?? [];
        if (native !== undefined) {
          return spec?.url === native.url && !pointedAt.has(candidate);
        }
        return (
          spec !== undefined &&
          spec.url === undefined &&
          !pointedAt.has(candidate) &&
          spec.command === entry.command &&
          spec.args.length === args.length &&
          spec.args.every((arg, index) => arg === args[index])
        );
      });
      if (again !== undefined) {
        pointedAt.add(again);
        planned.push({
          name,
          original,
          wrapped: proxyEntry(manifestPath, again, entry, invoker),
          again: true,
        });
        continue;
      }

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
          command: entry.command ?? "",
          args: [...(entry.args ?? [])],
          ...(native === undefined
            ? {}
            : { remote: { url: native.url, transport: native.transport, headers: native.headers } }),
          // As the client would start it, so a server that needs its token to
          // list its tools is drafted rather than reported as broken.
          env: Object.fromEntries(
            Object.entries(entry.env ?? {}).map(([k, v]) => [k, expandForClient(site.client, v)]),
          ),
          ...(entry.cwd === undefined ? {} : { cwd: expandForClient(site.client, entry.cwd) }),
          ...(yaml === undefined ? {} : { existing: yaml }),
        });
      } catch (error: unknown) {
        skipped.push({
          name,
          // Whole. The sentence worth reading comes last -- the server's own
          // "Please set SLACK_BOT_TOKEN" -- and cutting at sixty characters
          // kept only the SDK's preamble ahead of it.
          why: `will not start: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      yaml = draft.yaml;
      claimed.add(key);
      planned.push({
        name,
        original,
        wrapped: proxyEntry(manifestPath, key, entry, invoker),
        ...(hosted && native === undefined ? { bridged: address } : {}),
        ...(native === undefined ? {} : { direct: native.url }),
        ...(draft.adopted === undefined
          ? {}
          : {
              adopted: draft.adopted.server,
              tools: draft.adopted.tools,
              ...(draft.adopted.provenance === undefined
                ? {}
                : { provenance: draft.adopted.provenance }),
            }),
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
    // The record before the config it describes, not after all of them. A
    // record naming something not yet wrapped costs nothing; a wrapped entry
    // missing from the record cannot be put back, and a failure part way
    // through several clients would have left exactly that.
    writeRecord(manifestPath, { version: 1, wrapped });
    const backup = saveServers(plan.site, servers);
    applied.push({ site: plan.site, backup, servers: plan.servers.map((server) => server.name) });
  }

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
