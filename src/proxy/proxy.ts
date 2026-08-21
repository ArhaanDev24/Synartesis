import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Notification, Request } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";

import { UpstreamError, describe } from "../errors.js";
import type { Journal } from "../journal/journal.js";
import type { Upstream } from "./upstream.js";

export interface ProxyOptions {
  readonly upstream: Upstream;
  readonly journal: Journal;
}

export interface ProxyServer {
  readonly server: McpServer;
  /** Resolves with the run id once the client session is initialized. */
  readonly ready: Promise<string>;
}

/**
 * Results are forwarded unmodified. A narrower schema would silently drop
 * fields the upstream added, which is precisely the invisibility Phase 1 has
 * to prove it does not break.
 */
const PassthroughResult = z.looseObject({});

type Extra = RequestHandlerExtra<Request, Notification>;

/**
 * McpError bakes its prefix into `message` and keeps no copy of the original,
 * so rethrowing one would prefix it a second time on the way out. The prefix
 * is a fixed format string, so removing it reconstructs the original exactly
 * rather than guessing at it.
 */
function unwrap(error: McpError): string {
  const prefix = `MCP error ${String(error.code)}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

function rethrow(server: string, operation: string, error: unknown): never {
  if (error instanceof McpError) {
    throw new McpError(error.code, unwrap(error), error.data);
  }
  throw new UpstreamError(server, operation, error);
}

export function createProxyServer(options: ProxyOptions): ProxyServer {
  const { upstream, journal } = options;
  const client = upstream.client;

  const identity = client.getServerVersion();
  if (identity === undefined) {
    throw new UpstreamError(upstream.name, "initialize", "upstream reported no server info");
  }
  const capabilities = client.getServerCapabilities() ?? {};
  const instructions = client.getInstructions();

  // The proxy presents the upstream's identity so that any client-side
  // behaviour keyed on server name or version keeps working through it.
  // McpServer is used only as a lifecycle wrapper: its registration helpers
  // assume a fixed local tool set, which a passthrough by definition lacks, so
  // handlers are attached to the protocol server underneath it.
  const wrapper = new McpServer(identity, {
    capabilities,
    ...(instructions === undefined ? {} : { instructions }),
  });
  const server = wrapper.server;

  let runId: string | undefined;
  let resolveReady: (id: string) => void = () => undefined;
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });

  type Passthrough = { [key: string]: unknown };

  const forward = async (request: Request, extra: Extra): Promise<Passthrough> => {
    try {
      return await client.request(request, PassthroughResult, { signal: extra.signal });
    } catch (error: unknown) {
      return rethrow(upstream.name, request.method, error);
    }
  };

  const relay = async (request: Request, extra: Extra): Promise<Passthrough> =>
    forward(request, extra);

  if (capabilities.tools !== undefined) {
    server.setRequestHandler(ListToolsRequestSchema, relay);

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (runId === undefined) {
        throw new UpstreamError(upstream.name, "tools/call", "no active run");
      }

      // Spec 3.1: the row lands before the call goes out. A row still marked
      // pending after the process dies means the outcome is genuinely unknown.
      const pending = journal.recordPending({
        runId,
        server: upstream.name,
        tool: request.params.name,
        args: request.params.arguments ?? {},
      });

      try {
        const result = await client.request(request, PassthroughResult, { signal: extra.signal });
        // An isError result means the tool ran and reported failure, which is
        // still an applied call; the result is kept verbatim either way.
        journal.markApplied(pending.actionId, result);
        return result;
      } catch (error: unknown) {
        journal.markFailed(pending.actionId, describe(error));
        return rethrow(upstream.name, "tools/call", error);
      }
    });
  }

  if (capabilities.resources !== undefined) {
    server.setRequestHandler(ListResourcesRequestSchema, relay);
    server.setRequestHandler(ListResourceTemplatesRequestSchema, relay);
    server.setRequestHandler(ReadResourceRequestSchema, relay);
    if (capabilities.resources.subscribe === true) {
      server.setRequestHandler(SubscribeRequestSchema, relay);
      server.setRequestHandler(UnsubscribeRequestSchema, relay);
    }
  }

  if (capabilities.prompts !== undefined) {
    server.setRequestHandler(ListPromptsRequestSchema, relay);
    server.setRequestHandler(GetPromptRequestSchema, relay);
  }

  if (capabilities.completions !== undefined) {
    server.setRequestHandler(CompleteRequestSchema, relay);
  }

  if (capabilities.logging !== undefined) {
    server.setRequestHandler(SetLevelRequestSchema, relay);
  }

  // Upstream notifications (tools/list_changed, resources/updated, log
  // messages) reach the client unchanged; dropping them would make the proxy
  // visible to any client that relies on them.
  let connected = false;
  client.fallbackNotificationHandler = async (notification): Promise<void> => {
    if (connected) {
      await server.notification(notification);
    }
  };

  server.oninitialized = (): void => {
    connected = true;
    const id = journal.beginRun(server.getClientVersion()?.name);
    runId = id;
    resolveReady(id);
  };

  const previousOnClose = server.onclose;
  server.onclose = (): void => {
    connected = false;
    if (runId !== undefined) {
      journal.endRun(runId, "complete");
      runId = undefined;
    }
    previousOnClose?.();
  };

  return { server: wrapper, ready };
}
