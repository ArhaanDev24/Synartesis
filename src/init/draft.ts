import { z } from "zod";

import { ManifestError, UpstreamError, describe } from "../errors.js";
import { connectStdioUpstream } from "../proxy/upstream.js";
import { knownPolicyFor, toolsReferencedBy } from "./known.js";

export interface Draft {
  readonly yaml: string;
  /** The bundled policy this used, if one fitted. */
  readonly adopted?: { readonly server: string; readonly tools: number };
}

export interface DraftOptions {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Existing manifest source to extend rather than replace. */
  readonly existing?: string;
}

const toolSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  annotations: z
    .looseObject({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
    })
    .optional(),
});

const listSchema = z.looseObject({
  tools: z.array(toolSchema),
  nextCursor: z.string().optional(),
});

type Tool = z.infer<typeof toolSchema>;

function quote(value: string): string {
  return JSON.stringify(value);
}

/** Keeps a description readable on one comment line. */
function summarise(text: string | undefined): string {
  if (text === undefined) {
    return "";
  }
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 96 ? `${single.slice(0, 93)}...` : single;
}

function draftTool(server: string, tool: Tool): string {
  const match = `${server}.${tool.name}`;
  const lines: string[] = [];
  const description = summarise(tool.description);
  if (description !== "") {
    lines.push(`  # ${description}`);
  }

  // A server's own readOnlyHint is the one claim worth taking at face value:
  // it is the server saying it does not write. Everything else is a hint about
  // intent, not a guarantee, and D4 says an unproven tool is irreversible.
  if (tool.annotations?.readOnlyHint === true) {
    lines.push(`  # classified readonly from the server's readOnlyHint; verify it before relying on it.`);
    lines.push(`  - match: ${quote(match)}`);
    lines.push(`    class: readonly`);
    return lines.join("\n");
  }

  lines.push(`  # TODO: this is gated on every call until you describe how to undo it.`);
  lines.push(`  #   reversible  needs a snapshot (a pre-read) and an inverse.`);
  lines.push(`  #   compensable needs an inverse only, usually built from $result.`);
  lines.push(`  #   irreversible is correct when neither exists; leave gate: always.`);
  lines.push(`  - match: ${quote(match)}`);
  lines.push(`    class: irreversible`);
  lines.push(`    gate: always`);
  return lines.join("\n");
}


/** `*` stands for any run of characters that is not a dot, as in the matcher. */
function patternFor(match: string): RegExp {
  const source = match
    .split("*")
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.]*");
  return new RegExp(`^${source}$`);
}

/**
 * The finished policy for this server, if we ship one and it still fits.
 *
 * "Fits" is checked against the tools the server actually advertises rather
 * than assumed from the command line: a server that has since renamed or
 * dropped a tool would otherwise get a policy whose inverses cannot be called,
 * which is worse than a policy of TODOs because it looks done.
 */
function adopt(
  known: NonNullable<ReturnType<typeof knownPolicyFor>>,
  name: string,
  tools: readonly Tool[],
): { readonly source: string; readonly covered: number } | undefined {
  const advertised = new Set(tools.map((tool) => tool.name));
  const covered = new Set<string>();
  for (const rule of known.rules) {
    for (const needed of toolsReferencedBy(rule, known.key)) {
      if (!advertised.has(needed)) {
        return undefined;
      }
    }
    const test = patternFor(rule.match);
    for (const tool of tools) {
      if (test.test(`${known.key}.${tool.name}`)) {
        covered.add(tool.name);
      }
    }
  }
  if (covered.size === 0) {
    return undefined;
  }

  // Renamed to whatever this server was called here. Anchored on the quote so
  // a description mentioning the old key is left alone.
  const renamed = known.source.replaceAll(`"${known.key}.`, `"${name}.`);
  const missing = tools.filter((tool) => !covered.has(tool.name));
  const extra =
    missing.length === 0
      ? ""
      : [
          "",
          `  # Not mentioned by the bundled ${known.name} policy, so gated until you say otherwise.`,
          ...missing.map((tool) => draftTool(name, tool)),
        ].join("\n");
  return { source: `${renamed}${extra}`, covered: covered.size };
}

