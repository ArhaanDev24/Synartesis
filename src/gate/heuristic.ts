/**
 * The `on_write` heuristic for tools whose destructiveness cannot be decided
 * statically, such as a raw SQL runner.
 *
 * This is a heuristic and is documented as one. It exists because the
 * alternative for `postgres.query` is to gate every SELECT, which no operator
 * would tolerate for long. Anything it cannot confidently read as a read is
 * gated (D4): failing to recognise a statement is not evidence that it is safe.
 * `always` remains the correct choice wherever certainty matters.
 */

/** How a statement may begin if it is to be read as a read. */
const READ_ONLY = /^(select|with|show|explain|describe|desc|values|table)\b/;

/**
 * Words that mean something is going to change, wherever they appear.
 *
 * Reading only the first word was not enough, and the two statements that got
 * through were not exotic:
 *
 *   WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x
 *   EXPLAIN ANALYZE DELETE FROM users
 *
 * The first is an ordinary PostgreSQL data-modifying CTE; the second runs the
 * statement it claims to be explaining, which is what ANALYZE means. Both
 * begin with a word on the list above, neither contains a semicolon, and both
 * were passed through ungated while deleting every row in a table. The
 * heuristic's own promise is that anything it cannot confidently read as a
 * read is gated, and these were read confidently and wrongly.
 *
 * So the leading word decides whether this could be a read, and this decides
 * whether anything in it writes.
 *
 * Broad, but not so broad that it gates ordinary reads: the whole reason
 * `on_write` exists is that gating every SELECT is the thing no operator
 * tolerates, so a heuristic that fires on innocent statements does not fail
 * safe -- it gets turned off. `analyze` was on this list for one draft and
 * gated `EXPLAIN ANALYZE SELECT 1`, which writes nothing; what makes
 * `EXPLAIN ANALYZE DELETE FROM users` dangerous is the `delete` in it, and
 * that is already here. The words left are ones that cannot appear in a read
 * except inside a literal, and literals are removed before this is applied.
 */
const WRITES =
  /\b(insert|update|delete|merge|upsert|replace|truncate|drop|alter|create|grant|revoke|vacuum|attach|detach|reindex|call|do|copy|lock|pragma|into)\b/;

/**
 * The statement with everything that is not code taken out.
 *
 * Comments first, so a write keyword cannot hide in one. Then quoted strings
 * and quoted identifiers, so `SELECT 'delete from users'` -- which writes
 * nothing -- is not gated on the strength of a word inside a literal. Both
 * doublings (`''` and `""`) are the escapes SQL defines, and each closes and
 * immediately reopens, so a simple non-greedy match handles them.
 */
function code(text: string): string {
  return text
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " ")
    .replace(/"(?:[^"]|"")*"/g, " ")
    .trim();
}

function isReadOnlyStatement(text: string): boolean {
  const stripped = code(text);
  if (!READ_ONLY.test(stripped.toLowerCase())) {
    return false;
  }
  // More than one statement means the leading SELECT says nothing about what
  // follows it.
  if (stripped.replace(/;\s*$/, "").indexOf(";") !== -1) {
    return false;
  }
  return !WRITES.test(stripped.toLowerCase());
}

export function shouldGateOnWrite(args: unknown): boolean {
  if (typeof args !== "object" || args === null) {
    return true;
  }
  const strings = Object.values(args).filter(
    (value): value is string => typeof value === "string",
  );
  if (strings.length === 0) {
    return true;
  }
  return !strings.every(isReadOnlyStatement);
}
