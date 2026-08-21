import { describe, expect, it } from "vitest";

import { parseManifest } from "../src/manifest/load.js";
import { createPolicyResolver } from "../src/manifest/match.js";

function resolverFor(patterns: readonly (readonly [string, string])[]) {
  const tools = patterns
    .map(([match, cls]) => `  - match: "${match}"\n    class: ${cls}`)
    .join("\n");
  const source = `version: 1
servers: { crm: { command: node, args: [] }, gmail: { command: node, args: [] } }
tools:
${tools}
`;
  return createPolicyResolver(parseManifest(source, "manifest.yaml"));
}

describe("policy matching", () => {
  it("matches an exact tool name", () => {
    const resolver = resolverFor([["crm.get_customer", "readonly"]]);
    const match = resolver.resolve("crm.get_customer");
    expect(match.matched).toBe(true);
    expect(match.policy.class).toBe("readonly");
  });

  it("matches a glob within a segment", () => {
    const resolver = resolverFor([["gmail.send_*", "irreversible"]]);
    expect(resolver.resolve("gmail.send_email").matched).toBe(true);
    expect(resolver.resolve("gmail.send_draft").matched).toBe(true);
    expect(resolver.resolve("gmail.list_messages").matched).toBe(false);
  });

  it("does not let a wildcard cross a dot", () => {
    const resolver = resolverFor([["crm.*", "readonly"]]);
    expect(resolver.resolve("crm.get_customer").matched).toBe(true);
    expect(resolver.resolve("gmail.get_customer").matched).toBe(false);
  });

  it("prefers the exact match over a glob that also matches", () => {
    const resolver = resolverFor([
      ["crm.*", "readonly"],
      ["crm.delete_customer", "irreversible"],
    ]);
    expect(resolver.resolve("crm.delete_customer").policy.class).toBe("irreversible");
    expect(resolver.resolve("crm.get_customer").policy.class).toBe("readonly");
  });

  it("prefers the longer literal when two globs match", () => {
    const resolver = resolverFor([
      ["crm.*", "readonly"],
      ["crm.delete_*", "irreversible"],
    ]);
    expect(resolver.resolve("crm.delete_customer").policy.class).toBe("irreversible");
  });

  it("is independent of declaration order", () => {
    const forwards = resolverFor([
      ["crm.*", "readonly"],
      ["crm.delete_*", "irreversible"],
    ]);
    const backwards = resolverFor([
      ["crm.delete_*", "irreversible"],
      ["crm.*", "readonly"],
    ]);
    expect(forwards.resolve("crm.delete_customer").policy.class).toBe(
      backwards.resolve("crm.delete_customer").policy.class,
    );
  });

  it("fails closed on an unmatched tool", () => {
    const resolver = resolverFor([["crm.get_customer", "readonly"]]);
    const match = resolver.resolve("crm.wire_money");
    // D4: an unrecognised tool is irreversible and gated, never a passthrough.
    expect(match.matched).toBe(false);
    expect(match.policy.class).toBe("irreversible");
    expect(match.policy.gate).toBe("always");
  });

  it("fails closed on a tool from a server with no rules at all", () => {
    const resolver = resolverFor([["crm.get_customer", "readonly"]]);
    expect(resolver.resolve("gmail.send_email").policy.class).toBe("irreversible");
  });
});
