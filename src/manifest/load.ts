import { readFileSync } from "node:fs";

import { LineCounter, isNode, parseDocument, type Document } from "yaml";
import { z } from "zod";

import { ManifestError, describe as describeCause, type SourceLocation } from "../errors.js";
import { referencesIn } from "./template.js";
import type { CallTemplate, Manifest, TemplateValue, ToolPolicy } from "./types.js";

const templateValue: z.ZodType<TemplateValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(templateValue),
    z.record(z.string(), templateValue),
  ]),
);

const callTemplate = z.strictObject({
  tool: z.string().min(1),
  args: z.record(z.string(), templateValue).default({}),
});

const toolPolicy = z.strictObject({
  match: z.string().min(1),
  class: z.enum(["readonly", "reversible", "compensable", "irreversible"]),
  gate: z.enum(["always", "on_write", "never"]).optional(),
  snapshot: callTemplate.optional(),
  inverse: callTemplate.optional(),
});

const serverSpec = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

const manifestSchema = z.strictObject({
  version: z.literal(1),
  servers: z.record(z.string(), serverSpec),
  tools: z.array(toolPolicy).default([]),
});

type Path = readonly (string | number)[];

class Source {
  constructor(
    private readonly doc: Document.Parsed,
    private readonly lines: LineCounter,
    private readonly file: string,
  ) {}

  /** Narrows to the deepest node that still exists, so a location is always given. */
  locate(path: Path): SourceLocation {
    for (let depth = path.length; depth >= 0; depth -= 1) {
      const node: unknown =
        depth === 0 ? this.doc.contents : this.doc.getIn(path.slice(0, depth), true);
      const range = isNode(node) ? node.range : undefined;
      if (range != null) {
        const position = this.lines.linePos(range[0]);
        return { file: this.file, line: position.line, column: position.col };
      }
    }
    return { file: this.file, line: 1, column: 1 };
  }

  fail(path: Path, message: string): never {
    throw new ManifestError(message, this.locate(path));
  }
}

function serverSegment(pattern: string): string {
  const dot = pattern.indexOf(".");
  return dot === -1 ? "" : pattern.slice(0, dot);
}

function matchesAnyServer(segment: string, servers: readonly string[]): boolean {
  if (!segment.includes("*")) {
    return servers.includes(segment);
  }
  const source = segment
    .split("*")
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.]*");
  const test = new RegExp(`^${source}$`);
  return servers.some((name) => test.test(name));
}

function checkCall(
  source: Source,
  path: Path,
  call: CallTemplate,
  servers: readonly string[],
  allowed: readonly string[],
): void {
  const segment = serverSegment(call.tool);
  if (segment === "" || call.tool.endsWith(".")) {
    source.fail([...path, "tool"], `${call.tool} must be qualified as server.tool`);
  }
  if (segment.includes("*")) {
    source.fail([...path, "tool"], `${call.tool} must name one server, not a pattern`);
  }
  if (!servers.includes(segment)) {
    source.fail([...path, "tool"], `${call.tool} names server ${segment}, which is not declared`);
  }

  for (const reference of referencesIn(call.args)) {
    const namespace = /^\$(\w*)\./.exec(reference)?.[1] ?? "";
    const label = namespace === "" ? "$." : `$${namespace}.`;
    if (!allowed.includes(label)) {
      source.fail(
        [...path, "args"],
        `${reference} uses ${label}, which is not available here; allowed: ${allowed.join(", ")}`,
      );
    }
  }
}

/**
 * Cross-field rules the shape alone cannot express. These are the difference
 * between a manifest that parses and a policy that can actually be executed,
 * and every one of them fails startup rather than surfacing mid-run.
 */
function validate(source: Source, manifest: Manifest): void {
  const servers = Object.keys(manifest.servers);
  if (servers.length === 0) {
    source.fail(["servers"], "at least one server must be declared");
  }

  const seen = new Map<string, number>();
  manifest.tools.forEach((policy, index) => {
    const path: Path = ["tools", index];
    const previous = seen.get(policy.match);
    if (previous !== undefined) {
      source.fail(
        [...path, "match"],
        `duplicate match pattern ${policy.match}; it is already declared at tools[${String(previous)}]`,
      );
    }
    seen.set(policy.match, index);

    const segment = serverSegment(policy.match);
    if (segment === "") {
      source.fail([...path, "match"], `${policy.match} must be qualified as server.tool`);
    }
    if (!matchesAnyServer(segment, servers)) {
      source.fail(
        [...path, "match"],
        `${policy.match} names server ${segment}, which is not declared`,
      );
    }

    const needsInverse = policy.class === "reversible" || policy.class === "compensable";
    if (needsInverse && policy.inverse === undefined) {
      source.fail(path, `a ${policy.class} tool must declare an inverse`);
    }
    if (!needsInverse && policy.inverse !== undefined) {
      source.fail([...path, "inverse"], `a ${policy.class} tool must not declare an inverse`);
    }
    if (policy.class === "reversible" && policy.snapshot === undefined) {
      // Without a pre-read a reversible action is silently irreversible.
      source.fail(path, "a reversible tool must declare a snapshot");
    }
    if (policy.class === "readonly" && policy.snapshot !== undefined) {
      source.fail([...path, "snapshot"], "a readonly tool must not declare a snapshot");
    }

    if (policy.snapshot !== undefined) {
      // The snapshot runs before the forward call, so neither the result nor a
      // snapshot exists yet.
      checkCall(source, [...path, "snapshot"], policy.snapshot, servers, ["$."]);
    }
    if (policy.inverse !== undefined) {
      const allowed = ["$.", "$result."];
      if (policy.snapshot !== undefined) {
        allowed.push("$snapshot.");
      }
      checkCall(source, [...path, "inverse"], policy.inverse, servers, allowed);
    }
  });
}

function withGate(policy: z.infer<typeof toolPolicy>): ToolPolicy {
  // D4: irreversible is gated unless the manifest deliberately says otherwise.
  const gate = policy.gate ?? (policy.class === "irreversible" ? "always" : "never");
  return {
    match: policy.match,
    class: policy.class,
    gate,
    ...(policy.snapshot === undefined ? {} : { snapshot: policy.snapshot }),
    ...(policy.inverse === undefined ? {} : { inverse: policy.inverse }),
  };
}

export function parseManifest(text: string, file: string): Manifest {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });

  const syntaxError = doc.errors[0];
  if (syntaxError !== undefined) {
    const position = lines.linePos(syntaxError.pos[0]);
    throw new ManifestError(syntaxError.message, {
      file,
      line: position.line,
      column: position.col,
    });
  }

  const source = new Source(doc, lines, file);
  const parsed = manifestSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue === undefined) {
      throw new ManifestError("manifest failed validation", source.locate([]));
    }
    const path = issue.path.filter(
      (segment): segment is string | number => typeof segment !== "symbol",
    );
    const where = path.length === 0 ? "" : `${path.join(".")}: `;
    throw new ManifestError(`${where}${issue.message}`, source.locate(path));
  }

  const manifest: Manifest = {
    version: parsed.data.version,
    servers: Object.fromEntries(
      Object.entries(parsed.data.servers).map(([name, spec]) => [
        name,
        {
          command: spec.command,
          args: spec.args,
          ...(spec.env === undefined ? {} : { env: spec.env }),
        },
      ]),
    ),
    tools: parsed.data.tools.map(withGate),
  };
  validate(source, manifest);
  return manifest;
}

export function loadManifest(path: string): Manifest {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error: unknown) {
    throw new ManifestError(`cannot read manifest at ${path}: ${describeCause(error)}`);
  }
  return parseManifest(text, path);
}
