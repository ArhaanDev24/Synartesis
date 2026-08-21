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
