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
