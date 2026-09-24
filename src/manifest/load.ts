import { readFileSync } from "node:fs";

import { LineCounter, isNode, parseDocument, type Document } from "yaml";
import { z } from "zod";

import { ManifestError, describe as describeCause, type SourceLocation } from "../errors.js";
import { referencesIn } from "./template.js";
import type { CallTemplate, Manifest, ServerSpec, TemplateValue, ToolPolicy } from "./types.js";

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
  absent_when: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .optional(),
  // Only `absent` for now. `present` would mean "refuse unless something is
  // already here", which is a different feature nobody has asked for, and a
  // value with no meaning behind it is worse than one that is missing.
  expect: z.literal("absent").optional(),
});

const toolPolicy = z.strictObject({
  match: z.string().min(1),
  class: z.enum(["readonly", "reversible", "compensable", "irreversible"]),
  gate: z.enum(["always", "on_write", "never"]).optional(),
  refusal: z.enum(["uncertain", "clean"]).optional(),
  snapshot: callTemplate.optional(),
  inverse: callTemplate.optional(),
  verify: callTemplate.optional(),
});

const serverSpec = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  provenance: z.enum(["live", "documented"]).optional(),
  trust_annotations: z.boolean().optional(),
});

/**
 * Only https, so a token never crosses a network in the clear -- except to
 * this machine, where a local server under test is the common case and there
 * is no network to cross.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const remoteSpec = z.strictObject({
  url: z
    .string()
    .refine((value) => URL.canParse(value), "url must be a full address, like https://example.com/mcp")
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
    }, "url must be https, since it carries a token; plain http is accepted only for this machine"),
  transport: z.enum(["auto", "http", "sse"]).default("auto"),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  provenance: z.enum(["live", "documented"]).optional(),
  trust_annotations: z.boolean().optional(),
});

/**
 * One schema or the other, picked before either runs. A union would answer a
 * mistake in either with a complaint about both -- "command: required" for a
 * server that was only ever meant to have a url.
 */
const anyServer = z.unknown().transform((value, context) => {
  const has = (key: string): boolean =>
    typeof value === "object" && value !== null && key in value;
  if (has("command") && has("url")) {
    context.addIssue({ code: "custom", message: "give command or url, not both" });
    return z.NEVER;
  }
  const parsed = (has("url") ? remoteSpec : serverSpec).safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, code: "custom", message: issue.message });
    }
    return z.NEVER;
  }
  return parsed.data;
});

const manifestSchema = z.strictObject({
  version: z.literal(1),
  servers: z.record(z.string(), anyServer),
  tools: z.array(toolPolicy).default([]),
  pins: z.record(z.string(), z.record(z.string(), z.string().min(1))).optional(),
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

/**
 * `${VAR}` in a server's environment is kept as written here and filled in
 * when that server is started -- see `upstreamEnv` in `src/proxy/environment.ts`.
 *
 * It used to be expanded while the policy was read, for every server at once,
 * refusing if any variable was unset. That made one server's missing token
 * everybody's problem: undoing a filesystem session failed unless the GitHub
 * token was exported in that terminal, and a proxy started for one server
 * refused to start over a variable only another server used. Only the syntax
 * is checked here, so a malformed reference is still a load error with a line
 * number rather than a surprise at start.
 */
const MALFORMED = /\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/;

function checkReferences(
  source: Source,
  path: Path,
  env: Readonly<Record<string, string>>,
  field: "env" | "headers" = "env",
): Readonly<Record<string, string>> {
  for (const [key, value] of Object.entries(env)) {
    if (MALFORMED.test(value)) {
      source.fail(
        [...path, field, key],
        "a reference is written ${NAME}: letters, digits and underscores, not starting with a digit",
      );
    }
  }
  return env;
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

/** Every string in a template, with where it is, so an error can say which line. */
function stringsIn(value: TemplateValue, path: Path): (readonly [Path, string])[] {
  if (typeof value === "string") {
    return [[path, value]];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item: TemplateValue, index) => stringsIn(item, [...path, index]));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => stringsIn(item, [...path, key]));
  }
  return [];
}

