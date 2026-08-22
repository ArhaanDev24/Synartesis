import { ManifestError } from "../errors.js";
import type { Manifest } from "../manifest/types.js";
import type { Upstream } from "./upstream.js";

/**
 * A dot cannot be used to namespace tool names: many MCP clients constrain
 * tool names to [A-Za-z0-9_-], and a name the client rejects is a tool the
 * agent cannot call at all.
 */
export const SEPARATOR = "__";

export interface Route {
  readonly upstream: Upstream;
  /** The name as the upstream knows it, with any prefix removed. */
  readonly tool: string;
}

export interface Router {
  readonly prefixed: boolean;
  readonly upstreams: readonly Upstream[];
  expose(server: string, name: string): string;
  route(exposed: string): Route | undefined;
  byName(server: string): Upstream | undefined;
}

export function createRouter(upstreams: readonly Upstream[], manifest: Manifest): Router {
  if (upstreams.length === 0) {
    throw new ManifestError("no upstream servers were connected");
  }

  for (const upstream of upstreams) {
    if (!(upstream.name in manifest.servers)) {
      throw new ManifestError(
        `upstream ${upstream.name} is connected but not declared in the manifest`,
      );
    }
    if (upstream.name.includes(SEPARATOR) || upstream.name.includes(".")) {
      throw new ManifestError(
        `server name ${upstream.name} may not contain "." or "${SEPARATOR}"; both are reserved for qualifying tool names`,
      );
    }
  }

  const byName = new Map(upstreams.map((upstream) => [upstream.name, upstream]));
  if (byName.size !== upstreams.length) {
    throw new ManifestError("two upstreams were connected under the same name");
  }

  // With one server there is nothing to disambiguate, so names pass through
  // untouched and the proxy stays invisible. Adding a second server is an
  // explicit edit to the manifest, so the rename that comes with it is not a
  // surprise; what would be surprising is a name whose meaning depends on
  // which other servers happen to be configured beside it.
  const prefixed = upstreams.length > 1;

  // Longest first so that servers named `a` and `a_b` cannot both claim the
  // same exposed name.
  const keys = [...byName.keys()].sort((a, b) => b.length - a.length);

  return {
    prefixed,
    upstreams,
    expose(server: string, name: string): string {
      return prefixed ? `${server}${SEPARATOR}${name}` : name;
    },
    route(exposed: string): Route | undefined {
      if (!prefixed) {
        const only = upstreams[0];
        if (only === undefined) {
          return undefined;
        }
        // The qualified name works here too. Guarding one server advertises
        // `write_file` and guarding two advertises `fs__write_file`, so a name
        // written down against one setup was rejected by the other -- and in
        // this direction it was not even rejected: any unknown name routed to
        // the only server, missed the policy written for `fs.write_file`, and
        // was held for a human to approve as something that could not be
        // undone. A read, held for approval, because it was spelled the way
        // the other setup spells it.
        //
        // Only this server's own name is unwrapped; a tool whose real name
        // begins with it would be written `fs.fs__write_file` in the manifest.
        const prefix = `${only.name}${SEPARATOR}`;
        return exposed.startsWith(prefix)
          ? { upstream: only, tool: exposed.slice(prefix.length) }
          : { upstream: only, tool: exposed };
      }
      for (const key of keys) {
        const prefix = `${key}${SEPARATOR}`;
        if (exposed.startsWith(prefix)) {
          const upstream = byName.get(key);
          if (upstream !== undefined) {
            return { upstream, tool: exposed.slice(prefix.length) };
          }
        }
      }
      return undefined;
    },
    byName(server: string): Upstream | undefined {
      return byName.get(server);
    },
  };
}
