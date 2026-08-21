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
  if (raw.startsWith("$.")) {
    return { namespace: "args", path: raw.slice(2) };
  }
  for (const namespace of NAMESPACES) {
    const prefix = `$${namespace}.`;
    if (raw.startsWith(prefix)) {
      return { namespace, path: raw.slice(prefix.length) };
    }
  }
  throw new ManifestError(
    `unknown interpolation namespace in ${raw}; expected $., $snapshot. or $result.`,
  );
}

/** Splits `items[1].id` into ["items", 1, "id"]. */
function segments(path: string, reference: string): (string | number)[] {
  const parts: (string | number)[] = [];
  for (const chunk of path.split(".")) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(chunk);
    if (match === null) {
      throw new ManifestError(`malformed path in ${reference}`);
    }
    const [, head = "", indices = ""] = match;
    if (head !== "") {
      parts.push(head);
    }
    for (const index of indices.matchAll(/\[(\d+)\]/g)) {
      parts.push(Number(index[1]));
    }
  }
  if (parts.length === 0) {
    throw new ManifestError(`empty path in ${reference}`);
  }
  return parts;
}

function read(root: unknown, path: string, reference: string): unknown {
  let current = root;
  for (const segment of segments(path, reference)) {
    if (current === null || current === undefined) {
      throw new ManifestError(`${reference} is unresolvable: ${String(segment)} has no parent`);
    }
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        throw new ManifestError(`${reference} is unresolvable: index ${String(segment)} is absent`);
      }
      current = current[segment];
      continue;
    }
    if (typeof current !== "object" || !(segment in current)) {
      throw new ManifestError(`${reference} is unresolvable: ${segment} is absent`);
    }
    current = Object.getOwnPropertyDescriptor(current, segment)?.value;
  }
  return current;
}

function resolveString(raw: string, context: TemplateContext): unknown {
  // `$$` is the only escape. A literal that begins with a dollar is rare
  // enough that a single escape is cheaper than a quoting rule.
  if (raw.startsWith("$$")) {
    return raw.slice(1);
  }
  const reference = parseReference(raw);
  if (reference === undefined) {
    return raw;
  }
  const root = context[reference.namespace];
  if (root === undefined) {
    throw new ManifestError(
      `${raw} refers to ${reference.namespace}, which is not available at this point`,
    );
  }
  return read(root, reference.path, raw);
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
    return template.startsWith("$") && !template.startsWith("$$") ? [template] : [];
  }
  if (isTemplateArray(template)) {
    return template.flatMap(referencesIn);
  }
  if (template !== null && typeof template === "object") {
    return Object.values(template).flatMap(referencesIn);
  }
  return [];
}
