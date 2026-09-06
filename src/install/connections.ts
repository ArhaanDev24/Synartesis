import { existsSync } from "node:fs";

import type { Journal } from "../journal/journal.js";
import { ago } from "../clock.js";
import { discover, serversAt, type ConfigSite } from "./clients.js";
import { isWrapped } from "./install.js";

/**
 * Every AI on this machine, and whether it is actually going through us.
 *
 * "Covered" is a fact about a config file. "Live" is a fact about the journal:
 * an action carries the server it went to, so the newest action for a server
 * is the last time anything really came through it. Nothing here inspects
 * processes -- a running client tells you nothing about what it is configured
 * to talk to, which is the only question being asked.
 */

export interface Connection {
  readonly client: string;
  readonly scope: string;
  readonly path: string;
  readonly server: string;
  readonly covered: boolean;
  /** The command cannot be found, so this server would not start either way. */
  readonly missing: boolean;
  /** ISO timestamp of the newest action through this server, if any. */
  readonly lastSeen?: string;
  readonly site: ConfigSite;
}

export interface ClientGroup {
  readonly label: string;
  readonly scope: string;
  readonly path: string;
  readonly connections: readonly Connection[];
  /** Set when the config could not be read at all. */
  readonly problem?: string;
}

/** Anything through this server within the window counts as active now. */
const ACTIVE_WITHIN_MS = 2 * 60 * 1000;

function lastSeenByServer(journal: Journal): Map<string, string> {
  const seen = new Map<string, string>();
  // Enough history to answer "when did this last do anything" for every server
  // somebody has, without reading a journal that may be very large.
  for (const action of journal.recentActions(500)) {
    const known = seen.get(action.server);
    if (known === undefined || action.ts > known) {
      seen.set(action.server, action.ts);
    }
  }
  return seen;
}

/** An absolute command that is not there; a bare name is left to PATH. */
function commandMissing(command: string | undefined): boolean {
  if (command === undefined) {
    return false;
  }
  return (command.includes("/") || command.includes("\\")) && !existsSync(command);
}

export function scan(journal: Journal | undefined, cwd: string): readonly ClientGroup[] {
  const seen = journal === undefined ? new Map<string, string>() : lastSeenByServer(journal);
  const groups: ClientGroup[] = [];

  for (const site of discover(cwd)) {
    let servers;
    try {
      servers = serversAt(site);
    } catch (error: unknown) {
      groups.push({
        label: site.label,
        scope: site.scope,
        path: site.path,
        connections: [],
        problem: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const connections: Connection[] = Object.entries(servers).map(([server, entry]) => {
      const covered = isWrapped(entry);
      const lastSeen = seen.get(server);
      return {
        client: site.client,
        scope: site.scope,
        path: site.path,
        server,
        covered,
        missing: commandMissing(entry.command),
        ...(lastSeen === undefined ? {} : { lastSeen }),
        site,
      };
    });
    groups.push({ label: site.label, scope: site.scope, path: site.path, connections });
  }

  return groups;
}

/** The one-line state, in the words the reader needs. */
export function stateOf(connection: Connection, now: Date = new Date()): string {
  if (connection.missing) {
    return "cannot start; the command is not there";
  }
  if (!connection.covered) {
    return "not covered";
  }
  if (connection.lastSeen === undefined) {
    return "covered, nothing through it yet";
  }
  const since = now.getTime() - new Date(connection.lastSeen).getTime();
  return since <= ACTIVE_WITHIN_MS ? "covered, active now" : `covered, last used ${ago(connection.lastSeen, now)}`;
}

export function needsConnecting(groups: readonly ClientGroup[]): readonly Connection[] {
  return groups.flatMap((group) =>
    group.connections.filter((connection) => !connection.covered && !connection.missing),
  );
}
