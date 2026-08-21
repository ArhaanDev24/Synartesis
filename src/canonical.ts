/**
 * A stable text form of a json value.
 *
 * Key order carries no meaning in json, and nothing obliges an agent to
 * serialise the same arguments the same way twice. Anywhere two values are
 * compared for sameness -- state against recorded state, a retried call
 * against the approval that was granted for it -- the comparison has to be on
 * meaning rather than on spelling.
 */
export function canonical(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
