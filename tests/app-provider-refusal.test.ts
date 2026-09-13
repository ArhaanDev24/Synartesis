import { describe, expect, it } from "vitest";

import { explain, namely, replacementFor, retryAfter } from "../app/providers/explain.js";

/**
 * The 429 Google sends a free key that asks for a Pro model, verbatim.
 *
 * Every metric on it reads `limit: 0`, and in the same breath it says "Please
 * retry in 23.392160463s". Both are true and only one is useful: there is no
 * allowance to come back to, so the retry it recommends succeeds on no
 * schedule at all.
 */
const NO_ALLOWANCE =
  '{"error":{"message":"{\n  \"error\": {\n    \"code\": 429,\n    \"message\": \"You exceeded your current quota, please check your plan and billing details. ' +
  "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro\n" +
  '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro\nPlease retry in 23.392160463s.\",\n' +
  '    \"status\": \"RESOURCE_EXHAUSTED\",\n    \"details\": [{\"@type\": \"type.googleapis.com/google.rpc.RetryInfo\", \"retryDelay\": \"23s\"}]}}","code":429,"status":"Too Many Requests"}}';

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

  it("does not find a recommendation in the middle of an ordinary word", () => {
    // `try` and `use` are the ends of common words. Matched without a
    // boundary, "industry standard" recommends a model called "standard" --
    // and the sentence this feeds reads as though the provider said it.
    expect(replacementFor("the industry standard endpoint returned nothing")).toBeUndefined();
    expect(replacementFor("misuse detected on this key")).toBeUndefined();
    expect(replacementFor(NO_ALLOWANCE)).toBeUndefined();
  });

  it("says a quota of zero is a quota of zero, and does not tell anybody to wait", () => {
    const said = explain("gemini:gemini-3.1-pro-preview", NO_ALLOWANCE);
    expect(said.said).toContain("no quota for gemini-3.1-pro-preview");
    expect(said.said).toMatch(/billing/);
    // The trap: the body asks for 23 seconds, and there is nothing at the end
    // of 23 seconds. Repeating that would send somebody round a loop forever.
    expect(said.after).toBeUndefined();
    expect(said.said).toContain("waiting will not help");
    expect(said.said).not.toMatch(/\b23\b|seconds/i);
    expect(said.aboutTheModel).toBe(true);
  });

  it("says how long to wait when there is something to wait for", () => {
    const said = explain(
      "gemini:gemini-3.1-pro-preview",
      '{"error":{"code":429,"message":"Quota exceeded for metric: generate_content_requests, limit: 60, model: gemini-3.1-pro. Please retry in 8.5s.","status":"RESOURCE_EXHAUSTED"}}',
    );
    expect(said.said).toContain("Too many requests");
    expect(said.said).toContain("9 seconds");
    expect(said.after).toBe(8500);
    // A rate limit is not the model's fault, and changing its name fixes
    // nothing.
    expect(said.aboutTheModel).toBe(false);
  });

  it("recognises a rate limit that names no delay", () => {
    const said = explain(
      "anthropic:claude-opus-5",
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    );
    expect(said.said).toContain("Too many requests");
    expect(said.after).toBeUndefined();
  });

  it("keeps a spent quota apart from a plan that never included the model", () => {
    // Both say "quota". Only one of them is fixed by changing the model name,
    // and only one of them is fixed by waiting.
    const spent = explain("openai-compatible:gpt-5", 'HTTP 429: {"error":{"code":"insufficient_quota"}}');
    expect(spent.said).toContain("no quota for gpt-5");
    expect(spent.after).toBeUndefined();
    const excluded = explain("openai-compatible:mistral-large-latest", '{"type":"tier_not_allowed"}');
    expect(excluded.said).toContain("cannot use mistral-large-latest");
  });

  it("reads the delay out of either shape a provider states it in", () => {
    expect(retryAfter('"retryDelay": "23s"')).toBe(23000);
    expect(retryAfter("Please retry in 8.5s.")).toBe(8500);
    expect(retryAfter("try again after 30 seconds")).toBe(30000);
    expect(retryAfter("the pipe closed")).toBeUndefined();
    // Nought is not a delay; waiting for it is a spin.
    expect(retryAfter('"retryDelay": "0s"')).toBeUndefined();
  });

  it("names the model, not the adapter that carried it", () => {
    expect(namely("gemini:gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(namely("openai-compatible:gpt-5")).toBe("gpt-5");
    // A label somebody typed is theirs, colons and all.
    expect(namely("Work: Mistral")).toBe("Work: Mistral");
    expect(namely("qwen3:8b")).toBe("qwen3:8b");
  });
});
