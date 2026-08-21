import { afterEach, describe, expect, it } from "vitest";

import { ManifestError } from "../src/errors.js";
import { parseManifest } from "../src/manifest/load.js";
import { verifyAgainstServers } from "../src/manifest/verify.js";
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
