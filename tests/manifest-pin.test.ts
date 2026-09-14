import { afterEach, describe, expect, it } from "vitest";

import { ManifestError } from "../src/errors.js";
import { parseManifest } from "../src/manifest/load.js";
import { auditPins, fingerprint, pinBlock, type ToolShape } from "../src/manifest/pin.js";
import { toolShapes, verifyAgainstServers } from "../src/manifest/verify.js";
import { createToyCrmServer } from "../fixtures/toy-crm/server.js";
import { ToyCrmStore } from "../fixtures/toy-crm/store.js";
import { inMemoryUpstream } from "./helpers/harness.js";
import type { Upstream } from "../src/proxy/upstream.js";

let upstream: Upstream | undefined;

afterEach(async () => {
  await upstream?.close();
  upstream = undefined;
});

const POLICY = `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.update_customer"
    class: reversible
    inverse:
      tool: "crm.update_customer"
      args: { id: "{{args.id}}", plan: "{{before.plan}}" }
`;

async function shapesOf(): Promise<readonly ToolShape[]> {
  upstream = await inMemoryUpstream(createToyCrmServer(new ToyCrmStore()), "crm");
  return await toolShapes(upstream);
}

async function verify(source: string): Promise<void> {
  upstream = await inMemoryUpstream(createToyCrmServer(new ToyCrmStore()), "crm");
  await verifyAgainstServers([upstream], parseManifest(source, "manifest.yaml"));
}

describe("fingerprinting a tool's shape", () => {
  it("ignores key order, which json does not promise", () => {
    const a = { type: "object", properties: { id: { type: "string" }, plan: { type: "string" } } };
    const b = { properties: { plan: { type: "string" }, id: { type: "string" } }, type: "object" };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("changes when a field is added", () => {
    const before = { type: "object", properties: { id: { type: "string" } } };
    const after = {
      type: "object",
      properties: { id: { type: "string" }, append: { type: "boolean" } },
    };
    expect(fingerprint(after)).not.toBe(fingerprint(before));
  });

  it("is stable across calls", async () => {
    upstream = await inMemoryUpstream(createToyCrmServer(new ToyCrmStore()), "crm");
    const first = (await toolShapes(upstream)).map((tool) => fingerprint(tool.inputSchema));
    const second = (await toolShapes(upstream)).map((tool) => fingerprint(tool.inputSchema));
    expect(second).toEqual(first);
  });
});

describe("auditing pins", () => {
  it("checks nothing when the manifest has no pins", async () => {
    const shapes = await shapesOf();
    expect(auditPins("crm", shapes, parseManifest(POLICY, "m.yaml"))).toEqual([]);
  });

  it("passes when the pin matches what the server advertises", async () => {
    const shapes = await shapesOf();
    const update = shapes.find((tool) => tool.name === "update_customer");
    const pinned = `${POLICY}
pins:
  crm:
    update_customer: "${fingerprint(update?.inputSchema)}"
`;
    expect(auditPins("crm", shapes, parseManifest(pinned, "m.yaml"))).toEqual([]);
  });

  it("catches a tool whose schema moved under a live policy", async () => {
    const shapes = await shapesOf();
    // The scenario this exists for: the server keeps the name and changes the
    // arguments. Nothing else in the system notices.
    const pinned = `${POLICY}
pins:
  crm:
    update_customer: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
`;
    const faults = auditPins("crm", shapes, parseManifest(pinned, "m.yaml"));
    expect(faults).toHaveLength(1);
    expect(faults[0]?.kind).toBe("moved");
    expect(faults[0]?.tool).toBe("update_customer");
  });

  it("catches a governed tool with no pin once the server is pinned", async () => {
    const shapes = await shapesOf();
    const update = shapes.find((tool) => tool.name === "update_customer");
    // A wildcard governs delete_customer too, so pinning only one leaves a
    // hole that reads as protection.
    const wide = `version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.*"
    class: readonly
pins:
  crm:
    update_customer: "${fingerprint(update?.inputSchema)}"
`;
    const faults = auditPins("crm", shapes, parseManifest(wide, "m.yaml"));
    expect(faults.length).toBeGreaterThan(0);
    expect(faults.every((fault) => fault.kind === "unpinned")).toBe(true);
    expect(faults.map((fault) => fault.tool)).toContain("delete_customer");
  });

  it("does not demand a pin for a tool no policy matches", async () => {
    const shapes = await shapesOf();
    const update = shapes.find((tool) => tool.name === "update_customer");
    // Everything but update_customer is unmatched, so it is already
    // fail-closed as irreversible and gated. There is no classification for a
    // schema change to corrupt, and demanding pins would make every new tool
    // on the server a startup failure.
    const pinned = `${POLICY}
pins:
  crm:
    update_customer: "${fingerprint(update?.inputSchema)}"
`;
    expect(auditPins("crm", shapes, parseManifest(pinned, "m.yaml"))).toEqual([]);
  });

  it("catches a pin for a tool the server no longer has", async () => {
    const shapes = await shapesOf();
    const update = shapes.find((tool) => tool.name === "update_customer");
    const pinned = `${POLICY}
pins:
  crm:
    update_customer: "${fingerprint(update?.inputSchema)}"
    removed_tool: "sha256:abc"
`;
    const faults = auditPins("crm", shapes, parseManifest(pinned, "m.yaml"));
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ kind: "gone", tool: "removed_tool" });
  });
});

