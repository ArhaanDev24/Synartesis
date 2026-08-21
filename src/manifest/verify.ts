import { z } from "zod";

import { ManifestError } from "../errors.js";
import type { Upstream } from "../proxy/upstream.js";
import { splitQualified, type Manifest } from "./types.js";

const listSchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })),
  nextCursor: z.string().optional(),
});

async function toolNames(upstream: Upstream): Promise<Set<string>> {
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = listSchema.parse(
      await upstream.client.request(
        { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
        z.looseObject({}),
      ),
    );
    for (const tool of page.tools) {
      names.add(tool.name);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return names;
}

/**
 * Checks that every tool a policy calls actually exists on the server it names.
 *
 * This cannot be done when the manifest is parsed, because it needs the servers
 * running. It matters because a mistyped snapshot tool is otherwise
 * indistinguishable at run time from the resource simply not being there: both
 * come back as a tool-level error. Catching it at startup keeps that inference
 * safe, and keeps a broken policy from ever serving a request.
 */
export async function verifyAgainstServers(
  upstreams: readonly Upstream[],
  manifest: Manifest,
): Promise<void> {
  const available = new Map<string, Set<string>>();
  for (const upstream of upstreams) {
    available.set(upstream.name, await toolNames(upstream));
  }

  const problems: string[] = [];
  const check = (qualified: string, role: string, match: string): void => {
    const target = splitQualified(qualified);
    if (target === undefined) {
      return;
    }
    const names = available.get(target.server);
    if (names === undefined) {
      problems.push(`${match}: its ${role} names server ${target.server}, which is not connected`);
      return;
    }
    if (!names.has(target.tool)) {
      problems.push(
        `${match}: its ${role} calls ${qualified}, which ${target.server} does not expose`,
      );
    }
  };

  for (const policy of manifest.tools) {
    if (policy.snapshot !== undefined) {
      check(policy.snapshot.tool, "snapshot", policy.match);
    }
    if (policy.inverse !== undefined) {
      check(policy.inverse.tool, "inverse", policy.match);
    }
  }

  if (problems.length > 0) {
    throw new ManifestError(`the manifest calls tools that do not exist:\n  ${problems.join("\n  ")}`);
  }
}
