import { describe, expect, it } from "vitest";

import { explain, replacementFor } from "../app/providers/explain.js";

/**
 * Every provider says no in its own dialect, wrapped in its own JSON.
 *
 * These are the real bodies, kept verbatim: a model retired by Google, a model
 * an account is not entitled to at Mistral, and a key that is wrong. What a
 * person needs from all three is the same -- what is wrong, and the one thing
 * to change -- and what they got was the wrapper.
 */
describe("reading a provider's refusal", () => {
  it("says a retired model is gone, and what replaced it", () => {
    const said = explain(
      "gemini-3-pro-preview",
      '{"error":{"code":404,"message":"This model models/gemini-3-pro-preview is no longer available. Please update your code to use models/gemini-3.1-pro-preview for the latest features and improvements.","status":"NOT_FOUND"}}',
    );
    expect(said.aboutTheModel).toBe(true);
    expect(said.instead).toBe("gemini-3.1-pro-preview");
    expect(said.said).toContain("not there any more");
    expect(said.said).toContain("gemini-3.1-pro-preview");
    // And it does not read as a bug in this application.
    expect(said.said).not.toContain("NOT_FOUND");
  });

  it("says a model the plan does not include is a plan problem, not a broken app", () => {
    const said = explain(
      "mistral-large-latest",
      '{"object":"error","message":"This model is not available in your subscription tier","type":"tier_not_allowed","code":"1910"}',
    );
    expect(said.aboutTheModel).toBe(true);
    expect(said.said).toContain("cannot use mistral-large-latest");
    expect(said.said).toMatch(/plan/);
  });

  it("sends a refused key to the place the key is kept", () => {
    const said = explain("claude-opus-5", "401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}");
    expect(said.aboutTheModel).toBe(false);
    expect(said.said).toMatch(/key .* refused|refused/i);
    expect(said.said).toContain("Models and keys");
  });

  it("passes anything it does not recognise through untouched", () => {
    const odd = "the server closed the connection after 3 bytes";
    expect(explain("qwen3:8b", odd).said).toBe(odd);
    expect(explain("qwen3:8b", odd).aboutTheModel).toBe(false);
  });

  it("takes the replacement and not the model being complained about", () => {
    // The trap in Google's message: it names the dead model first and the live
    // one second, both as `models/...`. Matching the first would hand somebody
    // back the exact name that had just stopped working.
    const both =
      "This model models/gemini-3-pro-preview is no longer available. " +
      "Please update your code to use models/gemini-3.1-pro-preview for the latest features.";
    expect(replacementFor(both)).toBe("gemini-3.1-pro-preview");
    expect(replacementFor("the pipe closed after 3 bytes")).toBeUndefined();
  });
});
