import { resolve, sep } from "node:path";

import type { ActionRow, Journal } from "../../src/journal/journal.js";
import type { TouchedFile } from "../shared/ipc.js";

/**
 * What has happened to the files in a folder, from the journal alone.
 *
 * The journal already knows every resource an agent touched, in which session,
 * whether the state it replaced was captured, and whether it has since been
 * put back. Nobody could see any of that without knowing a session id first,
 * which is the wrong way round: people think in folders, not in sessions.
 *
 * Read-only and cheap. It does not go near the disk -- it does not even check
 * that a file still exists -- because the question here is what was done, not
 * what is true now. Asking what is true now costs a call per resource and is
 * what `Check` is for.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Absolute-looking strings out of a call's arguments.
 *
 * Deliberately strict: only strings that begin at a root. A tool's arguments
 * also carry the contents it wrote, and prose is full of slashes -- matching
 * anything that merely looks path-ish would list a file for every sentence
 * that mentioned one.
 */
export function pathsIn(args: unknown, found: string[] = []): string[] {
  if (typeof args === "string") {
    if (args.startsWith("/") || /^[A-Za-z]:[\\/]/.test(args)) {
      found.push(args);
    }
    return found;
  }
  if (Array.isArray(args)) {
    for (const one of args) {
      pathsIn(one, found);
    }
    return found;
  }
  if (isRecord(args)) {
    for (const value of Object.values(args)) {
      pathsIn(value, found);
    }
  }
  return found;
}

function under(folder: string, path: string): boolean {
  const root = resolve(folder);
  const target = resolve(path);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** One file's running tally, before it is frozen into a `TouchedFile`. */
interface Tally {
  changes: number;
  recoverable: number;
  undone: number;
  held: number;
  lastAt: string;
  lastTool: string;
  sessions: Set<string>;
}

function count(tally: Tally, action: ActionRow): void {
  tally.sessions.add(action.runId);
  if (action.ts > tally.lastAt) {
    tally.lastAt = action.ts;
    tally.lastTool = `${action.server}.${action.tool}`;
  }
  if (action.status === "gated" || action.status === "denied") {
    tally.held += 1;
    return;
  }
  if (action.status === "rolled_back") {
    tally.undone += 1;
    return;
  }
  if (action.status !== "applied" && action.status !== "unrecoverable") {
    return;
  }
  tally.changes += 1;
  if (action.status === "applied" && action.inverse !== undefined && action.inverse !== null) {
    tally.recoverable += 1;
  }
}

export function touchedUnder(journal: Journal, folder: string): TouchedFile[] {
  const files = new Map<string, Tally>();
  for (const run of journal.listRuns()) {
    for (const action of journal.getActions(run.id)) {
      // A read tells you nothing about what happened to a file, and listing
      // every file an agent glanced at would bury the handful it changed.
      if (action.class === "readonly") {
        continue;
      }
      for (const path of new Set(pathsIn(action.args))) {
        if (!under(folder, path)) {
          continue;
        }
        const seen = files.get(path) ?? {
          changes: 0,
          recoverable: 0,
          undone: 0,
          held: 0,
          lastAt: "",
          lastTool: "",
          sessions: new Set<string>(),
        };
        count(seen, action);
        files.set(path, seen);
      }
    }
  }

  return [...files.entries()]
    .map(([path, tally]): TouchedFile => ({
      path,
      changes: tally.changes,
      recoverable: tally.recoverable,
      undone: tally.undone,
      held: tally.held,
      lastAt: tally.lastAt,
      lastTool: tally.lastTool,
      sessions: [...tally.sessions],
    }))
    // Most recently touched first: the thing somebody is looking for is
    // almost always the thing that just happened to them.
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
