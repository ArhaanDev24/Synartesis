import { describe, expect, it } from "vitest";

import { ManifestError } from "../src/errors.js";
import { resolveTemplate } from "../src/manifest/template.js";

const context = {
  args: { id: "c_001", nested: { deep: 7 }, items: [{ id: "first" }, { id: "second" }] },
  snapshot: {
    plan: "pro",
    notes: "",
    labels: [
      { id: 1, name: "bug", color: "red" },
      { id: 2, name: "urgent", color: "orange" },
    ],
    assignees: [] as { login: string }[],
  },
  result: { id: "ch_123", ok: true },
};

describe("template resolution", () => {
  it("reads from the three namespaces", () => {
    expect(resolveTemplate("$.id", context)).toBe("c_001");
    expect(resolveTemplate("$snapshot.plan", context)).toBe("pro");
    expect(resolveTemplate("$result.id", context)).toBe("ch_123");
  });

  it("resolves a bare namespace to the whole value", () => {
    // A file's contents are not a field of anything, so there has to be a way
    // to say "all of it".
    expect(resolveTemplate("$snapshot", context)).toEqual(context.snapshot);
    expect(resolveTemplate("$result", context)).toEqual({ id: "ch_123", ok: true });
    expect(resolveTemplate("$", context)).toEqual(context.args);
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

  it("projects a field across a list", () => {
    // What an API that hands back objects and takes names needs. GitHub does
    // exactly this with issue labels.
    expect(resolveTemplate("$snapshot.labels[].name", context)).toEqual(["bug", "urgent"]);
  });

  it("projects across an empty list without complaining", () => {
    expect(resolveTemplate("$snapshot.assignees[].login", context)).toEqual([]);
  });

  it("still allows a single index, and can follow one with a projection", () => {
    expect(resolveTemplate("$snapshot.labels[0].name", context)).toBe("bug");
    expect(resolveTemplate("$.items[].id", context)).toEqual(["first", "second"]);
  });

  it("refuses to project across something that is not a list", () => {
    expect(() => resolveTemplate("$snapshot.plan[].name", context)).toThrow(/needs a list/);
  });

  it("fails when the projected field is missing from an element", () => {
    expect(() => resolveTemplate("$snapshot.labels[].nope", context)).toThrow(ManifestError);
  });

  it("substitutes references embedded in a sentence", () => {
    // What a person writes for a commit message without being told they can.
    expect(resolveTemplate("Revert: restore previous content of $.id", context)).toBe(
      "Revert: restore previous content of c_001",
    );
    expect(resolveTemplate("was $snapshot.plan, now $result.id", context)).toBe(
      "was pro, now ch_123",
    );
  });

  it("keeps the referenced type when the whole string is one reference", () => {
    expect(resolveTemplate("$result.ok", context)).toBe(true);
    expect(resolveTemplate("$snapshot", context)).toEqual(context.snapshot);
    // Only once it is embedded does it become text.
    expect(resolveTemplate("ok=$result.ok", context)).toBe("ok=true");
  });

  it("leaves prose that merely mentions a dollar alone", () => {
    expect(resolveTemplate("costs $5 per seat", context)).toBe("costs $5 per seat");
    expect(resolveTemplate("total: $$.id", context)).toBe("total: $.id");
  });

  it("still fails loudly on an embedded path that does not exist", () => {
    expect(() => resolveTemplate("see $.nope now", context)).toThrow(ManifestError);
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