/**
 * Introspects a server and writes a starting policy for it. The draft is
 * deliberately unhelpful in one direction only: everything it cannot vouch for
 * is gated, so an unfinished manifest is annoying rather than dangerous.
 */
export async function draftManifest(options: DraftOptions): Promise<Draft> {
  const upstream = await connectStdioUpstream({
    name: options.name,
    command: options.command,
    args: options.args,
    stderr: "capture",
  });

  let tools: Tool[];
  try {
    const collected: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = listSchema.parse(
        await upstream.client.request(
          { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
          z.looseObject({}),
        ),
      );
      collected.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    tools = collected;
  } catch (error: unknown) {
    throw new UpstreamError(options.name, "tools/list", error);
  } finally {
    await upstream.close();
  }

  if (tools.length === 0) {
    throw new ManifestError(`${options.name} exposes no tools, so there is no policy to write`);
  }

  const existing = options.existing?.trimEnd();
  if (existing !== undefined && existing.includes(`\n  ${options.name}:`)) {
    throw new ManifestError(
      `${options.name} is already declared in the manifest; remove it first or choose another name`,
    );
  }

  const server = [
    `  ${options.name}:`,
    `    command: ${quote(options.command)}`,
    `    args: [${options.args.map(quote).join(", ")}]`,
  ].join("\n");

  const known = knownPolicyFor(options.command, options.args);
  const adopted = known === undefined ? undefined : adopt(known, options.name, tools);
  const policies =
    adopted?.source ?? tools.map((tool) => draftTool(options.name, tool)).join("\n\n");

  if (existing === undefined) {
    const yaml = [
      `# Generated by synartesis init from ${options.name}'s tools/list.`,
      ...(adopted === undefined
        ? [
            `# Every tool starts gated. Working through the TODOs is the whole job:`,
            `# a tool with no inverse is one an agent cannot use unsupervised.`,
          ]
        : [
            `# ${String(adopted.covered)} of its tools were recognised, so the policy that ships`,
            `# with Synartesis for ${known?.name ?? "this server"} was used and checked against what this`,
            `# server actually advertises. Read it before trusting it: it is a starting`,
            `# point that happens to be finished, not a promise about your setup.`,
          ]),
      ``,
      `version: 1`,
      ``,
      `servers:`,
      server,
      ``,
      `tools:`,
      policies,
      ``,
    ].join("\n");
    return adopted === undefined || known === undefined
      ? { yaml }
      : { yaml, adopted: { server: known.name, tools: adopted.covered } };
  }

  const merged = mergeInto(existing, server, policies, options.name);
  return adopted === undefined || known === undefined
    ? { yaml: merged }
    : { yaml: merged, adopted: { server: known.name, tools: adopted.covered } };
}

/**
 * Textual merge rather than parse-and-reserialise: a round trip through the
 * YAML AST would strip the author's comments, which in this format carry the
 * reasoning behind every classification.
 */
function mergeInto(existing: string, server: string, policies: string, name: string): string {
  const serversAt = existing.indexOf("\nservers:");
  const toolsAt = existing.indexOf("\ntools:");
  if (serversAt === -1 || toolsAt === -1 || toolsAt < serversAt) {
    throw new ManifestError(
      "the existing manifest does not have a servers: block followed by a tools: block, so it cannot be extended automatically",
    );
  }

  const head = existing.slice(0, toolsAt);
  const tail = existing.slice(toolsAt);
  return [
    head.trimEnd(),
    server,
    tail.trimEnd(),
    ``,
    `  # --- added by synartesis init for ${name} ---`,
    policies,
    ``,
  ].join("\n");
}

export { describe };
