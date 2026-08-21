import { ManifestError } from "../errors.js";
import type { TemplateValue } from "./types.js";

export interface TemplateContext {
  readonly args: unknown;
  readonly snapshot?: unknown;
  readonly result?: unknown;
}

const NAMESPACES = ["snapshot", "result"] as const;

interface Reference {
  readonly namespace: "args" | "snapshot" | "result";
  readonly path: string;
}

/**
 * Three namespaces and dotted paths, nothing else. Spec 3.2 is explicit that
 * the manifest must not become a language: the moment it grows expressions,
 * it stops being writable in fifteen minutes by someone who has never seen it.
 */
function parseReference(raw: string): Reference | undefined {
  if (!raw.startsWith("$")) {
    return undefined;
  }
  // A bare namespace means the whole value. Writing a file back needs the
  // entire captured contents, which is not a field of anything.
  if (raw === "$") {
    return { namespace: "args", path: "" };
  }
  // A namespace may be followed by a dot or straight by a subscript. Servers
  // that answer with a bare list are common -- the memory server's
  // create_entities returns the entities it actually created -- and
  // $result[].name is the only safe thing for its inverse to name.
  if (raw.startsWith("$.") || raw.startsWith("$[")) {
    return { namespace: "args", path: raw.slice(raw[1] === "." ? 2 : 1) };
  }
  for (const namespace of NAMESPACES) {
    if (raw === `$${namespace}`) {
      return { namespace, path: "" };
    }
    const head = `$${namespace}`;
    const after = raw.startsWith(head) ? raw.slice(head.length) : undefined;
    if (after !== undefined && (after.startsWith(".") || after.startsWith("["))) {
      return { namespace, path: after.startsWith(".") ? after.slice(1) : after };
    }
  }
  throw new ManifestError(
    `unknown interpolation namespace in ${raw}; expected $., $snapshot. or $result.`,
  );
}

type Segment =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "index"; readonly index: number }
  /** `[]`: apply the rest of the path to every element. */
  | { readonly kind: "each" };

/** Splits `items[1].id` and `labels[].name` into their steps. */
function segments(path: string, reference: string): Segment[] {
  const parts: Segment[] = [];
  for (const chunk of path.split(".")) {
    const match = /^([^[\]]*)((?:\[\d*\])*)$/.exec(chunk);
    if (match === null) {
      throw new ManifestError(`malformed path in ${reference}`);
    }
    const [, head = "", brackets = ""] = match;
    if (head !== "") {
      parts.push({ kind: "key", key: head });
    }
    for (const bracket of brackets.matchAll(/\[(\d*)\]/g)) {
      const index = bracket[1] ?? "";
      parts.push(index === "" ? { kind: "each" } : { kind: "index", index: Number(index) });
    }
  }
  if (parts.length === 0) {
    throw new ManifestError(`empty path in ${reference}`);
  }
  return parts;
}

function walk(current: unknown, parts: readonly Segment[], at: number, reference: string): unknown {
  const segment = parts[at];
  if (segment === undefined) {
    return current;
  }
  if (current === null || current === undefined) {
    throw new ManifestError(`${reference} is unresolvable: nothing to read from`);
  }

  switch (segment.kind) {
    case "each": {
      if (!Array.isArray(current)) {
        throw new ManifestError(`${reference} is unresolvable: [] needs a list to walk`);
      }
      // Projection, not a transform. It reads the same field from each element
      // and nothing more, which is what an API that returns objects and
      // accepts names needs, and is still only a path.
      return current.map((item) => walk(item, parts, at + 1, reference));
    }
    case "index": {
      if (!Array.isArray(current) || segment.index >= current.length) {
        throw new ManifestError(
          `${reference} is unresolvable: index ${String(segment.index)} is absent`,
        );
      }
      return walk(current[segment.index], parts, at + 1, reference);
    }
    case "key": {
      if (typeof current !== "object" || !(segment.key in current)) {
        throw new ManifestError(`${reference} is unresolvable: ${segment.key} is absent`);
      }
      const next: unknown = Object.getOwnPropertyDescriptor(current, segment.key)?.value;
      return walk(next, parts, at + 1, reference);
    }
  }
}

function read(root: unknown, path: string, reference: string): unknown {
  return walk(root, segments(path, reference), 0, reference);
}

/**
 * A reference appearing inside a larger string, such as a commit message that
 * names the path it is reverting. Only the dotted forms are recognised here: a
 * bare `$result` in the middle of a sentence is far more likely to be prose
 * than an interpolation.
 */
const EMBEDDED =
  /\$(?:snapshot|result)?\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d*\])*/g;

const ESCAPE = "\u0000synartesis-dollar\u0000";

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function resolveString(raw: string, context: TemplateContext): unknown {
  // A string that is nothing but a reference keeps the referenced value's
  // type. Anything else is text with references substituted into it, which is
  // what people write without being told they can.
  const whole = raw.startsWith("$$") ? undefined : parseReference(raw);
  if (whole !== undefined) {
    return readNamespace(whole, raw, context);
  }

  const escaped = raw.split("$$").join(ESCAPE);
  const substituted = escaped.replace(EMBEDDED, (token) => {
    const reference = parseReference(token);
    if (reference === undefined) {
      return token;
    }
    return stringify(readNamespace(reference, token, context));
  });
  return substituted.split(ESCAPE).join("$");
}

function readNamespace(reference: Reference, raw: string, context: TemplateContext): unknown {
  const root = context[reference.namespace];
  if (root === undefined) {
    throw new ManifestError(
      `${raw} refers to ${reference.namespace}, which is not available at this point`,
    );
  }
  return reference.path === "" ? root : read(root, reference.path, raw);
}

/** Array.isArray widens a readonly union to any[]; this keeps the element type. */
function isTemplateArray(value: TemplateValue): value is readonly TemplateValue[] {
  return Array.isArray(value);
}

export function resolveTemplate(template: TemplateValue, context: TemplateContext): unknown {
  if (typeof template === "string") {
    return resolveString(template, context);
  }
  if (isTemplateArray(template)) {
    return template.map((item) => resolveTemplate(item, context));
  }
  if (template !== null && typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, resolveTemplate(value, context)]),
    );
  }
  return template;
}

/** Every reference a template contains, used for load-time validation. */
export function referencesIn(template: TemplateValue): string[] {
  if (typeof template === "string") {
    if (template.startsWith("$$")) {
      return [];
    }
    if (parseReference(template) !== undefined) {
      return [template];
    }
    // Embedded references are validated too, so a namespace that is not
    // available at that point is reported when the manifest loads rather than
    // silently producing the wrong text at run time.
    return template.split("$$").join(ESCAPE).match(EMBEDDED) ?? [];
  }
  if (isTemplateArray(template)) {
    return template.flatMap(referencesIn);
  }
  if (template !== null && typeof template === "object") {
    return Object.values(template).flatMap(referencesIn);
  }
  return [];
}
