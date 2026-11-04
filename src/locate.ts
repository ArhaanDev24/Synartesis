import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Where the policy and the journal are, when nobody said.
 *
 * Typing --manifest and --journal on every command is the friction people
 * actually feel. A policy that belongs to a project sits in it, so both are
 * looked for the way a version control tool looks for its root: from here,
 * upwards, until found.
 *
 * And when there is nothing above you either, there is one home. Most of what
 * anyone guards -- an agent's memory, a notes directory, an account somewhere
 * -- does not belong to a project at all, and making each one its own
 * directory with its own manifest and its own journal is how a home ends up
 * with synartesis-this and synartesis-that in it and no single place that
 * knows what an agent has done.
 */
export const MANIFEST_NAME = "synartesis.yaml";
export const JOURNAL_NAME = "journal.db";
const NESTED_JOURNAL = join(".synartesis", JOURNAL_NAME);

/** Overridable, so a test never has to touch the real one. */
export function home(): string {
  // Empty is unset. `??` let "" through, and the policy and journal became
  // relative paths that the proxy and the CLI resolved from different places.
  const given = process.env["SYNARTESIS_HOME"];
  return given === undefined || given.trim() === "" ? join(homedir(), ".synartesis") : resolve(given);
}

/**
 * Whether a file found by walking up may be used: one this user owns.
 *
 * The walk climbs to the root, and on a shared machine the directories on the
 * way -- /tmp above all -- are writable by anybody. A policy planted there
 * names the commands the proxy will start; a journal planted there can carry
 * approvals. Neither is taken from someone else. Where ownership cannot be
 * asked (Windows), anything found is used, as before.
 */
function ours(path: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return true;
  }
  try {
    return statSync(path).uid === uid;
  } catch {
    return false;
  }
}

function walkUp(from: string, name: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && ours(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function findManifest(given?: string): string {
  if (given !== undefined) {
    return given;
  }
  return walkUp(process.cwd(), MANIFEST_NAME) ?? join(home(), MANIFEST_NAME);
}

/**
 * A journal beside the manifest, since that is where a proxy started from that
 * manifest will have been told to put one. Falls back to the nested default so
 * an existing setup keeps working.
 */
export function findJournal(given?: string, manifest?: string): string {
  if (given !== undefined) {
    return given;
  }

  const near = manifest === undefined ? undefined : dirname(resolve(manifest));
  for (const dir of [near, process.cwd()]) {
    if (dir === undefined) {
      continue;
    }
    for (const name of [JOURNAL_NAME, NESTED_JOURNAL]) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && ours(candidate)) {
        return candidate;
      }
    }
  }

  const found = walkUp(process.cwd(), NESTED_JOURNAL) ?? walkUp(process.cwd(), JOURNAL_NAME);
  if (found !== undefined) {
    return found;
  }

  // Nothing exists yet. Beside the policy, so the proxy that creates it and the
  // cli that reads it agree without either being told where to look.
  return near === undefined ? join(home(), JOURNAL_NAME) : join(near, JOURNAL_NAME);
}
