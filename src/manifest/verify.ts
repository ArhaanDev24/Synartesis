import { z } from "zod";

import { ManifestError } from "../errors.js";
import type { Upstream } from "../proxy/upstream.js";
import { auditPins, explainPins, type ToolShape } from "./pin.js";
import { splitQualified, type Manifest } from "./types.js";

const listSchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string(), inputSchema: z.unknown() })),
  nextCursor: z.string().optional(),
});

async function toolShapes(upstream: Upstream): Promise<ToolShape[]> {
  const shapes: ToolShape[] = [];
  let cursor: string | undefined;
  do {
    const page = listSchema.parse(
      await upstream.client.request(
        { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
        z.looseObject({}),
      ),
    );
    for (const tool of page.tools) {
      shapes.push({ name: tool.name, inputSchema: tool.inputSchema });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return shapes;
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
  const shapes = new Map<string, readonly ToolShape[]>();
  const available = new Map<string, Set<string>>();
  for (const upstream of upstreams) {
    const advertised = await toolShapes(upstream);
    shapes.set(upstream.name, advertised);
    available.set(upstream.name, new Set(advertised.map((tool) => tool.name)));
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
    if (policy.verify !== undefined) {
      check(policy.verify.tool, "verify", policy.match);
    }
  }

  if (problems.length > 0) {
    throw new ManifestError(`the manifest calls tools that do not exist:\n  ${problems.join("\n  ")}`);
  }

  // Separate from the existence check above and reported separately, because
  // they fail for opposite reasons: that one means the policy was written
  // wrong, this one means the policy was written right and the world moved
  // underneath it. Conflating them would make the second sound like a typo.
  const drifted: string[] = [];
  for (const upstream of upstreams) {
    const faults = auditPins(upstream.name, shapes.get(upstream.name) ?? [], manifest);
    drifted.push(...explainPins(upstream.name, faults));
  }
  if (drifted.length > 0) {
    throw new ManifestError(
      "a pinned tool no longer matches the policy written for it:\n  " +
        drifted.join("\n  ") +
        "\n\n  Review what changed before trusting undo on these tools. " +
        "`synartesis pin` prints the block for the servers you have now.",
    );
  }
}

export { toolShapes };