/** How `args.id`, `snapshot.name` or `result.id` is written in a policy. */
function spelled(inner: string): string {
  const trimmed = inner.trim().replace(/^\$/, "");
  for (const [from, to] of [["args.", "$."], ["snapshot.", "$snapshot."], ["result.", "$result."]] as const) {
    if (trimmed.startsWith(from)) {
      return `"${to}${trimmed.slice(from.length)}"`;
    }
  }
  return `"$.${trimmed}"`;
}

/**
 * Two spellings borrowed from other tools, caught with the line they are on.
 * `{{args.id}}` loaded without complaint and was sent to the server as those
 * eleven characters; `${args.id}` failed with no line at all. Run before
 * anything else reads a rule's references, so it is this message that is seen.
 */
function checkSpelling(source: Source, path: Path, call: CallTemplate | undefined): void {
  if (call === undefined) {
    return;
  }
  for (const [at, text] of stringsIn(call.args, [...path, "args"])) {
    const braces = /\{\{\s*([^}]*?)\s*\}\}/.exec(text);
    if (braces !== null) {
      source.fail(at, `${braces[0]} is sent as written; write ${spelled(braces[1] ?? "")} instead`);
    }
    const dollar = /^\$\{([^}]*)\}$/.exec(text);
    if (dollar !== null) {
      source.fail(at, `${text} is not a reference here; write ${spelled(dollar[1] ?? "")} instead`);
    }
    try {
      referencesIn(text);
    } catch (error: unknown) {
      source.fail(at, error instanceof Error ? error.message : String(error));
    }
  }
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
    // Matches `$ns.field`, `$ns[0]` and a bare `$ns`, so a whole-value or
    // subscripted reference is checked rather than silently treated as `$.`
    // and failing at run time.
    const namespace = /^\$(\w*)(?:[.[]|$)/.exec(reference)?.[1] ?? "";
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

  // A pin block for a server that is not declared protects nothing and reads
  // as though it does, which is the one thing pinning must never do.
  for (const name of Object.keys(manifest.pins ?? {})) {
    if (!servers.includes(name)) {
      source.fail(["pins", name], `pins name server ${name}, which is not declared`);
    }
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
    checkSpelling(source, [...path, "snapshot"], policy.snapshot);
    checkSpelling(source, [...path, "inverse"], policy.inverse);
    checkSpelling(source, [...path, "verify"], policy.verify);

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

    // A readonly tool changes nothing, so there is no drift in it to detect
    // and nothing for undo to compare against. Declaring one is a mistake
    // worth naming rather than quietly honouring.
    if (policy.verify !== undefined && policy.class === "readonly") {
      source.fail([...path, "verify"], "a readonly tool has no post-state to check for drift");
    }

    const needsInverse = policy.class === "reversible" || policy.class === "compensable";
    if (needsInverse && policy.inverse === undefined) {
      source.fail(path, `a ${policy.class} tool must declare an inverse`);
    }
    if (!needsInverse && policy.inverse !== undefined) {
      source.fail([...path, "inverse"], `a ${policy.class} tool must not declare an inverse`);
    }
    // A snapshot is required only when the inverse actually depends on one.
    // Some actions are reversible from their arguments alone: the inverse of
    // moving a file from A to B is moving it from B to A, and no pre-read
    // could tell you anything the arguments do not already say.
    const needsSnapshot =
      policy.inverse !== undefined &&
      referencesIn(policy.inverse.args).some(
        (reference) => reference === "$snapshot" || reference.startsWith("$snapshot."),
      );
    if (policy.class === "reversible" && needsSnapshot && policy.snapshot === undefined) {
      // Without a pre-read such a reversible action is silently irreversible.
      source.fail(path, "this inverse reads $snapshot, so a snapshot must be declared");
    }
    if (policy.class === "readonly" && policy.snapshot !== undefined) {
      source.fail([...path, "snapshot"], "a readonly tool must not declare a snapshot");
    }

    // `expect: absent` inverts what the pre-read means, so the things that
    // follow from it are checked here rather than discovered at undo time.
    const expectsAbsent = policy.snapshot?.expect === "absent";
    if (policy.verify?.expect !== undefined) {
      source.fail(
        [...path, "verify", "expect"],
        "expect belongs on a snapshot; a verify read runs after the call, when there is nothing left to expect",
      );
    }
    if (expectsAbsent && policy.class !== "reversible") {
      source.fail(
        [...path, "snapshot", "expect"],
        `expect: absent says this call is reversible exactly when the read finds nothing, which only means something for a reversible tool, not a ${policy.class} one`,
      );
    }

    if (policy.snapshot !== undefined) {
      // The snapshot runs before the forward call, so neither the result nor a
      // snapshot exists yet.
      checkCall(source, [...path, "snapshot"], policy.snapshot, servers, ["$."]);
    }
    if (policy.inverse !== undefined) {
      // With expect: absent there is no captured state for the inverse to
      // read -- the state it puts back is absence itself -- so $snapshot.
      // could never resolve. Caught here, because at run time it resolves to
      // nothing and the action is recorded as applied with no inverse.
      const allowed = ["$.", "$result."];
      if (policy.snapshot !== undefined && !expectsAbsent) {
        allowed.push("$snapshot.");
      }
      checkCall(source, [...path, "inverse"], policy.inverse, servers, allowed);
    }
    // Checked like the other two, and for a sharper reason. A mistyped
    // snapshot or inverse fails loudly at the moment it is needed; a mistyped
    // verify is caught by the proxy, turned into "the drift check could not be
    // planned" on the action, and stepped over -- so the policy loads, check
    // passes, and the tool silently has no drift detection at all. It resolves
    // after the call with the same context the inverse gets.
    if (policy.verify !== undefined) {
      const allowed = ["$.", "$result."];
      if (policy.snapshot !== undefined) {
        allowed.push("$snapshot.");
      }
      checkCall(source, [...path, "verify"], policy.verify, servers, allowed);
    }
  });
}

