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

import { SnapshotError, UpstreamError, describe } from "../errors.js";
import { createRetryGate, type Gate } from "../gate/gate.js";
import { shouldGateOnWrite } from "../gate/heuristic.js";
import type { Journal } from "../journal/journal.js";
import type { Logger } from "../logging.js";
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
  /** Defaults to out-of-band approval through the journal. */
  readonly gate?: Gate;
  readonly gateTimeoutMs?: number;
  readonly logger?: Logger;
}

export interface ProxyServer {
  readonly server: McpServer;
  /** Resolves with the run id once the client session is initialized. */
  readonly ready: Promise<string>;
  /** Resolves when no tool call is in flight, so shutdown can drain first. */
  whenIdle(): Promise<void>;
  /** The open run, once the session has initialized. */
  readonly runId: string | undefined;
  /** Whether any forwarded request is currently in flight. */
  busy(): boolean;
}

type Passthrough = { [key: string]: unknown };

/**
 * How long an approval stays usable. Long enough to survive a client restart
 * and a person walking away from their desk, short enough that a decision made
 * this morning cannot quietly authorise the same call tomorrow.
 */
const APPROVAL_WINDOW_MS = 60 * 60 * 1000;

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

/**
 * Told to the agent at connect time. Without it a gated call is just an opaque
 * failure, and the person watching has no idea why their agent stopped or what
 * they are supposed to do about it. With it, the agent explains itself.
 */
const SYNARTESIS_INSTRUCTIONS = [
  "These tools are guarded by Synartesis, which records every change so it can be undone later.",
  "",
  "Some actions cannot be undone. Those are held until a person approves them, and the call",
  "will fail with a message beginning \"Synartesis is holding this call for approval\".",
  "When that happens:",
  "  1. Tell the user plainly that you are asking Synartesis for approval, and what for.",
  "  2. Give them the exact `synartesis approve ...` command from the error.",
  "  3. Once they say they have approved it, make the same call again. It will go through.",
  "Do not try to work around a held call by using a different tool to achieve the same thing.",
].join("\n");

