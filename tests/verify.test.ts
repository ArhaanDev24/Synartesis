import { afterEach, describe, expect, it } from "vitest";

import { ManifestError } from "../src/errors.js";
import { parseManifest } from "../src/manifest/load.js";
import { verifyAgainstServers, withoutMissingTools } from "../src/manifest/verify.js";
import { createToyCrmServer } from "../fixtures/toy-crm/server.js";
import { ToyCrmStore } from "../fixtures/toy-crm/store.js";
import { inMemoryUpstream } from "./helpers/harness.js";
import type { Upstream } from "../src/proxy/upstream.js";

let upstream: Upstream | undefined;

afterEach(async () => {
  await upstream?.close();
  upstream = undefined;
});

async function check(source: string): Promise<void> {
  upstream = await inMemoryUpstream(createToyCrmServer(new ToyCrmStore()), "crm");
  await verifyAgainstServers([upstream], parseManifest(source, "manifest.yaml"));
}

describe("verifying a manifest against live servers", () => {
  it("accepts a policy whose tools all exist", async () => {
    await expect(
      check(`version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.update_customer"
    class: reversible
    snapshot: { tool: "crm.get_customer", args: { id: "$.id" } }
    inverse: { tool: "crm.update_customer", args: { id: "$.id", plan: "$snapshot.plan" } }
`),
    ).resolves.toBeUndefined();
  });

  it("rejects a mistyped snapshot tool at startup", async () => {
    // At run time this is indistinguishable from the record simply not being
    // there, and the two need very different responses.
    await expect(
      check(`version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.update_customer"
    class: reversible
    snapshot: { tool: "crm.get_custmoer", args: { id: "$.id" } }
    inverse: { tool: "crm.update_customer", args: { id: "$.id", plan: "$snapshot.plan" } }
`),
    ).rejects.toThrow(ManifestError);
  });

  it("names every missing tool at once, not just the first", async () => {
    const thrown = await check(`version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.a"
    class: compensable
    inverse: { tool: "crm.nope_one", args: {} }
  - match: "crm.b"
    class: compensable
    inverse: { tool: "crm.nope_two", args: {} }
`).catch((error: unknown) => error);
    expect(String(thrown)).toContain("nope_one");
    expect(String(thrown)).toContain("nope_two");
  });
});

describe("a server that moved underneath a policy that used to work", () => {
  const moved = `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.update_customer"
    class: reversible
    snapshot: { tool: "crm.get_customer_v1", args: { id: "$.id" } }
    inverse: { tool: "crm.update_customer", args: { id: "$.id", plan: "$snapshot.plan" } }
  - match: "crm.get_customer"
    class: readonly
`;

  it("holds the rule whose read is gone, rather than refusing to start", async () => {
    // The shape of github-mcp-server 1.12: get_issue went, the shipped policy
    // still named it, and the proxy refused to start at all -- no GitHub.
    upstream = await inMemoryUpstream(createToyCrmServer(new ToyCrmStore()), "crm");
    const { manifest, disabled } = await withoutMissingTools(
      [upstream],
      parseManifest(moved, "manifest.yaml"),
    );

    const rule = manifest.tools.find((one) => one.match === "crm.update_customer");
    // More cautious than what it replaces, never less: held, and with no
    // inverse left to promise an undo it cannot deliver.
    expect(rule?.class).toBe("irreversible");
    expect(rule?.gate).toBe("always");
    expect(rule?.inverse).toBeUndefined();
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toContain("crm.get_customer_v1");

    // The rules that still work are left exactly as they were.
    expect(manifest.tools.find((one) => one.match === "crm.get_customer")?.class).toBe("readonly");

    // And what is left verifies, so the proxy comes up.
    await expect(verifyAgainstServers([upstream], manifest)).resolves.toBeUndefined();
  });

  it("still fails hard for check, where the policy is being written", async () => {
    await expect(check(moved)).rejects.toThrow(ManifestError);
  });
});
