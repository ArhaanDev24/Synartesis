import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { ToyCrmStore } from "../fixtures/toy-crm/store.js";
import { createToyCrmServer } from "../fixtures/toy-crm/server.js";

const TOOL_NAMES = [
  "create_customer",
  "delete_customer",
  "get_customer",
  "restore_customer",
  "send_email",
  "update_customer",
];

/**
 * The SDK types callTool's return as a union of the modern and legacy result
 * shapes. Parsing rather than asserting keeps the tests honest about what the
 * fixture actually put on the wire.
 */
const toolResultSchema = z.object({
  isError: z.boolean().default(false),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

async function connect(store: ToyCrmStore): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createToyCrmServer(store);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const result = toolResultSchema.parse(await client.callTool({ name, arguments: args }));
  expect(result.content).toHaveLength(1);
  const block = result.content[0];
  if (block === undefined) {
    throw new Error(`${name} returned no content`);
  }
  return { isError: result.isError, text: block.text };
}

/** Every fixture tool returns its payload as JSON in a single text block. */
async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { isError, text } = await call(client, name, args);
  if (isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text) as unknown;
}

describe("toy-crm store", () => {
  it("seeds deterministically", () => {
    expect(new ToyCrmStore().__snapshot()).toEqual(new ToyCrmStore().__snapshot());
  });

  it("returns a snapshot that later mutations cannot reach", () => {
    const store = new ToyCrmStore();
    const before = store.__snapshot();
    store.updateCustomer("c_001", { plan: "free" });
    expect(before.customers["c_001"]?.plan).toBe("pro");
    expect(store.__snapshot().customers["c_001"]?.plan).toBe("free");
  });

  it("treats an explicitly undefined patch field as absent, not as an erasure", () => {
    const store = new ToyCrmStore();
    store.updateCustomer("c_001", { plan: "free", notes: undefined });
    const after = store.__snapshot().customers["c_001"];
    expect(after?.notes).toBe("founding customer");
    expect(after?.plan).toBe("free");
  });

  it("allocates ids without reusing a deleted one", () => {
    const store = new ToyCrmStore();
    const first = store.createCustomer({ name: "N", email: "n@example.com", plan: "free", notes: "" });
    store.deleteCustomer(first.id);
    const second = store.createCustomer({ name: "M", email: "m@example.com", plan: "free", notes: "" });
    expect(second.id).not.toBe(first.id);
  });
});

describe("toy-crm MCP server", () => {
  it("completes a handshake and identifies itself", async () => {
    const client = await connect(new ToyCrmStore());
    expect(client.getServerVersion()?.name).toBe("toy-crm");
  });

  it("lists exactly the documented tool surface", async () => {
    const client = await connect(new ToyCrmStore());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("reads a seeded customer", async () => {
    const client = await connect(new ToyCrmStore());
    expect(await callJson(client, "get_customer", { id: "c_001" })).toMatchObject({
      id: "c_001",
      plan: "pro",
    });
  });

  it("reports a missing customer as a tool error, not a protocol error", async () => {
    const client = await connect(new ToyCrmStore());
    const result = await call(client, "get_customer", { id: "c_nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("c_nope");
  });

  it("rejects arguments that do not match the input schema", async () => {
    const client = await connect(new ToyCrmStore());
    const result = await call(client, "update_customer", { id: "c_001", plan: "platinum" });
    expect(result.isError).toBe(true);
  });

  it("applies update_customer as a partial patch", async () => {
    const store = new ToyCrmStore();
    const client = await connect(store);
    await callJson(client, "update_customer", { id: "c_001", plan: "free" });
    const after = store.__snapshot().customers["c_001"];
    expect(after?.plan).toBe("free");
    expect(after?.name).toBe("Ada Lovelace");
  });

  it("creates and deletes customers", async () => {
    const store = new ToyCrmStore();
    const client = await connect(store);
    const created = z
      .object({ id: z.string() })
      .parse(
        await callJson(client, "create_customer", {
          name: "Katherine Johnson",
          email: "kj@example.com",
          plan: "pro",
        }),
      );
    expect(store.__snapshot().customers[created.id]?.name).toBe("Katherine Johnson");

    await callJson(client, "delete_customer", { id: created.id });
    expect(store.__snapshot().customers[created.id]).toBeUndefined();
  });

  it("restores a deleted customer under its original id", async () => {
    const store = new ToyCrmStore();
    const client = await connect(store);
    const before = store.__snapshot();

    await callJson(client, "delete_customer", { id: "c_002" });
    expect(store.__snapshot().customers["c_002"]).toBeUndefined();

    await callJson(client, "restore_customer", {
      id: "c_002",
      name: "Grace Hopper",
      email: "grace@example.com",
      plan: "enterprise",
      notes: "renewal in March",
    });
    expect(store.__snapshot()).toEqual(before);
  });

  it("records sent email in an append-only outbox", async () => {
    const store = new ToyCrmStore({ now: () => "2026-01-01T00:00:00.000Z" });
    const client = await connect(store);
    await callJson(client, "send_email", {
      to: "ada@example.com",
      subject: "hello",
      body: "world",
    });
    expect(store.__snapshot().outbox).toEqual([
      { to: "ada@example.com", subject: "hello", body: "world", sentAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });
});
