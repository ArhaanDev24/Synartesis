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
const READ_ONLY = /^(select|with|show|explain|describe|desc|values|table)\b/;

function isReadOnlyStatement(text: string): boolean {
  const stripped = text
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
  if (!READ_ONLY.test(stripped.toLowerCase())) {
    return false;
  }
  // More than one statement means the leading SELECT says nothing about what
  // follows it.
  return stripped.replace(/;\s*$/, "").indexOf(";") === -1;
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
