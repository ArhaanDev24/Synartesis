import { describe, expect, it } from "vitest";

import { candidates, findDesktop, whereToGetIt } from "../src/desktop.js";
import { pathsIn } from "../app/main/touched.js";

/**
 * Two small pieces that are easy to get quietly wrong.
 *
 * A folder report that lists a file because a sentence in some prose happened
 * to contain a slash is a report nobody trusts twice; and a `desktop` command
 * that looks in the wrong place says the application is not installed when it
 * is sitting right there.
 */

describe("finding files in a call's arguments", () => {
  it("takes paths and leaves prose alone", () => {
    expect(
      pathsIn({
        path: "/Users/a/notes.md",
        content: "See the section on http://example.com/docs and and/or elsewhere.",
      }),
    ).toEqual(["/Users/a/notes.md"]);
  });

  it("finds them however deep, and in lists", () => {
    expect(
      pathsIn({ paths: ["/a/one.txt", "/a/two.txt"], options: { into: { dest: "/b/three.txt" } } }),
    ).toEqual(["/a/one.txt", "/a/two.txt", "/b/three.txt"]);
  });

  it("recognises a Windows path", () => {
    expect(pathsIn({ path: "C:\\Users\\a\\notes.md" })).toEqual(["C:\\Users\\a\\notes.md"]);
  });

  it("finds nothing in a call that names no file", () => {
    expect(pathsIn({ query: "revenue", limit: 10 })).toEqual([]);
    expect(pathsIn(undefined)).toEqual([]);
  });
});

describe("opening the desktop application", () => {
  it("hands a macOS bundle to the window server rather than running the binary", () => {
    const found = findDesktop("darwin", (path) => path === "/Applications/Synartesis.app");
    expect(found?.path).toBe("/Applications/Synartesis.app");
    // `open`, so it gets a dock icon and outlives the terminal that started it.
    expect(found?.open.command).toBe("open");
    expect(found?.open.args).toEqual(["-a", "/Applications/Synartesis.app"]);
  });

  it("runs the executable directly everywhere else", () => {
    const found = findDesktop("linux", (path) => path === "/opt/Synartesis/synartesis-desktop");
    expect(found?.open.command).toBe("/opt/Synartesis/synartesis-desktop");
    expect(found?.open.args).toEqual([]);
  });

  it("looks somewhere real on each platform", () => {
    expect(candidates("darwin").some((path) => path.startsWith("/Applications"))).toBe(true);
    expect(candidates("win32").some((path) => path.endsWith(".exe"))).toBe(true);
    expect(candidates("linux").length).toBeGreaterThan(0);
  });

  it("says where to get it rather than fetching anything", () => {
    const said = whereToGetIt("darwin");
    expect(said).toContain("releases");
    expect(said).toContain(".dmg");
    // The reason it is a separate download, so nobody files this as a bug.
    expect(said).toMatch(/browser engine/);
    expect(findDesktop("darwin", () => false)).toBeUndefined();
  });
});
