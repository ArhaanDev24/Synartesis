import { describe, expect, it } from "vitest";

import { ManifestError } from "../src/errors.js";
import { resolveTemplate } from "../src/manifest/template.js";

const context = {
  args: { id: "c_001", nested: { deep: 7 }, items: [{ id: "first" }, { id: "second" }] },
  snapshot: { plan: "pro", notes: "" },
  result: { id: "ch_123", ok: true },
};

describe("template resolution", () => {
  it("reads from the three namespaces", () => {
    expect(resolveTemplate("$.id", context)).toBe("c_001");
    expect(resolveTemplate("$snapshot.plan", context)).toBe("pro");
    expect(resolveTemplate("$result.id", context)).toBe("ch_123");
  });

  it("walks nested paths and array indices", () => {
    expect(resolveTemplate("$.nested.deep", context)).toBe(7);
    expect(resolveTemplate("$.items[1].id", context)).toBe("second");
  });

  it("preserves the value's type rather than stringifying it", () => {
    expect(resolveTemplate("$result.ok", context)).toBe(true);
    expect(resolveTemplate("$snapshot.notes", context)).toBe("");
  });

  it("passes literals through untouched", () => {
    expect(resolveTemplate("plain", context)).toBe("plain");
    expect(resolveTemplate(42, context)).toBe(42);
    expect(resolveTemplate(false, context)).toBe(false);
    expect(resolveTemplate(null, context)).toBe(null);
  });

  it("treats a doubled dollar as an escaped literal", () => {
    expect(resolveTemplate("$$.id", context)).toBe("$.id");
    expect(resolveTemplate("$$100", context)).toBe("$100");
  });

  it("walks objects and arrays inside the template", () => {
    expect(
      resolveTemplate({ a: "$.id", b: ["$snapshot.plan", 3], c: { d: "$result.id" } }, context),
    ).toEqual({ a: "c_001", b: ["pro", 3], c: { d: "ch_123" } });
  });

  it("fails loudly on a path that does not exist", () => {
    expect(() => resolveTemplate("$.missing", context)).toThrow(ManifestError);
    expect(() => resolveTemplate("$.nested.missing", context)).toThrow(/\$\.nested\.missing/);
    expect(() => resolveTemplate("$.items[9].id", context)).toThrow(ManifestError);
  });

  it("fails when a namespace is absent from the context", () => {
    expect(() => resolveTemplate("$snapshot.plan", { args: {} })).toThrow(/snapshot/);
    expect(() => resolveTemplate("$result.id", { args: {} })).toThrow(/result/);
  });

  it("rejects an unknown namespace instead of guessing", () => {
    expect(() => resolveTemplate("$upstream.id", context)).toThrow(ManifestError);
  });

  it("resolves an explicit null rather than calling it missing", () => {
    expect(resolveTemplate("$.maybe", { args: { maybe: null } })).toBe(null);
  });
});
