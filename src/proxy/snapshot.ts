import { z } from "zod";

import { ManifestError, SnapshotError, describe } from "../errors.js";
import { resolveTemplate, type TemplateContext } from "../manifest/template.js";
import { splitQualified, type CallTemplate } from "../manifest/types.js";
import type { Router } from "./routing.js";

/**
 * What a read saw. Absence is a real state, not a failure: after a successful
 * delete the record is gone, and that is precisely the post-state Phase 4 has
 * to compare against.
 */
export type StateObservation = { readonly present: true; readonly value: unknown } | { readonly present: false };

/** A fully resolved call, carrying literal values only (D5). */
export interface InversePlan {
  readonly server: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

const ToolResult = z.looseObject({
  isError: z.boolean().default(false),
  content: z.array(z.looseObject({ type: z.string() })).default([]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The logical value a tool returned, rather than its MCP envelope. Manifests
 * say `$snapshot.plan`, not `$snapshot.content[0].text`, so the envelope has to
 * be unwrapped before interpolation sees it.
 */
export function toPayload(result: unknown): unknown {
  if (!isRecord(result)) {
    return result;
  }
  const structured = result["structuredContent"];
  if (structured !== undefined) {
    return structured;
  }
  const content = result["content"];
  if (Array.isArray(content) && content.length === 1) {
    const block: unknown = content[0];
    if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
      const text = block["text"];
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // Not every server returns json. The raw text is still the payload.
        return text;
      }
    }
  }
  return result;
}

function resolveArgs(call: CallTemplate, context: TemplateContext): Record<string, unknown> {
  const resolved = resolveTemplate(call.args, context);
  if (!isRecord(resolved)) {
    throw new ManifestError(`${call.tool} resolved to arguments that are not an object`);
  }
  return resolved;
}

/**
 * Resolves the inverse while the run is still in progress (D5). At rollback
 * time the upstream may have drifted and the old value may no longer be
 * readable anywhere.
 */
export function planInverse(call: CallTemplate, context: TemplateContext): InversePlan {
  const target = splitQualified(call.tool);
  if (target === undefined) {
    throw new ManifestError(`inverse tool ${call.tool} is not qualified as server.tool`);
  }
  return { server: target.server, tool: target.tool, args: resolveArgs(call, context) };
}

/**
 * Runs a declared pre-read. Deliberately not journalled: this is the proxy's
 * own traffic, and recording it would bury the actions an operator needs.
 */
export async function readSnapshot(
  router: Router,
  call: CallTemplate,
  context: TemplateContext,
  signal: AbortSignal,
): Promise<unknown> {
  const target = splitQualified(call.tool);
  if (target === undefined) {
    throw new SnapshotError(call.tool, "the snapshot tool is not qualified as server.tool");
  }
  const upstream = router.byName(target.server);
  if (upstream === undefined) {
    throw new SnapshotError(call.tool, `server ${target.server} is not connected`);
  }

  let args: Record<string, unknown>;
  try {
    args = resolveArgs(call, context);
  } catch (error: unknown) {
    throw new SnapshotError(call.tool, describe(error), { cause: error });
  }

  let raw: unknown;
  try {
    raw = await upstream.client.request(
      { method: "tools/call", params: { name: target.tool, arguments: args } },
      z.looseObject({}),
      { signal },
    );
  } catch (error: unknown) {
    throw new SnapshotError(call.tool, describe(error), { cause: error });
  }

  const parsed = ToolResult.safeParse(raw);
  if (parsed.success && parsed.data.isError) {
    // A tool-level error is still a failed read: whatever the write is about
    // to overwrite, we could not capture it.
    throw new SnapshotError(call.tool, `the read reported an error: ${JSON.stringify(raw)}`, {
      absent: true,
    });
  }
  return toPayload(raw);
}

/**
 * The post-write read. Unlike the pre-read, a tool-level error here is
 * meaningful rather than fatal: the same read with the same arguments
 * succeeded moments earlier, so an error now says the resource is gone, which
 * is exactly what a delete is supposed to produce. Transport and protocol
 * failures still throw, because those say nothing about the resource.
 */
export async function observeState(
  router: Router,
  call: CallTemplate,
  context: TemplateContext,
  signal: AbortSignal,
): Promise<StateObservation> {
  try {
    return { present: true, value: await readSnapshot(router, call, context, signal) };
  } catch (error: unknown) {
    if (error instanceof SnapshotError && error.absent) {
      return { present: false };
    }
    throw error;
  }
}
