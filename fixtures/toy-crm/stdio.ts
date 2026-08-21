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

await server.connect(new StdioServerTransport());
