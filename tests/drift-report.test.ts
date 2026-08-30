import { describe, expect, it } from "vitest";

import { DriftConflict } from "../src/errors.js";

/**
 * A drift halt used to print the expected and actual contents of the resource
 * in full. On a 200-line file that is two screens of escaped JSON with the one
 * line that matters somewhere inside it, which is the same as not saying.
 */
const snapshot = (content: string): unknown => ({ present: true, value: { content } });

const FILE = ["import type {A} from './a.js';", "", "export type B = A;", "", "export {};"].join("\n");

describe("what a drift halt tells you", () => {
  it("shows the lines that differ, not the documents", () => {
    const edited = `${FILE}\n\n// A HUMAN FIXED THIS BY HAND.\n`;
    const message = new DriftConflict(4, snapshot(FILE), snapshot(edited)).message;

    expect(message).toContain("drift at sequence 4");
    expect(message).toContain("+ // A HUMAN FIXED THIS BY HAND.");
    expect(message).toContain("added.");

    // The part that was the bug: everything the two sides agree on is gone.
    expect(message).not.toContain("import type {A}");
    expect(message).not.toContain("export type B");
  });

  it("says where, so the line can be found without hunting", () => {
    const changed = FILE.replace("export type B = A;", "export type B = unknown;");
    const message = new DriftConflict(9, snapshot(FILE), snapshot(changed)).message;

    // The common head is two lines, so the difference starts at the third.
    expect(message).toContain("at line 3:");
    expect(message).toContain("- export type B = A;");
    expect(message).toContain("+ export type B = unknown;");
    expect(message).toContain("1 removed, 1 added.");
  });

  it("stays readable when a whole file was replaced", () => {
    const wall = Array.from({ length: 400 }, (_, i) => `line ${String(i)}`).join("\n");
    const other = Array.from({ length: 400 }, (_, i) => `other ${String(i)}`).join("\n");
    const message = new DriftConflict(1, snapshot(wall), snapshot(other)).message;

    // Eight lines a side plus a count of the rest, not eight hundred.
    expect(message.split("\n").length).toBeLessThan(25);
    expect(message).toContain("more");
    expect(message).toContain("400 removed, 400 added.");
  });

  it("falls back to the values when there are no two texts to compare", () => {
    // A resource that is simply gone has nothing to diff against.
    const message = new DriftConflict(2, snapshot(FILE), { present: false }).message;

    expect(message).toContain("expected:");
    expect(message).toContain("actual:");
    expect(message).toContain('"present":false');
  });

  it("survives a value JSON.stringify cannot render", () => {
    // JSON.stringify returns undefined rather than a string for this, and
    // .length on that throws. A drift report is the wrong place to crash.
    expect(() => new DriftConflict(3, undefined, undefined).message).not.toThrow();
    expect(new DriftConflict(3, undefined, undefined).message).toContain("undefined");
  });
});