describe("pins at startup", () => {
  it("refuses to serve when a pinned tool has moved", async () => {
    const pinned = `${POLICY}
pins:
  crm:
    update_customer: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
`;
    await expect(verify(pinned)).rejects.toThrow(ManifestError);
    await expect(verify(pinned)).rejects.toThrow(/no longer matches the policy/);
  });

  it("names the tool and both fingerprints, so the change can be judged", async () => {
    const pinned = `${POLICY}
pins:
  crm:
    update_customer: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
`;
    await expect(verify(pinned)).rejects.toThrow(/update_customer/);
    await expect(verify(pinned)).rejects.toThrow(/sha256:0{64}/);
  });

  it("starts normally when nothing is pinned", async () => {
    await expect(verify(POLICY)).resolves.toBeUndefined();
  });

  it("rejects pins naming a server that is not declared", () => {
    expect(() =>
      parseManifest(`${POLICY}
pins:
  nope:
    whatever: "sha256:abc"
`, "m.yaml"),
    ).toThrow(/not declared/);
  });
});

describe("the block the pin command prints", () => {
  it("round-trips: what it prints is what passes the audit", async () => {
    const shapes = await shapesOf();
    const block = pinBlock(new Map([["crm", shapes]]), parseManifest(POLICY, "m.yaml"));
    const pinned = parseManifest(`${POLICY}\n${block}\n`, "m.yaml");
    expect(auditPins("crm", shapes, pinned)).toEqual([]);
  });

  it("covers every governed tool under a wildcard", async () => {
    const shapes = await shapesOf();
    const wide = parseManifest(`version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.*"
    class: readonly
`, "m.yaml");
    const block = pinBlock(new Map([["crm", shapes]]), wide);
    const pinned = parseManifest(`version: 1
servers: { crm: { command: node, args: [] } }
tools:
  - match: "crm.*"
    class: readonly
${block}
`, "m.yaml");
    expect(auditPins("crm", shapes, pinned)).toEqual([]);
    expect(block).toContain("update_customer");
    expect(block).toContain("delete_customer");
  });
});

describe("a real server upgrade", () => {
  /**
   * The threat in full, with nothing faked but the upgrade itself: a server
   * that keeps a tool's name and adds an argument. The policy still says
   * reversible, the inverse template still names fields that have moved, and
   * before pins nothing anywhere in the system noticed.
   */
  async function upgraded(): Promise<Upstream> {
    const real = await inMemoryUpstream(createToyCrmServer(new ToyCrmStore()), "crm");
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
    const client: any = real.client;
    const original: any = client.request.bind(client);
    client.request = async (request: any, schema: any, options?: any): Promise<unknown> => {
      const reply: any = await original(request, schema, options);
      if (request?.method === "tools/list" && Array.isArray(reply?.tools)) {
        for (const tool of reply.tools) {
          if (tool?.name === "update_customer" && tool.inputSchema?.properties) {
            tool.inputSchema.properties.append = { type: "boolean" };
          }
        }
      }
      return reply;
    };
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
    return real;
  }

  it("is caught by a pin taken before the upgrade", async () => {
    // Pin against the server as it is today.
    upstream = await inMemoryUpstream(createToyCrmServer(new ToyCrmStore()), "crm");
    const before = await toolShapes(upstream);
    const block = pinBlock(new Map([["crm", before]]), parseManifest(POLICY, "m.yaml"));
    await upstream.close();

    // Restart against the upgraded server with the same pins.
    upstream = await upgraded();
    const manifest = parseManifest(`${POLICY}\n${block}\n`, "m.yaml");
    await expect(verifyAgainstServers([upstream], manifest)).rejects.toThrow(
      /update_customer no longer has the shape it was pinned at/,
    );
  });

  it("goes unnoticed without pins, which is the state before this existed", async () => {
    upstream = await upgraded();
    // Same upgrade, no pins: startup is clean and the stale policy serves.
    await expect(
      verifyAgainstServers([upstream], parseManifest(POLICY, "m.yaml")),
    ).resolves.toBeUndefined();
  });

  it("passes again once the new shape is re-blessed", async () => {
    upstream = await upgraded();
    const after = await toolShapes(upstream);
    const block = pinBlock(new Map([["crm", after]]), parseManifest(POLICY, "m.yaml"));
    const manifest = parseManifest(`${POLICY}\n${block}\n`, "m.yaml");
    await expect(verifyAgainstServers([upstream], manifest)).resolves.toBeUndefined();
  });
});
