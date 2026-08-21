import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { CustomerNotFoundError, PLANS, ToyCrmStore } from "./store.js";

/**
 * Tools are named without a server prefix, the way a real upstream MCP server
 * names them. The `crm.` prefix used in manifest matches is applied by the
 * proxy from the server's key in the manifest, not by the server itself.
 */

const planSchema = z.enum(PLANS);

/** Real MCP servers overwhelmingly return JSON inside a text block; match that. */
function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * A missing customer is a tool-level error, not a protocol error: the agent
 * should be able to read it and recover, exactly as the gate's denial path
 * must behave in Phase 5.
 */
function guard(run: () => CallToolResult): CallToolResult {
  try {
    return run();
  } catch (error: unknown) {
    if (error instanceof CustomerNotFoundError) {
      return toolError(error.message);
    }
    throw error;
  }
}

export function createToyCrmServer(store: ToyCrmStore): McpServer {
  const server = new McpServer(
    { name: "toy-crm", version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: "A toy CRM. Customer ids look like c_001.",
    },
  );

  // Resources exist so that the proxy's resources/* passthrough is testable;
  // a tools-only fixture could not exercise it.
  server.registerResource(
    "customers",
    "crm://customers",
    { description: "Every customer record.", mimeType: "application/json" },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(store.listCustomers()),
        },
      ],
    }),
  );

  server.registerResource(
    "customer",
    new ResourceTemplate("crm://customers/{id}", { list: undefined }),
    { description: "A single customer record.", mimeType: "application/json" },
    (uri, { id }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(store.getCustomer(typeof id === "string" ? id : "")),
        },
      ],
    }),
  );

  server.registerTool(
    "get_customer",
    {
      description: "Fetch a single customer record by id.",
      inputSchema: { id: z.string().describe("Customer id, for example c_001.") },
    },
    ({ id }) => guard(() => json(store.getCustomer(id))),
  );

  server.registerTool(
    "create_customer",
    {
      description: "Create a customer and return the created record, including its assigned id.",
      inputSchema: {
        name: z.string(),
        email: z.string(),
        plan: planSchema.default("free"),
        notes: z.string().default(""),
      },
      annotations: { destructiveHint: false },
    },
    (draft) => json(store.createCustomer(draft)),
  );

  server.registerTool(
    "update_customer",
    {
      description: "Apply a partial patch to a customer. Omitted fields are left unchanged.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        email: z.string().optional(),
        plan: planSchema.optional(),
        notes: z.string().optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ id, ...patch }) => guard(() => json(store.updateCustomer(id, patch))),
  );

  server.registerTool(
    "delete_customer",
    {
      description: "Delete a customer and return the record as it was immediately before deletion.",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    ({ id }) => guard(() => json(store.deleteCustomer(id))),
  );

  server.registerTool(
    "restore_customer",
    {
      description:
        "Recreate a previously deleted customer under its original id. Intended as the inverse of delete_customer.",
      inputSchema: {
        id: z.string(),
        name: z.string(),
        email: z.string(),
        plan: planSchema,
        notes: z.string(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    (customer) => json(store.restoreCustomer(customer)),
  );

  server.registerTool(
    "send_email",
    {
      description: "Send an email to a customer. This cannot be recalled once sent.",
      inputSchema: { to: z.string(), subject: z.string(), body: z.string() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ to, subject, body }) => json(store.sendEmail(to, subject, body)),
  );

  return server;
}