function instructionsFor(router: Router): string {
  const sections = router.upstreams
    .map((upstream) => ({
      name: upstream.name,
      text: upstream.client.getInstructions(),
    }))
    .filter(
      (section): section is { name: string; text: string } => section.text !== undefined,
    );

  const upstream = router.prefixed
    ? sections.map((section) => `Tools prefixed ${section.name}__:\n${section.text}`).join("\n\n")
    : (sections[0]?.text ?? "");

  return upstream === "" ? SYNARTESIS_INSTRUCTIONS : `${SYNARTESIS_INSTRUCTIONS}\n\n${upstream}`;
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

  const log = options.logger;

  const gate = options.gate ?? createRetryGate(journal);

  const capabilities = mergeCapabilities(
    upstreams.map((upstream) => upstream.client.getServerCapabilities() ?? {}),
  );
  const instructions = instructionsFor(router);

  const wrapper = new McpServer(identityFor(router), { capabilities, instructions });
  const server = wrapper.server;

  let runId: string | undefined;
  let resolveReady: (id: string) => void = () => undefined;
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });

  let inflight = 0;
  const idle: (() => void)[] = [];
  const leave = (): void => {
    inflight -= 1;
    if (inflight === 0) {
      for (const resolve of idle.splice(0)) {
        resolve();
      }
    }
  };
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
      // Captured: narrowing does not survive into the closures below.
      const activeRun = runId;
      ensureLabel();
      const route = router.route(request.params.name);
      if (route === undefined) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `no configured server provides tool ${request.params.name}`,
        );
      }

      const { policy } = policies.resolve(qualify(route.upstream.name, route.tool));
      const args = request.params.arguments ?? {};
      // Counted from here, not from the forward call: the pre-read is part of
      // the action, and a shutdown that aborts it blocks a legitimate write.
      inflight += 1;
      try {
        const wantsGate =
          policy.gate === "always" || (policy.gate === "on_write" && shouldGateOnWrite(args));

        // A retry after an out-of-band approval reuses the row that was
        // approved, so the approval ends up on the action that actually ran
        // rather than on an abandoned twin of it.
        const granted = wantsGate
          ? journal.findApproval({
              server: route.upstream.name,
              tool: route.tool,
              args,
              notBefore: new Date(Date.now() - APPROVAL_WINDOW_MS).toISOString(),
            })
          : undefined;

        // An approval granted in an earlier session cannot simply be adopted:
        // the action belongs to the run happening now, or undoing this run
        // would not include it.
        const inherited =
          granted !== undefined && granted.runId !== activeRun ? granted : undefined;

        const pending =
          granted === undefined || inherited !== undefined
            ? journal.recordPending({
                runId: activeRun,
                server: route.upstream.name,
                tool: route.tool,
                args,
                class: policy.class,
              })
            : {
                actionId: granted.id,
                seq: granted.seq,
                idempotencyKey: granted.idempotencyKey,
              };

        if (inherited !== undefined) {
          journal.adoptApproval(pending.actionId, inherited);
        }
        if (granted !== undefined) {
          log?.info(
            { action: pending.actionId, by: granted.approvedBy, from: granted.runId },
            "proceeding on a standing approval",
          );
        }

        const decide = async (why: string): Promise<void> => {
          // Parked, not working: a suspended call must not hold up shutdown,
          // and the drain exists to let real work finish.
          inflight -= 1;
          let decision;
          try {
            decision = await gate.decide({
              actionId: pending.actionId,
              runId: activeRun,
              seq: pending.seq,
              server: route.upstream.name,
              tool: route.tool,
              args,
              signal: extra.signal,
            });
          } finally {
            inflight += 1;
          }
          log?.info(
            { action: pending.actionId, approved: decision.approved },
            decision.approved ? "approved" : "denied",
          );
          // An approval that lands after the client has given up would send
          // a real email that the agent has already reported as not sent.
          // Nobody is waiting for the result, so the safe reading of an
          // approval nobody can hear is that it did not happen.
          if (decision.approved && extra.signal.aborted) {
            journal.settleAsDenied(
              pending.actionId,
              decision.by,
              "approved, but the client had already stopped waiting, so it was not sent",
            );
            throw new McpError(
              ErrorCode.InvalidRequest,
              `synartesis blocked ${request.params.name}: it was approved after the client stopped waiting, so it was not sent. Ask the agent to try again.`,
            );
          }
          if (!decision.approved) {
            if (decision.awaiting === true) {
              log?.warn(
                {
                  action: pending.actionId,
                  tool: `${route.upstream.name}.${route.tool}`,
                  approve: `synartesis approve ${pending.actionId}`,
                },
                "awaiting approval",
              );
              throw new McpError(
                ErrorCode.InvalidRequest,
                `Synartesis is holding this call for approval, because ${why}. ${decision.reason}`,
              );
            }
            const who = decision.by === undefined ? "" : ` by ${decision.by}`;
            throw new McpError(
              ErrorCode.InvalidRequest,
              `synartesis blocked ${request.params.name}: ${why} and was denied${who}. ${decision.reason}`,
            );
          }
        };

        // D4/3.4: a policy gate suspends before anything is read or written, so
        // a gated action never even looks at the resource.
        // decide() throws on refusal, so getting past this means approved.
        const askedAlready = wantsGate;
        if (wantsGate && granted === undefined) {
          await decide("this action cannot be undone");
        }

        // The pre-read happens before the write goes out, and a failure stops
        // the write entirely: a reversible action without a snapshot is
        // silently irreversible, which is worse than the action not happening.
        let snapshot: unknown;
        let verify: ResolvedRead | undefined;
        let missingPriorState: string | undefined;
        if (policy.snapshot !== undefined) {
          try {
            verify = planRead(policy.snapshot, { args });
            snapshot = await runRead(router, verify, extra.signal);
            journal.attachSnapshot(pending.actionId, snapshot);
          } catch (error: unknown) {
            const reason = describe(error);
            if (error instanceof SnapshotError && error.absent) {
              // Nothing exists here yet, so this call creates rather than
              // replaces and there is nothing to put back. It is an
              // irreversible action wearing a reversible policy. Refusing
              // outright would mean an agent could never create anything, so
              // it falls through to the same question the gate asks.
              missingPriorState = reason;
              verify = undefined;
            } else {
              journal.markFailed(pending.actionId, reason);
              log?.error(
                { seq: pending.seq, tool: route.tool, reason },
                "write blocked: snapshot failed",
              );
              throw new McpError(
                ErrorCode.InternalError,
                `synartesis blocked ${request.params.name}: ${reason}`,
              );
            }
          }
        }

        if (missingPriorState !== undefined && !askedAlready) {
          await decide("nothing exists here to restore, so this cannot be undone");
        }

        const forwarded: Request = {
          method: "tools/call",
          params: { ...request.params, name: route.tool },
        };

        try {
          const result = await route.upstream.client.request(forwarded, PassthroughResult, {
            signal: extra.signal,
          });

          const context = { args, snapshot, result: toPayload(result) };
          const warnings: string[] = [];
          if (missingPriorState !== undefined) {
            warnings.push(
              `no prior state existed, so there is nothing to restore: ${missingPriorState}`,
            );
          }

          // Resolved now rather than at rollback time (D5).
          let inverse: unknown;
          if (policy.inverse !== undefined && missingPriorState === undefined) {
            try {
              inverse = planInverse(policy.inverse, context);
            } catch (error: unknown) {
              warnings.push(`inverse could not be resolved: ${describe(error)}`);
            }
          }

          // Best effort: the write has already applied, so a failed post-read
          // cannot undo it. Phase 4 fails closed when the post-state is
          // missing. A resource that is now absent is a captured post-state,
          // not a missing one.
          let postSnapshot: unknown;
          if (verify !== undefined) {
            try {
              postSnapshot = await observeState(router, verify, extra.signal);
            } catch (error: unknown) {
              warnings.push(`post-state could not be captured: ${describe(error)}`);
            }
          }

          if (warnings.length > 0) {
            log?.warn({ seq: pending.seq, tool: route.tool, warnings }, "applied with reservations");
          }
          log?.debug(
            { seq: pending.seq, server: route.upstream.name, tool: route.tool, class: policy.class },
            "applied",
          );
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
        leave();
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

  return {
    server: wrapper,
    ready,
    whenIdle,
    busy: (): boolean => inflight > 0,
    get runId(): string | undefined {
      return runId;
    },
  };
}
