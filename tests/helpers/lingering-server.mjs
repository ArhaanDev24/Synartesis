/**
 * An MCP server that does not die the instant it is asked to.
 *
 * Real servers do not either: closing a stdio upstream ends the child's stdin
 * and then waits for the process to go, and a process with anything to finish
 * takes a moment over it. That moment is where a bug lived -- the window's
 * tidy-up ran after this wait, so quitting the application killed it first and
 * an empty session survived every launch. This stands in for that delay so a
 * test can hold the two apart.
 *
 * It offers no tools. Nothing here is about what a server can do.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const LINGER_MS = Number(process.argv[2] ?? 400);

const server = new Server({ name: "lingering", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
await server.connect(new StdioServerTransport());

// A handle held on purpose: without it the process would fall out of the event
// loop the moment stdin ended, which is the one thing this fixture must not do.
const holding = setInterval(() => {}, 1000);
process.stdin.on("end", () => {
  setTimeout(() => {
    clearInterval(holding);
    process.exit(0);
  }, LINGER_MS);
});
