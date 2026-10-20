/**
 * A name as a YAML mapping key. Bare where YAML reads it back as the same
 * string; quoted otherwise. A tool called `null` or `true`, or one beginning
 * `&`, `*` or `-`, written bare, came back as something else or did not load.
 */
export function yamlKey(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) && !RESERVED.has(name.toLowerCase())
    ? name
    : JSON.stringify(name);
}

const RESERVED = new Set(["null", "true", "false", "yes", "no", "on", "off", "y", "n"]);
