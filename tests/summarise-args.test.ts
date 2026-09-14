import { describe, expect, it } from "vitest";

import { summariseArgs } from "../src/describe.js";

describe("summarising a call's arguments for one line of a timeline", () => {
  it("flattens a multi-line value instead of breaking the line", () => {
    // A short value went through verbatim, so writing two lines to a file
    // split the timeline and left the second at column zero.
    const said = summariseArgs({ content: "north,0\nsouth,0" });
    expect(said).not.toContain("\n");
    expect(said).toBe("content north,0 south,0");
  });

  it("flattens tabs and runs of spaces too", () => {
    expect(summariseArgs({ x: "a\t\t b   c" })).toBe("x a b c");
  });

  it("names the file at the end of a long path", () => {
    const path = `/Users/someone/a/very/deeply/nested/project/directory/${"x".repeat(40)}/ledger.csv`;
    const said = summariseArgs({ path }, 200);
    // The byte count it used to print answered nothing anybody asks.
    expect(said).toContain("ledger.csv");
    expect(said).not.toMatch(/\d+ B/);
    expect(said).toContain("…");
  });

  it("still describes long prose by its size, where the tail says nothing", () => {
    const said = summariseArgs({ content: "word ".repeat(200) }, 200);
    expect(said).toMatch(/content .*B/);
    expect(said).not.toContain("word word");
  });

  it("leaves a short path alone", () => {
    expect(summariseArgs({ path: "/tmp/a.txt" })).toBe("path /tmp/a.txt");
  });

  it("keeps counting arrays and sizing objects", () => {
    expect(summariseArgs({ edits: [1, 2, 3] })).toBe("edits 3 items");
    expect(summariseArgs({ n: 4, ok: true })).toBe("n 4  ok true");
  });

  it("obeys the limit it is given", () => {
    const said = summariseArgs({ a: "x".repeat(10), b: "y".repeat(10) }, 12);
    expect(said.length).toBeLessThanOrEqual(12);
  });
});
