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
      // Two very different things wear this status. Without an inverse the
      // action is permanent and nothing will ever change that. With one, it
      // was recoverable until somebody changed the resource afterwards --
      // which is a conflict a person can resolve, not a dead end.
      return action.inverse === undefined
        ? { text: "cannot be undone", needs: true }
        : { text: "changed since; not safe to undo", needs: true };
    default:
      return { text: action.status, needs: false };
  }
}

/** `sim.edit_file` is two facts; the tool is the one that varies down a list. */
export function toolOnly(action: ActionRow): string {
  return action.tool;
}

/** Bytes as a person says them. */
function size(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} kB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The arguments as a line somebody can read.
 *
 * What was there was `JSON.stringify(args)` cut at a fixed width, which is
 * unreadable and lossy at once: you cannot see what the call did, and you
 * cannot see what was removed either. Short values are shown; long ones are
 * described by their size, which is the useful fact about a file's contents in
 * a list. `synartesis show --full` prints the whole thing.
 */
export function summariseArgs(args: unknown, limit = 60): string {
  if (!isRecord(args)) {
    // Anything that is not an object has no keys to summarise; JSON is then
    // the honest rendering, and String() on an object is "[object Object]".
    return args === undefined ? "" : JSON.stringify(args);
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      parts.push(value.length > 48 ? `${key} ${size(Buffer.byteLength(value))}` : `${key} ${value}`);
      continue;
    }
    if (Array.isArray(value)) {
      parts.push(`${key} ${String(value.length)} items`);
      continue;
    }
    if (value === null || typeof value !== "object") {
      parts.push(`${key} ${String(value)}`);
      continue;
    }
    parts.push(`${key} ${size(Buffer.byteLength(JSON.stringify(value)))}`);
  }
  const line = parts.join("  ");
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}\u2026`;
}
