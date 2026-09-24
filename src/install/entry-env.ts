import { resolve } from "node:path";

import {
  ConfigError,
  discover,
  expandForClient,
  serversAt,
  type ClientId,
  type ServerEntry,
} from "./clients.js";
import { isWrapped } from "./install.js";

/**
 * What a client gives the server it starts through the proxy.
 *
 * The environment and working directory a server was actually run with live
 * in the client's config, on the entry `install` wrapped -- not in the policy,
 * and not in whatever terminal somebody later runs `undo` from. A terminal has
 * no `SLACK_BOT_TOKEN`, and a memory server started without the client's
 * `MEMORY_FILE_PATH` opens its default file instead: the inverse is sent to a
 * different store from the one the session wrote, and the undo reports
 * success. So anything a person starts -- undo, check, pin, the desktop
 * window -- reads it from here.
 *
 * Read from the live entry each time rather than copied anywhere, so a token
 * the person rotates is followed, and no second copy of a secret is written.
 */
export interface ClientServerEnv {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Which client entry it came from, for a message that has to name it. */
  readonly from: string;
}

function argAfter(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

function expanded(client: ClientId, env: ServerEntry["env"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    out[key] = expandForClient(client, value);
  }
  return out;
}

function sameEnv(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * The environment the client gives `server` under the policy at
 * `manifestPath`, or `undefined` when no client entry wraps it -- a
 * hand-written setup, where the policy's own `env` is all there is.
 *
 * Two entries wrapping the same server with *different* environments is
 * refused rather than resolved by picking one: that is two different servers
 * sharing a name, and undoing one with the other's credentials is the wrong
 * answer delivered confidently.
 */
export function clientEnvFor(
  manifestPath: string,
  server: string,
  cwd: string = process.cwd(),
): ClientServerEnv | undefined {
  const wanted = resolve(manifestPath);
  const found: ClientServerEnv[] = [];
  for (const site of discover(cwd)) {
    let entries: Record<string, ServerEntry>;
    try {
      entries = serversAt(site);
    } catch {
      // A config that cannot be read wraps nothing this can see. Whatever is
      // wrong with it is status's to report, not undo's.
      continue;
    }
    for (const [name, entry] of Object.entries(entries)) {
      if (!isWrapped(entry)) {
        continue;
      }
      const args = entry.args ?? [];
      const manifest = argAfter(args, "--manifest");
      if (argAfter(args, "--server") !== server || manifest === undefined) {
        continue;
      }
      if (resolve(manifest) !== wanted) {
        continue;
      }
      found.push({
        env: expanded(site.client, entry.env),
        ...(entry.cwd === undefined ? {} : { cwd: expandForClient(site.client, entry.cwd) }),
        from: `${site.label} (${site.scope}) entry ${name}`,
      });
    }
  }

  const [first, ...rest] = found;
  if (first === undefined) {
    return undefined;
  }
  const differing = rest.filter((other) => !sameEnv(other.env, first.env) || other.cwd !== first.cwd);
  if (differing.length > 0) {
    throw new ConfigError(
      `server ${server} is wrapped by more than one client entry, with different settings: ` +
        [first, ...differing].map((one) => one.from).join("; ") +
        `. Starting it with one of them could act on a different store from the one a session used, so it is not started.`,
    );
  }
  return first;
}
