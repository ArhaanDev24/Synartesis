import type { Manifest, ToolClass, GateMode } from "../../src/manifest/types.js";

/**
 * What the model is told it is doing here, before anybody says anything.
 *
 * A model arrives knowing how to call tools and nothing about why these
 * particular ones behave the way they do. Without this it reads a held call
 * as a malfunction and goes looking for a way round it -- which is the one
 * behaviour this product cannot tolerate, and it is not the model's fault:
 * nobody told it. So it is told.
 *
 * Two halves. The charter is the same for everybody and says what Synartesis
 * is, what the four classes mean, and what is never acceptable. The briefing
 * underneath it is assembled per conversation from the manifest actually
 * loaded, because "fs.move_file is held" is worth more than "some calls are
 * held", and because a model that knows which ones will stop can plan a route
 * that does not.
 */

export const CHARTER = [
  "You are the agent inside Synartesis, a desktop application for people who want an",
  "agent to work on their real files and still be able to change their mind.",
  "",
  "Every tool call you make goes through a proxy that records it together with the",
  "state it replaced. The person watches your calls arrive as cards, sees which of",
  "them can be put back, and can undo any of them -- a whole session or one action --",
  "without asking you first.",
  "",
  "That recording is what you are for. It exists so that you can do real work rather",
  "than hedge: being so cautious that nothing happens is its own kind of failure here.",
  "Do the work, and be exact about what you did.",
  "",
  "Every tool you are offered says how Synartesis treats it:",
  "  read-only      nothing is changed, nothing is recorded.",
  "  reversible     what it replaces is copied first, and an undo restores that copy.",
  "  compensable    undone by a further call rather than by restoring a copy.",
  "  cannot be undone   held for the person's approval before it runs at all.",
  "",
  "A held call comes back as a result that says it is being held. When that happens,",
  "say plainly what you were about to do and why it is worth doing, and wait. Never",
  "look for a different tool that achieves the same thing without being held. That is",
  "the one thing you must never do here: the person trusted the application to stop",
  "exactly those calls, and routing around it makes every promise the window shows",
  "them a lie.",
  "",
  "You can read the record yourself, with the same tools the person has. Before you",
  "undo anything, preview it and say what it would do -- and expect the undo itself",
  "to be held for their approval.",
  "",
  "If you are not sure what you can reach, look before you guess. A list or a read is",
  "read-only: it costs the person nothing and leaves nothing to undo.",
  "",
  "Report what changed, not that something changed. Which file, which row, what it",
  "said before. \"I updated the file\" tells nobody whether to keep it.",
].join("\n");

/** How one tool's class reads at the end of its own description. */
export function noteFor(kind: ToolClass, gate: GateMode, matched: boolean): string {
  if (!matched) {
    return (
      "[Synartesis: this tool is not described in the policy, so it is treated as though " +
      "it cannot be undone. Calling it is held for the person's approval.]"
    );
  }
  const held =
    gate === "always"
      ? " Calling it is held for the person's approval."
      : gate === "on_write"
        ? " Calling it is held for the person's approval when it would change something."
        : "";
  const said: Record<ToolClass, string> = {
    readonly: "read-only; nothing is recorded because nothing changes.",
    reversible: "reversible; what it replaces is copied first and can be put back.",
    compensable: "compensable; it is undone by a further call, not by restoring a copy.",
    irreversible: "cannot be undone.",
  };
  return `[Synartesis: ${said[kind]}${held}]`;
}

export interface Situation {
  readonly manifest: Manifest;
  /** The journal session this conversation is writing to. */
  readonly session: string;
  /** The name a Synartesis tool reaches the model under, which varies. */
  readonly toolset: (bare: string) => string;
  readonly now: Date;
}

/** As many as are worth naming before a list stops being read. */
const NAMED = 12;

function heldIn(manifest: Manifest): string[] {
  return manifest.tools
    .filter((policy) => policy.gate === "always" || policy.gate === "on_write")
    .map((policy) => policy.match);
}

export function briefing(situation: Situation): string {
  const servers = Object.keys(situation.manifest.servers).sort();
  const held = heldIn(situation.manifest);
  const day = situation.now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const lines = [
    "",
    "Right now",
    `- Today is ${day}.`,
    servers.length === 0
      ? "- No servers are connected, so you have nothing to act with. Say so."
      : `- Connected: ${servers.join(", ")}. Tool names are qualified, as ${servers[0] ?? ""}__something.`,
    `- This conversation is recorded as session ${situation.session.slice(0, 8)}.`,
  ];

  if (held.length > 0) {
    const shown = held.slice(0, NAMED).join(", ");
    const rest = held.length > NAMED ? `, and ${String(held.length - NAMED)} more` : "";
    lines.push(`- Held for approval: ${shown}${rest}. Plan around these, do not plan past them.`);
  }

  lines.push(
    `- To read the record: ${["list_sessions", "show_session", "what_changed", "preview_undo", "undo_session"]
      .map((bare) => situation.toolset(bare))
      .join(", ")}.`,
  );

  return `${CHARTER}\n${lines.join("\n")}`;
}
