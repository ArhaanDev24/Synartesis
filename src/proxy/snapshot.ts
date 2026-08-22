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

/**
 * The message an upstream sent when it refused a call, or undefined when it
 * did not refuse.
 *
 * A tool-level error arrives as an ordinary successful response carrying
 * `isError`, so nothing on the forward path notices it unless it looks. It
 * means the server received the call, understood it, and did not do it, which
 * is the same reading `runRead` gives a refused pre-read and `executeInverse`
 * gives a refused inverse.
 */
export function refusal(result: unknown): string | undefined {
  const parsed = ToolResult.safeParse(result);
  if (!parsed.success || !parsed.data.isError) {
    return undefined;
  }
  const said = parsed.data.content
    .map((block) => (typeof block["text"] === "string" ? block["text"] : ""))
    .filter((text) => text !== "")
    .join(" ");
  return said === "" ? JSON.stringify(result) : said;
}

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

/** The snapshot read with its arguments already reduced to literals. */
export interface ResolvedRead {
  readonly server: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** What this server's error says when the thing is simply not there. */
  readonly absentWhen?: readonly string[];
}

/**
 * Resolves a declared pre-read against the current context. Stored on the
 * action so that drift can be checked later without consulting a manifest
 * that may have been edited in the meantime.
 */
export function planRead(call: CallTemplate, context: TemplateContext): ResolvedRead {
  const target = splitQualified(call.tool);
  if (target === undefined) {
    throw new SnapshotError(call.tool, "the snapshot tool is not qualified as server.tool");
  }
  try {
    return {
      server: target.server,
      tool: target.tool,
      args: resolveArgs(call, context),
      ...(call.absentWhen === undefined ? {} : { absentWhen: call.absentWhen }),
    };
  } catch (error: unknown) {
    throw new SnapshotError(call.tool, describe(error), { cause: error });
  }
}

/**
 * Runs a resolved pre-read. Deliberately not journalled: this is the proxy's
 * own traffic, and recording it would bury the actions an operator needs.
 */
/**
 * Whether an error says the connection is gone rather than that the call was
 * refused. Matched on the message because the sdk reports both of these as
 * plain errors with no code to tell them apart.
 */
export function isDisconnected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Not connected") || message.includes("Connection closed");
}

/**
 * Whether the call may already have arrived. The sdk says "Not connected" when
 * there was no transport to write to, which means it was never sent; it says
 * "Connection closed" when the transport went while a reply was still owed,
 * which says nothing at all about whether the far end acted on it.
 */
export function mayHaveArrived(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Connection closed");
}

export async function runRead(
  router: Router,
  read: ResolvedRead,
  signal: AbortSignal,
): Promise<unknown> {
  const label = `${read.server}.${read.tool}`;
  const upstream = router.byName(read.server);
  if (upstream === undefined) {
    throw new SnapshotError(label, `server ${read.server} is not connected`);
  }
  const { tool, args } = read;

  const ask = (): Promise<unknown> =>
    upstream.client.request(
      { method: "tools/call", params: { name: tool, arguments: args } },
      z.looseObject({}),
      { signal },
    );

  let raw: unknown;
  try {
    raw = await ask();
  } catch (error: unknown) {
    // A single oversized response closes a stdio connection, and every call
    // after it -- reads, writes, anything -- then failed with "Not connected"
    // for the rest of the session: one large file bricked the run. Reading is
    // safe to do again, so the server is started back up and asked once more.
    if (!isDisconnected(error) || upstream.reconnect === undefined) {
      throw new SnapshotError(label, describe(error), { cause: error });
    }
    try {
      await upstream.reconnect();
      raw = await ask();
    } catch (retry: unknown) {
      // The second attempt can kill the connection the same way the first did
      // -- the response is still too large -- so leave a live one behind. The
      // call that caused it fails either way; the rest of the session should
      // not have to.
      if (isDisconnected(retry)) {
        await upstream.reconnect().catch(() => undefined);
      }
      throw new SnapshotError(
        label,
        `${describe(error)} (the connection to ${read.server} was restarted and the read failed again: ${describe(retry)})`,
        { cause: retry },
      );
    }
  }

  const parsed = ToolResult.safeParse(raw);
  if (parsed.success && parsed.data.isError) {
    // A tool-level error is a failed read either way: whatever the write is
    // about to overwrite, we did not capture it. What it means is the
    // question. Where the policy says what absence looks like on this server,
    // anything else is a failure and the write is refused rather than offered
    // for approval as a creation. Where it says nothing, every error has to be
    // read as absence, because the protocol gives no way to tell.
    const said = JSON.stringify(raw);
    const absent =
      read.absentWhen === undefined ||
      read.absentWhen.some((phrase) => said.toLowerCase().includes(phrase.toLowerCase()));
    throw new SnapshotError(label, `the read reported an error: ${said}`, { absent });
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
  read: ResolvedRead,
  signal: AbortSignal,
): Promise<StateObservation> {
  try {
    return { present: true, value: await runRead(router, read, signal) };
  } catch (error: unknown) {
    if (error instanceof SnapshotError && error.absent) {
      return { present: false };
    }
    throw error;
  }
}
