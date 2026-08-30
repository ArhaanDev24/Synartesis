/**
 * The taxonomy from spec 3.5. Classes are added as the phase that raises them
 * lands, so every class here has a live throw site.
 */
export abstract class SynartesisError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/**
 * An invalid or unmatched policy. Carries a source location wherever the
 * manifest is at fault, because "never start with a broken policy" is only
 * useful if the operator is told which line to fix.
 */
export class ManifestError extends SynartesisError {
  readonly code = "MANIFEST_ERROR";

  constructor(
    message: string,
    readonly location?: SourceLocation,
  ) {
    super(
      location === undefined
        ? message
        : `${location.file}:${String(location.line)}:${String(location.column)}: ${message}`,
    );
  }
}

/** The wrapped server failed, or could not be reached at all. */
export class UpstreamError extends SynartesisError {
  readonly code = "UPSTREAM_ERROR";

  constructor(
    readonly server: string,
    readonly operation: string,
    cause: unknown,
  ) {
    super(`upstream ${server} failed during ${operation}: ${describe(cause)}`, { cause });
  }
}

/**
 * The pre-read failed, so the action must not proceed. A reversible action
 * without a snapshot is silently irreversible, which is the one outcome this
 * product exists to prevent.
 */
export class SnapshotError extends SynartesisError {
  readonly code = "SNAPSHOT_ERROR";

  constructor(
    readonly tool: string,
    reason: string,
    options?: { cause?: unknown; absent?: boolean },
  ) {
    super(`snapshot via ${tool} failed: ${reason}`, options);
    /**
     * The read reached the server and the server said no such resource, as
     * opposed to the read not completing at all. Only the former tells us
     * anything about the resource itself.
     */
    this.absent = options?.absent ?? false;
  }

  readonly absent: boolean;
}

/**
 * The longest string anywhere in a snapshot, which for anything file-shaped is
 * the contents. Found by looking rather than by field name: a snapshot is
 * whatever the server's read returned, and servers nest the payload
 * differently. Short strings are ignored so a path or an id is never mistaken
 * for the body.
 */
function longestString(value: unknown, best = ""): string {
  if (typeof value === "string") {
    return value.length > best.length ? value : best;
  }
  if (Array.isArray(value)) {
    let found = best;
    for (const item of value) {
      found = longestString(item, found);
    }
    return found;
  }
  if (typeof value === "object" && value !== null) {
    let found = best;
    for (const item of Object.values(value)) {
      found = longestString(item, found);
    }
    return found;
  }
  return best;
}

/** How many changed lines are worth printing before it stops being readable. */
const DIFF_BUDGET = 8;

/**
 * What changed, as lines, rather than both documents in full. Trims the common
 * head and tail so only the region that actually differs is shown.
 */
function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const show = (lines: readonly string[], mark: string): string[] => [
    ...lines.slice(0, DIFF_BUDGET).map((line) => `  ${mark} ${line}`),
    ...(lines.length > DIFF_BUDGET
      ? [`  ${mark} ... ${String(lines.length - DIFF_BUDGET)} more`]
      : []),
  ];

  return [
    `  at line ${String(head + 1)}:`,
    ...show(removed, "-"),
    ...show(added, "+"),
    `  ${String(removed.length)} removed, ${String(added.length)} added.`,
  ].join("\n");
}

/** A value with no text in it, kept short enough to read. */
function brief(value: unknown): string {
  // JSON.stringify returns undefined rather than a string for a top-level
  // undefined, and .length on that throws. Journal values are parsed JSON, so
  // this is the only one of its cases that can reach here.
  if (value === undefined) {
    return "undefined";
  }
  const text = JSON.stringify(value);
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}

/**
 * The resource changed after the agent touched it. Writing the old value back
 * would silently destroy whatever happened in between, so what differs is
 * carried here for a human to judge.
 *
 * What differs, not both documents in full: printing the whole expected and
 * actual contents of a 200-line file buried the one line that mattered in two
 * screens of escaped JSON. Both values are still on the row, and
 * `synartesis show <run>` prints them.
 */
export class DriftConflict extends SynartesisError {
  readonly code = "DRIFT_CONFLICT";

  constructor(
    readonly seq: number,
    readonly expected: unknown,
    readonly actual: unknown,
  ) {
    const before = longestString(expected);
    const after = longestString(actual);
    // Two texts to compare, and they are not the same text. Anything else --
    // a resource that is simply gone, a snapshot with no body in it -- has no
    // lines to diff, so it says what it has.
    const body =
      before !== "" && after !== "" && before !== after
        ? lineDiff(before, after)
        : `  expected: ${brief(expected)}\n  actual:   ${brief(actual)}`;

    super(
      `drift at sequence ${String(seq)}: the resource is not in the state this run left it in.\n${body}`,
    );
  }
}

/**
 * An inverse failed, so the run is partially reverted. Continuing past it would
 * produce a state that is neither the before nor the after (D6).
 */
export class RollbackHalted extends SynartesisError {
  readonly code = "ROLLBACK_HALTED";

  constructor(
    readonly seq: number,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`rollback halted at sequence ${String(seq)}: ${reason}`, options);
  }
}

/**
 * Not in spec 3.5, which covers failures on the proxy's forward path. A journal
 * write failing is different in kind: it means the record of what the agent did
 * is incomplete, so the call must not proceed. Always fatal, never swallowed.
 */
export class JournalError extends SynartesisError {
  readonly code = "JOURNAL_ERROR";

  constructor(operation: string, cause: unknown) {
    super(`journal ${operation} failed: ${describe(cause)}`, { cause });
  }
}

export function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return typeof cause === "string" ? cause : JSON.stringify(cause);
}
