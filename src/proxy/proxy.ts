import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ErrorCode,
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
import type {
  Implementation,
  Request,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { UpstreamError, describe } from "../errors.js";
import type { Journal } from "../journal/journal.js";
import {
  createPolicyResolver,
  type PolicyResolver,
} from "../manifest/match.js";
import { qualify, type Manifest } from "../manifest/types.js";
import { createRouter, type Router } from "./routing.js";
import {
  observeState,
  planInverse,
  planRead,
  runRead,
  toPayload,
  type ResolvedRead,
} from "./snapshot.js";
import type { Upstream } from "./upstream.js";

export interface ProxyOptions {
  readonly upstreams: readonly Upstream[];
  readonly manifest: Manifest;
  readonly journal: Journal;
}

export interface ProxyServer {
  readonly server: McpServer;
  /** Resolves with the run id once the client session is initialized. */
  readonly ready: Promise<string>;
  /** Resolves when no tool call is in flight, so shutdown can drain first. */
  whenIdle(): Promise<void>;
}

type Passthrough = { [key: string]: unknown };

/**
 * Results are read through loose schemas. The SDK's typed schemas strip fields
 * they do not know about, which would quietly erase any metadata an upstream
 * added; only the names this proxy has to rewrite are described here.
 */
const PassthroughResult = z.looseObject({});
const ToolList = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })),
  nextCursor: z.string().optional(),
});
const PromptList = z.looseObject({
  prompts: z.array(z.looseObject({ name: z.string() })),
  nextCursor: z.string().optional(),
});
const ResourceList = z.looseObject({
  resources: z.array(z.looseObject({ uri: z.string() })),
  nextCursor: z.string().optional(),
});
const TemplateList = z.looseObject({
  resourceTemplates: z.array(z.looseObject({ uriTemplate: z.string() })),
  nextCursor: z.string().optional(),
});

function unwrap(error: McpError): string {
  const prefix = `MCP error ${String(error.code)}: `;
  return error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : error.message;
}

