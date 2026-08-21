#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createToyCrmServer } from "./server.js";
import { ToyCrmStore } from "./store.js";

/**
 * Runs the fixture as a real stdio MCP server so the proxy can spawn it the
 * same way it will spawn a production server. State lives for the lifetime of
 * the process and is deliberately not persisted.
 */
const server = createToyCrmServer(new ToyCrmStore());

// Exit when the pipe closes; the SDK's stdio transport does not do this for
// us, and a fixture that outlives its client makes tests hang.
process.stdin.on("end", () => {
  process.exit(0);
});

await server.connect(new StdioServerTransport());