function withGate(policy: z.infer<typeof toolPolicy>): ToolPolicy {
  // D4: irreversible is gated unless the manifest deliberately says otherwise.
  // `absent_when` in the file, absentWhen in the type: the one place a name is
  // translated, so a single string and a list read the same way afterwards.
  const toCall = (call: {
    tool: string;
    args: Record<string, TemplateValue>;
    absent_when?: string | string[] | undefined;
    expect?: "absent" | undefined;
  }): CallTemplate => ({
    tool: call.tool,
    args: call.args,
    ...(call.absent_when === undefined
      ? {}
      : {
          absentWhen:
            typeof call.absent_when === "string" ? [call.absent_when] : [...call.absent_when],
        }),
    ...(call.expect === undefined ? {} : { expect: call.expect }),
  });

  const gate = policy.gate ?? (policy.class === "irreversible" ? "always" : "never");
  return {
    match: policy.match,
    class: policy.class,
    gate,
    refusal: policy.refusal ?? "uncertain",
    ...(policy.snapshot === undefined ? {} : { snapshot: toCall(policy.snapshot) }),
    ...(policy.inverse === undefined ? {} : { inverse: toCall(policy.inverse) }),
    ...(policy.verify === undefined ? {} : { verify: toCall(policy.verify) }),
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
          ...("url" in spec
            ? {
                url: spec.url,
                transport: spec.transport,
                ...(spec.headers === undefined
                  ? {}
                  : { headers: checkReferences(source, ["servers", name], spec.headers, "headers") }),
              }
            : { command: spec.command, args: spec.args }),
          ...(spec.env === undefined
            ? {}
            : { env: checkReferences(source, ["servers", name], spec.env) }),
          ...(spec.provenance === undefined ? {} : { provenance: spec.provenance }),
          ...(spec.trust_annotations === undefined ? {} : { trustAnnotations: spec.trust_annotations }),
        } satisfies ServerSpec,
      ]),
    ),
    tools: parsed.data.tools.map(withGate),
    ...(parsed.data.pins === undefined ? {} : { pins: parsed.data.pins }),
  };
  validate(source, manifest);
  return manifest;
}

/** Node reports a missing file with code ENOENT and no type to narrow on. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function loadManifest(path: string): Manifest {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error: unknown) {
    // A policy that is simply not there yet is the commonest way this fails,
    // and it has an answer. Saying only "ENOENT" leaves someone who has not
    // run init with no idea that init is the thing that writes this file.
    if (isMissing(error)) {
      throw new ManifestError(
        `there is no policy at ${path}. Write one with: synartesis init <name> -- <the server's command>`,
      );
    }
    throw new ManifestError(`cannot read manifest at ${path}: ${describeCause(error)}`);
  }
  return parseManifest(text, path);
}
