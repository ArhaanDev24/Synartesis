import type { Manifest } from "./types.js";

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
      return "checked against the real server";
    case "documented":
      return "written from documentation, never run against the real server";
    case "unstated":
      return "no claim either way";
  }
}

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
