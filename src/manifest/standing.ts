import { createPolicyResolver } from "./match.js";
import { qualify, type Manifest } from "./types.js";

export interface Standing {
  readonly server: string;
  readonly provenance: "live" | "documented" | "unstated";
}

/** What each server's policy claims about its own testing, in one place. */
export function standing(manifest: Manifest): readonly Standing[] {
  return Object.entries(manifest.servers).map(([server, spec]) => ({
    server,
    provenance: spec.provenance ?? "unstated",
  }));
}

/** The servers whose policies say outright that nothing has tested them. */
export function untested(manifest: Manifest): readonly string[] {
  return standing(manifest)
    .filter((entry) => entry.provenance === "documented")
    .map((entry) => entry.server);
}

/**
 * One line a person can act on.
 *
 * Said for every server rather than only the untested ones: if silence meant
 * "fine", a policy nobody has graded and a policy known to be untested would
 * look identical from here, and the quiet one is the one that hurts.
 */
export function describeStanding(entry: Standing): string {
  switch (entry.provenance) {
    case "live":
      // Not "checked against the real server", which is what this said and
      // which readers took, reasonably, to mean undo had been tested. It has
      // not: `live` says the tools and their arguments are as that server
      // describes them, and a policy can be right about every one of those and
      // still record an inverse that does not restore anything. The README
      // said memory's recovery was unproven while this line called the same
      // policy checked, and a reader who met only one of the two came away
      // with the opposite of what the other meant.
      return "shapes read from the real server";
    case "documented":
      return "written from documentation, never run against the real server";
    case "unstated":
      return "no claim either way";
  }
}

/**
 * The footnote `live` needs, and the reason it is said separately.
 *
 * Nothing in a manifest can attest that undo works: anyone may write any
 * provenance they like, and a tool grading its own user's work would be worth
 * nothing anyway. So the line above says what was actually checked, and this
 * says plainly what was not -- once, under the list, rather than repeated
 * against every server.
 *
 * It named the shipped policies at first, which was true and in the wrong
 * place: this prints for whatever manifest is loaded, so somebody checking a
 * policy they wrote themselves was told which of Synartesis's four files had
 * been round-tripped. Which those are belongs in the documentation, where it
 * is about Synartesis; here the sentence has to be about the file in hand.
 */
export const LIVE_IS_NOT_RECOVERY =
  "`live` means the policy has met its server, not that undo has been " +
  "round-tripped against it. Whether it puts anything back is a separate " +
  "question, and only a test against the real server answers it.";

/**
 * What to say when a policy that has never met its server is about to be
 * trusted. Deliberately about undo rather than about correctness: a policy can
 * be entirely reasonable and still record an inverse that does not work, and
 * that failure only shows up at the moment somebody needs it.
 */
export function warnUntested(servers: readonly string[]): string {
  const names = servers.join(", ");
  const these = servers.length === 1 ? "this policy has" : "these policies have";
  return (
    `${names}: ${these} never been run against the real server. ` +
    `The classes and inverses here come from documentation, so undo may not work ` +
    `where it says it will. Run \`synartesis check\` against your own credentials, ` +
    `and expect to correct something.`
  );
}


export interface Ungoverned {
  readonly server: string;
  /** Advertised by the server, matched by nothing in the manifest. */
  readonly tools: readonly string[];
}

/**
 * Which tools a server offers that no policy in the manifest claims.
 *
 * They are not a fault: an unmatched tool is fail-closed as irreversible and
 * guarded (D4), which is the safe end of the trade and is the behaviour this
 * is built on. The fault was only ever that nobody said which ones they were.
 * `check` connects to every server and reads its whole tool list to verify the
 * policies, so the answer was already in hand and thrown away -- and the first
 * time anyone learned a tool was ungoverned was an agent stopping on it,
 * mid-task, waiting for a person who did not know it was coming.
 *
 * Named here so that gate is chosen rather than discovered.
 */
/**
 * Whether the proxy takes this server's word that a tool is read-only, for a
 * tool no rule mentions. One answer, used by the proxy and by everything that
 * predicts what the proxy will do, so the two cannot disagree.
 *
 * Not on a pinned server: pinning is a person vouching for each tool by hand,
 * and a server's own mark is exactly what they chose not to rely on.
 */
export function trustsMarks(manifest: Manifest, server: string): boolean {
  return manifest.servers[server]?.trustAnnotations !== false && manifest.pins?.[server] === undefined;
}

export function ungoverned(
  manifest: Manifest,
  advertised: ReadonlyMap<string, readonly string[]>,
): readonly Ungoverned[] {
  const resolver = createPolicyResolver(manifest);
  const found: Ungoverned[] = [];
  for (const server of [...advertised.keys()].sort()) {
    const tools = (advertised.get(server) ?? [])
      .filter((tool) => !resolver.resolve(qualify(server, tool)).matched)
      .sort();
    if (tools.length > 0) {
      found.push({ server, tools });
    }
  }
  return found;
}
