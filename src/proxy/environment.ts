import { createHmac } from "node:crypto";

import { ManifestError } from "../errors.js";
import type { ServerSpec } from "../manifest/types.js";

/**
 * Where a server's environment comes from when it is started.
 *
 * This had one answer, which was wrong in two different ways. The proxy
 * started every upstream with only what the manifest declared, and the MCP
 * SDK fills in nothing but HOME, LOGNAME, PATH, SHELL, TERM and USER -- so a
 * token the client configured for a server never reached it. `install` copies
 * that `env` onto the proxy's own entry, with a comment saying the manifest
 * reads it from there; the manifest it drafted had no `env` block to read it
 * with. So wrapping a server that authenticates through its environment --
 * most of them -- turned a working server into one that fails auth, and the
 * memory server quietly started writing to a different file.
 *
 * The three sources are three situations, not three preferences:
 *
 * - `inherit`: the proxy running under `--server X`, which is what `install`
 *   writes. Its own environment *is* the one the client meant for X, because
 *   the client started it with exactly that. Inheriting makes a wrapped server
 *   behave as it did unwrapped, and fixes every existing install without it
 *   being run again.
 * - `client`: anything started by a person rather than by the client -- undo,
 *   check, pin. A terminal does not have the client's `SLACK_BOT_TOKEN`, so
 *   the environment is read from the client entry that wraps the server. This
 *   is the case the first fix alone would have missed: an undo that cannot
 *   authenticate does not undo anything.
 * - `manifest`: only what the policy declares. For a hand-written entry
 *   serving several servers, where whose variable is whose is not knowable.
 */
export type EnvSource =
  | { readonly kind: "inherit" }
  | {
      readonly kind: "client";
      readonly env: Readonly<Record<string, string>>;
      /**
       * Whether this process's own environment goes underneath the entry's.
       * Yes from a terminal: a server that relied on the shell's `AWS_PROFILE`
       * worked under the client, which passes its whole environment on, and
       * has to work under undo too. No from the desktop window, whose process
       * can carry the person's model API keys when it is started from a shell,
       * and which has no business handing those to every server it starts.
       */
      readonly own?: boolean;
    }
  | { readonly kind: "manifest" };

/**
 * Variables that belong to whatever launched the proxy, not to the server.
 *
 * `SYNARTESIS_TOKEN` is the proxy's own HTTP bearer, a secret with no business
 * in an upstream; the rest of `SYNARTESIS_*` are the proxy's settings. The npm
 * ones were measured rather than guessed: `npx -y synartesis proxy` adds
 * twenty-six, and a server that is itself started through `npx` -- most are --
 * would inherit `npm_config_package` and `npm_config_yes` and could resolve
 * the wrong package entirely.
 */
const LAUNCHER = /^(SYNARTESIS_|npm_)/;
const LAUNCHER_EXACT = new Set(["INIT_CWD", "NODE"]);

function ownedByTheLauncher(name: string): boolean {
  return LAUNCHER.test(name) || LAUNCHER_EXACT.has(name);
}

/** `${NAME}` in a manifest value, the only reference form the policy defines. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * A manifest `env` value with its `${VAR}` references filled in.
 *
 * Done when the server is started rather than when the policy is read. Reading
 * the policy expanded every server's references and refused if any was unset,
 * so undoing a filesystem session failed unless the GitHub token happened to
 * be exported in that terminal, and a proxy started for `--server memory`
 * refused to start over a variable that only `github` needed.
 */
export function expandReferences(
  server: string,
  key: string,
  value: string,
  lookup: (name: string) => string | undefined,
): string {
  return value.replace(REFERENCE, (whole, name: string) => {
    const found = lookup(name);
    if (found === undefined) {
      throw new ManifestError(
        `server ${server} needs ${whole} for ${key}, and it is not set; ` +
          `set ${name} where this server is started, or write the value in the policy`,
      );
    }
    return found;
  });
}

function present(env: NodeJS.ProcessEnv | Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The environment a server is started with, or `undefined` for the SDK's
 * minimal default.
 *
 * Manifest `env` is layered last in every case: it is the one place a person
 * wrote down deliberately what this server should see, so it wins.
 */
export function upstreamEnv(
  server: string,
  spec: ServerSpec,
  source: EnvSource,
): Record<string, string> | undefined {
  // Stripped in both the proxy and the person's case: `undo` can be run
  // through `npx` too, and carries the same launcher variables into whatever
  // it starts.
  const own = Object.fromEntries(
    Object.entries(present(process.env)).filter(([name]) => !ownedByTheLauncher(name)),
  );
  const base: Record<string, string> =
    source.kind === "inherit"
      ? own
      : source.kind === "client"
        ? { ...(source.own === false ? {} : own), ...source.env }
        : {};

  const lookup = (name: string): string | undefined => base[name] ?? process.env[name];
  const declared: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    declared[key] = expandReferences(server, key, value, lookup);
  }

  if (source.kind === "manifest") {
    return spec.env === undefined ? undefined : declared;
  }
  return { ...base, ...declared };
}

/** A variable that was not set, told apart from one set to the empty string. */
const ABSENT = "-";

/**
 * A keyed fingerprint of each named variable, never the value.
 *
 * What an undo compares against before it starts a server again, so it can
 * refuse to reach a different store from the one the session wrote to -- a
 * memory server whose `MEMORY_FILE_PATH` has been changed in the client since
 * -- instead of sending its inverse there and reporting success. Only the names
 * the client entry or the policy declared are fingerprinted: the rest of a
 * shell's environment differs between any two terminals and would make every
 * undo look like a mismatch.
 */
export function fingerprint(
  key: Buffer,
  env: Readonly<Record<string, string>> | undefined,
  names: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...new Set(names)].sort()) {
    const value = env?.[name];
    out[name] = value === undefined ? ABSENT : createHmac("sha256", key).update(value).digest("hex");
  }
  return out;
}

/** The variables whose fingerprint is not what the session recorded. */
export function differing(
  recorded: Readonly<Record<string, string>>,
  now: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.keys(recorded)
    .filter((name) => recorded[name] !== now[name])
    .sort();
}

/** What the client entry and the policy say this server is given, by name. */
export function declaredNames(
  spec: ServerSpec,
  client: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  return [...new Set([...Object.keys(spec.env ?? {}), ...Object.keys(client ?? {})])].sort();
}
