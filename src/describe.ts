import { basename } from "node:path";

import type { ActionRow } from "./journal/journal.js";

/**
 * Saying what happened, in the words someone would use.
 *
 * The views printed a class and a status side by side -- "reversible
 * rolled_back" -- which are the two things the code cares about and neither of
 * the two things a person does. What they want to know is which file, and
 * whether it still needs them. A row that says `edit_file` twelve times over
 * makes a list of twelve identical-looking lines out of twelve different
 * edits.
 */

/** The argument that says what was acted on: usually a path, sometimes an id. */
const SUBJECT_KEYS = [
  "path",
  "file_path",
  "source",
  "destination",
  "id",
  "name",
  "key",
  "entity",
  "query",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function subject(args: unknown): string {
  if (!isRecord(args)) {
    return "";
  }
  const record = args;
  for (const key of SUBJECT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value !== "") {
      // The last segment is the part that differs between rows; the directory
      // is the same on every line and pushes the useful half off the screen.
      return value.includes("/") ? basename(value) : value;
    }
  }
  // Some tools take a list rather than one thing. Say how many, not which.
  for (const value of Object.values(record)) {
    if (Array.isArray(value) && value.length > 0) {
      return `${String(value.length)} items`;
    }
  }
  return "";
}

/**
 * What this row means for the reader, and whether it is still their problem.
 *
 * `needs` is the only one that asks anything of them, which is why it is the
 * only one the views colour.
 */
export interface Plain {
  readonly text: string;
  readonly needs: boolean;
}

export function plainly(action: ActionRow): Plain {
  switch (action.status) {
    case "gated":
      return { text: "waiting for you", needs: true };
    case "applied":
      return action.class === "readonly"
        ? { text: "read", needs: false }
        : action.inverse === undefined
          ? { text: "done, cannot undo", needs: false }
          : { text: "done, can undo", needs: false };
    case "rolled_back":
      return { text: "undone", needs: false };
    case "rolling_back":
      return { text: "undoing", needs: false };
    case "denied":
      return { text: "refused", needs: false };
    case "failed":
      return { text: "failed", needs: false };
    case "approved":
      return { text: "approved, not yet sent", needs: true };
    case "pending":
      return { text: "sent, outcome unknown", needs: true };
    case "unrecoverable":
      return { text: "cannot be undone", needs: true };
    default:
      return { text: action.status, needs: false };
  }
}

/** `sim.edit_file` is two facts; the tool is the one that varies down a list. */
export function toolOnly(action: ActionRow): string {
  return action.tool;
}