function rethrow(server: string, operation: string, error: unknown): never {
  if (error instanceof McpError) {
    throw new McpError(error.code, unwrap(error), error.data);
  }
  throw new UpstreamError(server, operation, error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The client sees one logical server, so it must be told about anything any
 * upstream can do. Sub-objects are merged rather than replaced so that, for
 * example, one server's resources.subscribe survives another's resources {}.
 */
function mergeCapabilities(
  all: readonly ServerCapabilities[],
): ServerCapabilities {
  const merged: Record<string, unknown> = {};
  for (const capabilities of all) {
    for (const [key, value] of Object.entries(capabilities)) {
      const existing = merged[key];
      merged[key] =
        isRecord(existing) && isRecord(value)
          ? { ...existing, ...value }
          : value;
    }
  }
  return merged;
}

function identityFor(router: Router): Implementation {
  const only = router.upstreams[0];
  if (!router.prefixed && only !== undefined) {
    const upstream = only.client.getServerVersion();
    if (upstream !== undefined) {
      return upstream;
    }
  }
  // With several servers behind it there is no single identity to mirror.
  return { name: "synartesis", version: "0.0.0" };
}

function instructionsFor(router: Router): string | undefined {
  const sections = router.upstreams
    .map((upstream) => ({
      name: upstream.name,
      text: upstream.client.getInstructions(),
    }))
    .filter(
      (section): section is { name: string; text: string } =>
        section.text !== undefined,
    );
  if (sections.length === 0) {
    return undefined;
  }
  if (!router.prefixed) {
    return sections[0]?.text;
  }
  return sections
    .map((section) => `Tools prefixed ${section.name}__:\n${section.text}`)
    .join("\n\n");
}

/** Walks every page so that aggregation across servers is never partial. */
async function drain<T>(
  fetch: (
    cursor: string | undefined,
  ) => Promise<{ items: T[]; nextCursor: string | undefined }>,
): Promise<T[]> {
  const collected: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetch(cursor);
    collected.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return collected;
}

export function createProxyServer(options: ProxyOptions): ProxyServer {
  const { upstreams, manifest, journal } = options;
  const router = createRouter(upstreams, manifest);
  const policies: PolicyResolver = createPolicyResolver(manifest);

  const capabilities = mergeCapabilities(
    upstreams.map((upstream) => upstream.client.getServerCapabilities() ?? {}),
  );
  const instructions = instructionsFor(router);

  const wrapper = new McpServer(identityFor(router), {
    capabilities,
    ...(instructions === undefined ? {} : { instructions }),
  });
  const server = wrapper.server;

  let runId: string | undefined;
  let resolveReady: (id: string) => void = () => undefined;
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });

  let inflight = 0;
  const idle: (() => void)[] = [];
  const whenIdle = async (): Promise<void> => {
    if (inflight === 0) {
      return;
    }
    await new Promise<void>((resolve) => idle.push(resolve));
  };

  // A client that pipelines notifications/initialized ahead of the initialize
  // response can reach oninitialized before its own identity is recorded, so
  // the label is filled in at the first opportunity rather than once.
  let labelled = false;
  const ensureLabel = (): void => {
    if (labelled || runId === undefined) {
      return;
    }
    const name = server.getClientVersion()?.name;
    if (name !== undefined) {
      journal.setRunLabel(runId, name);
      labelled = true;
    }
  };

  const supports = (
    upstream: Upstream,
    key: keyof ServerCapabilities,
  ): boolean => upstream.client.getServerCapabilities()?.[key] !== undefined;

  const ask = async (
    upstream: Upstream,
    request: Request,
    signal: AbortSignal,
  ): Promise<Passthrough> => {
    try {
      return await upstream.client.request(request, PassthroughResult, {
        signal,
      });
    } catch (error: unknown) {
      return rethrow(upstream.name, request.method, error);
    }
  };

  // --- resource ownership -------------------------------------------------
  // A resource uri is an opaque identifier the client hands back verbatim, so
  // unlike a tool name it cannot be namespaced. Ownership therefore has to be
  // discovered from what each server advertises.
  let owners: Map<string, string> | undefined;
  let schemes: Map<string, string> | undefined;
  let conflict: string | undefined;

  const refreshResources = async (signal: AbortSignal): Promise<void> => {
    const nextOwners = new Map<string, string>();
    const nextSchemes = new Map<string, string>();
    let nextConflict: string | undefined;

    for (const upstream of router.upstreams) {
      if (!supports(upstream, "resources")) {
        continue;
      }
      const resources = await drain(async (cursor) => {
        const raw = await ask(
          upstream,
          {
            method: "resources/list",
            params: cursor === undefined ? {} : { cursor },
          },
          signal,
        );
        const page = ResourceList.parse(raw);
        return { items: page.resources, nextCursor: page.nextCursor };
      });
      for (const resource of resources) {
        const existing = nextOwners.get(resource.uri);
        if (existing !== undefined && existing !== upstream.name) {
          nextConflict ??= `resource ${resource.uri} is advertised by both ${existing} and ${upstream.name}; a uri cannot be namespaced, so one of them must stop exposing it`;
        }
        nextOwners.set(resource.uri, existing ?? upstream.name);
        const scheme = resource.uri.split(":")[0] ?? "";
        if (scheme !== "" && !nextSchemes.has(scheme)) {
          nextSchemes.set(scheme, upstream.name);
        }
      }

      const templates = await drain(async (cursor) => {
        const raw = await ask(
          upstream,
          {
            method: "resources/templates/list",
            params: cursor === undefined ? {} : { cursor },
          },
          signal,
        );
        const page = TemplateList.parse(raw);
        return { items: page.resourceTemplates, nextCursor: page.nextCursor };
      });
      for (const template of templates) {
        const scheme = template.uriTemplate.split(":")[0] ?? "";
        if (scheme !== "" && !nextSchemes.has(scheme)) {
          nextSchemes.set(scheme, upstream.name);
        }
      }
    }

    owners = nextOwners;
    schemes = nextSchemes;
    conflict = nextConflict;
  };

  const ensureResources = async (signal: AbortSignal): Promise<void> => {
    if (owners === undefined) {
      await refreshResources(signal);
    }
    if (conflict !== undefined) {
      throw new McpError(ErrorCode.InternalError, conflict);
    }
  };

  const ownerOf = async (
    uri: string,
    signal: AbortSignal,
  ): Promise<Upstream> => {
    await ensureResources(signal);
    const direct = owners?.get(uri);
    const scheme = uri.split(":")[0] ?? "";
    const name = direct ?? schemes?.get(scheme);
    const upstream = name === undefined ? undefined : router.byName(name);
    if (upstream === undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `no configured server provides ${uri}`,
      );
    }
    return upstream;
  };

  // --- handlers -----------------------------------------------------------
  if (capabilities.tools !== undefined) {
    server.setRequestHandler(
      ListToolsRequestSchema,
      async (_request, extra) => {
        const tools: Passthrough[] = [];
        for (const upstream of router.upstreams) {
          if (!supports(upstream, "tools")) {
            continue;
          }
          const items = await drain(async (cursor) => {
            const raw = await ask(
              upstream,
              {
                method: "tools/list",
                params: cursor === undefined ? {} : { cursor },
              },
              extra.signal,
            );
            const page = ToolList.parse(raw);
            return { items: page.tools, nextCursor: page.nextCursor };
          });
          for (const tool of items) {
            tools.push({
              ...tool,
              name: router.expose(upstream.name, tool.name),
            });
          }
        }
        // Pagination is flattened: a cursor would have to encode a position
        // across several independent servers, and the client gains nothing.
        return { tools };
      },
    );

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (runId === undefined) {
        throw new UpstreamError("proxy", "tools/call", "no active run");
      }
      ensureLabel();
      const route = router.route(request.params.name);
      if (route === undefined) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `no configured server provides tool ${request.params.name}`,
        );
      }

      const { policy } = policies.resolve(
        qualify(route.upstream.name, route.tool),
      );
      const args = request.params.arguments ?? {};
      // Counted from here, not from the forward call: the pre-read is part of
      // the action, and a shutdown that aborts it blocks a legitimate write.
      inflight += 1;
      try {
        const pending = journal.recordPending({
          runId,
          server: route.upstream.name,
          tool: route.tool,
          args,
          class: policy.class,
        });

        // The pre-read happens before the write goes out, and a failure stops
        // the write entirely: a reversible action without a snapshot is silently
        // irreversible, which is worse than the action not happening at all.
        let snapshot: unknown;
        let verify: ResolvedRead | undefined;
        if (policy.snapshot !== undefined) {
          try {
            verify = planRead(policy.snapshot, { args });
            snapshot = await runRead(router, verify, extra.signal);
          } catch (error: unknown) {
            const reason = describe(error);
            journal.markFailed(pending.actionId, reason);
            throw new McpError(
              ErrorCode.InternalError,
              `synartesis blocked ${request.params.name}: ${reason}`,
            );
          }
          journal.attachSnapshot(pending.actionId, snapshot);
        }

        const forwarded: Request = {
          method: "tools/call",
          params: { ...request.params, name: route.tool },
        };
        try {
          const result = await route.upstream.client.request(
            forwarded,
            PassthroughResult,
            {
              signal: extra.signal,
            },
          );

          const context = { args, snapshot, result: toPayload(result) };
          const warnings: string[] = [];

          // Resolved now rather than at rollback time (D5).
          let inverse: unknown;
          if (policy.inverse !== undefined) {
            try {
              inverse = planInverse(policy.inverse, context);
            } catch (error: unknown) {
              warnings.push(
                `inverse could not be resolved: ${describe(error)}`,
              );
            }
          }

          // Best effort: the write has already applied, so a failed post-read
          // cannot undo it. Phase 4 fails closed when the post-state is missing,
          // because drift cannot be ruled out without it. A resource that is now
          // absent is a captured post-state, not a missing one.
          let postSnapshot: unknown;
          if (verify !== undefined) {
            try {
              postSnapshot = await observeState(router, verify, extra.signal);
            } catch (error: unknown) {
              warnings.push(
                `post-state could not be captured: ${describe(error)}`,
              );
            }
          }

          journal.markApplied(pending.actionId, {
            result,
            ...(inverse === undefined ? {} : { inverse }),
            ...(verify === undefined ? {} : { verify }),
            ...(postSnapshot === undefined ? {} : { postSnapshot }),
            ...(warnings.length === 0 ? {} : { warning: warnings.join("; ") }),
          });
          return result;
        } catch (error: unknown) {
          if (extra.signal.aborted) {
            journal.markUnknown(pending.actionId, describe(error));
          } else {
            journal.markFailed(pending.actionId, describe(error));
          }
          return rethrow(route.upstream.name, "tools/call", error);
        }
      } finally {
        inflight -= 1;
        if (inflight === 0) {
          for (const resolve of idle.splice(0)) {
            resolve();
          }
        }
      }
    });
  }

  if (capabilities.resources !== undefined) {
    server.setRequestHandler(
      ListResourcesRequestSchema,
      async (_request, extra) => {
        await refreshResources(extra.signal);
        await ensureResources(extra.signal);
        const resources: Passthrough[] = [];
        for (const upstream of router.upstreams) {
          if (!supports(upstream, "resources")) {
            continue;
          }
          const items = await drain(async (cursor) => {
            const raw = await ask(
              upstream,
              {
                method: "resources/list",
                params: cursor === undefined ? {} : { cursor },
              },
              extra.signal,
            );
            const page = ResourceList.parse(raw);
            return { items: page.resources, nextCursor: page.nextCursor };
          });
          resources.push(...items);
        }
        return { resources };
      },
    );

    server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async (_request, extra) => {
        const resourceTemplates: Passthrough[] = [];
        for (const upstream of router.upstreams) {
          if (!supports(upstream, "resources")) {
            continue;
          }
          const items = await drain(async (cursor) => {
            const raw = await ask(
              upstream,
              {
                method: "resources/templates/list",
                params: cursor === undefined ? {} : { cursor },
              },
              extra.signal,
            );
            const page = TemplateList.parse(raw);
            return {
              items: page.resourceTemplates,
              nextCursor: page.nextCursor,
            };
          });
          resourceTemplates.push(...items);
        }
        return { resourceTemplates };
      },
    );

    server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request, extra) => {
        const upstream = await ownerOf(request.params.uri, extra.signal);
        return ask(upstream, request, extra.signal);
      },
    );

    if (capabilities.resources.subscribe === true) {
      for (const schema of [SubscribeRequestSchema, UnsubscribeRequestSchema]) {
        server.setRequestHandler(schema, async (request, extra) => {
          const upstream = await ownerOf(request.params.uri, extra.signal);
          return ask(upstream, request, extra.signal);
        });
      }
    }
  }

  if (capabilities.prompts !== undefined) {
    server.setRequestHandler(
      ListPromptsRequestSchema,
      async (_request, extra) => {
        const prompts: Passthrough[] = [];
        for (const upstream of router.upstreams) {
          if (!supports(upstream, "prompts")) {
            continue;
          }
          const items = await drain(async (cursor) => {
            const raw = await ask(
              upstream,
              {
                method: "prompts/list",
                params: cursor === undefined ? {} : { cursor },
              },
              extra.signal,
            );
            const page = PromptList.parse(raw);
            return { items: page.prompts, nextCursor: page.nextCursor };
          });
          for (const prompt of items) {
            prompts.push({
              ...prompt,
              name: router.expose(upstream.name, prompt.name),
            });
          }
        }
        return { prompts };
      },
    );

    server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      const route = router.route(request.params.name);
      if (route === undefined) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `no configured server provides prompt ${request.params.name}`,
        );
      }
      return ask(
        route.upstream,
        {
          method: "prompts/get",
          params: { ...request.params, name: route.tool },
        },
        extra.signal,
      );
    });
  }

  if (capabilities.completions !== undefined) {
    server.setRequestHandler(CompleteRequestSchema, async (request, extra) => {
      const reference = request.params.ref;
      if (reference.type === "ref/prompt") {
        const route = router.route(reference.name);
        if (route === undefined) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `unknown prompt ${reference.name}`,
          );
        }
        return ask(
          route.upstream,
          {
            method: "completion/complete",
            params: {
              ...request.params,
              ref: { ...reference, name: route.tool },
            },
          },
          extra.signal,
        );
      }
      const upstream = await ownerOf(reference.uri, extra.signal);
      return ask(upstream, request, extra.signal);
    });
  }

  if (capabilities.logging !== undefined) {
    server.setRequestHandler(SetLevelRequestSchema, async (request, extra) => {
      // Broadcast: the client is configuring one logical server.
      for (const upstream of router.upstreams) {
        if (supports(upstream, "logging")) {
          await ask(upstream, request, extra.signal);
        }
      }
      return {};
    });
  }

  // --- lifecycle ----------------------------------------------------------
  let connected = false;
  for (const upstream of router.upstreams) {
    upstream.client.fallbackNotificationHandler = async (
      notification,
    ): Promise<void> => {
      if (notification.method.endsWith("list_changed")) {
        owners = undefined;
        schemes = undefined;
        conflict = undefined;
      }
      if (connected) {
        await server.notification(notification);
      }
    };
  }

  server.oninitialized = (): void => {
    connected = true;
    const name = server.getClientVersion()?.name;
    const id = journal.beginRun(name);
    runId = id;
    labelled = name !== undefined;
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

  return { server: wrapper, ready, whenIdle };
}
