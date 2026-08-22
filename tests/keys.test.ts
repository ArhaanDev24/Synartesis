import { describe, expect, it } from "vitest";

import { keysIn } from "../src/keys.js";

const ESC = "";
const CTRL_C = "";

describe("splitting what a terminal hands over", () => {
  it("separates keys that arrived in one read", () => {
    // A terminal delivers whatever has accumulated, so two quick presses are
    // one data event. Matched whole, "uy" is neither u nor y and both are lost.
    expect(keysIn("uy")).toEqual(["u", "y"]);
    expect(keysIn("jjk")).toEqual(["j", "j", "k"]);
  });

  it("keeps an escape sequence together", () => {
    expect(keysIn(`${ESC}[A`)).toEqual([`${ESC}[A`]);
    expect(keysIn(`${ESC}[B${ESC}[B`)).toEqual([`${ESC}[B`, `${ESC}[B`]);
    // An arrow and then a letter, in one read.
    expect(keysIn(`${ESC}[Ba`)).toEqual([`${ESC}[B`, "a"]);
  });

  it("passes a lone escape through, since it is the key for going back", () => {
    expect(keysIn(ESC)).toEqual([ESC]);
    expect(keysIn(`${ESC}q`)).toEqual([ESC, "q"]);
  });

  it("keeps control characters, which is how ctrl-c arrives", () => {
    expect(keysIn(CTRL_C)).toEqual([CTRL_C]);
    expect(keysIn(`a${CTRL_C}`)).toEqual(["a", CTRL_C]);
  });

  it("handles the other shapes a terminal sends", () => {
    // SS3, which is what some terminals send for arrows in application mode.
    expect(keysIn(`${ESC}OA`)).toEqual([`${ESC}OA`]);
    // A parameterised sequence, such as a bracketed paste marker.
    expect(keysIn(`${ESC}[200~`)).toEqual([`${ESC}[200~`]);
  });

  it("returns nothing for nothing", () => {
    expect(keysIn("")).toEqual([]);
  });
});
