import { afterEach, describe, expect, it } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { createHarness, type Harness } from "./helpers/harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/**
 * Phase 1 has exactly one job: be invisible. Every assertion here compares the
 * proxied client against a client wired straight to the fixture, so the
 * fixture itself is the oracle rather than a hand-written expectation.
 */
describe("proxy transparency", () => {
  it("reports the upstream's identity, capabilities and instructions", async () => {
    harness = await createHarness();
    expect(harness.proxied.getServerVersion()).toEqual(harness.direct.getServerVersion());
    expect(harness.proxied.getServerCapabilities()).toEqual(harness.direct.getServerCapabilities());
    expect(harness.proxied.getInstructions()).toEqual(harness.direct.getInstructions());
  });

  it("returns an identical tool list", async () => {
    harness = await createHarness();
    expect(await harness.proxied.listTools()).toEqual(await harness.direct.listTools());
  });

  it("returns an identical result for a successful call", async () => {
    harness = await createHarness();
    const args = { name: "get_customer", arguments: { id: "c_001" } };
    expect(await harness.proxied.callTool(args)).toEqual(await harness.direct.callTool(args));
  });

  it("passes a tool-level error through unchanged", async () => {
    harness = await createHarness();
    const args = { name: "get_customer", arguments: { id: "c_nope" } };
    const proxied = await harness.proxied.callTool(args);
    expect(proxied).toEqual(await harness.direct.callTool(args));
    expect(proxied.isError).toBe(true);
  });

  it("returns an identical result for an unknown tool", async () => {
    harness = await createHarness();
    const args = { name: "no_such_tool", arguments: {} };
    // The SDK reports an unknown tool as a tool-level error rather than a
    // protocol error, so the interesting assertion is that both paths agree.
    const proxied = await harness.proxied.callTool(args);
    expect(proxied).toEqual(await harness.direct.callTool(args));
    expect(proxied.isError).toBe(true);
  });

  it("preserves the code and message of a genuine protocol error", async () => {
    harness = await createHarness();
    const request = { method: "logging/setLevel", params: { level: "debug" } };
    const result = z.looseObject({});
    const proxiedError = await harness.proxied.request(request, result).catch((e: unknown) => e);
    const directError = await harness.direct.request(request, result).catch((e: unknown) => e);

    expect(proxiedError).toBeInstanceOf(McpError);
    expect(directError).toBeInstanceOf(McpError);
    if (proxiedError instanceof McpError && directError instanceof McpError) {
      expect(proxiedError.code).toBe(directError.code);
      // Not merely equal codes: the message must not pick up a second
      // "MCP error N:" prefix on its way back through the proxy.
      expect(proxiedError.message).toBe(directError.message);
    }
  });

  it("preserves the protocol error for invalid arguments", async () => {
    harness = await createHarness();
    const args = { name: "update_customer", arguments: { id: "c_001", plan: "platinum" } };
    expect(await harness.proxied.callTool(args)).toEqual(await harness.direct.callTool(args));
  });

  it("forwards resources/list, resources/read and resources/templates/list", async () => {
    harness = await createHarness();
    expect(await harness.proxied.listResources()).toEqual(await harness.direct.listResources());
    expect(await harness.proxied.listResourceTemplates()).toEqual(
      await harness.direct.listResourceTemplates(),
    );
    const uri = { uri: "crm://customers" };
    expect(await harness.proxied.readResource(uri)).toEqual(await harness.direct.readResource(uri));
    const one = { uri: "crm://customers/c_002" };
    expect(await harness.proxied.readResource(one)).toEqual(await harness.direct.readResource(one));
  });

  it("does not advertise capabilities the upstream lacks", async () => {
    harness = await createHarness();
    const capabilities = harness.proxied.getServerCapabilities();
    expect(capabilities?.prompts).toBeUndefined();
    await expect(harness.proxied.listPrompts()).rejects.toThrow();
  });

  it("mutates upstream state exactly as a direct call would", async () => {
    harness = await createHarness();
    await harness.proxied.callTool({
      name: "update_customer",
      arguments: { id: "c_003", plan: "pro", notes: "upgraded" },
    });
    expect(harness.store.__snapshot().customers["c_003"]).toEqual({
      id: "c_003",
      name: "Alan Turing",
      email: "alan@example.com",
      plan: "pro",
      notes: "upgraded",
    });
  });
});
