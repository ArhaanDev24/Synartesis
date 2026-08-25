import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { ProxyServer } from "./proxy.js";

/**
 * Serving the proxy over HTTP, for clients that will not start a process.
 *
 * ChatGPT's connectors are the reason this exists: they take a remote https
 * endpoint and nothing else, so stdio -- which every other client speaks -- is
 * not an option there.
 *
 * What is served is an undo layer with write access to real systems, so this
 * refuses to run without a token and binds to the loopback interface unless
 * told otherwise. Reaching it from the internet is a tunnel in front of it,
 * deliberately: that is a decision someone should have to make out loud.
 */
export interface HttpOptions {
  readonly port: number;
  readonly host: string;
  readonly token: string;
  /** Seconds a session may sit untouched before it is closed. */
  readonly idleSeconds: number;
  /** A fresh proxy per session, since a run belongs to one client's connection. */
  readonly create: () => ProxyServer;
  readonly log: {
    info: (data: Record<string, unknown>, message: string) => void;
    warn: (message: string) => void;
  };
}

export interface HttpServer {
  readonly port: number;
  close(): Promise<void>;
}


/**
 * Node's request and response, in the shapes the sdk's transport speaks.
 *
 * The node-native transport in this sdk declares onclose as a getter/setter
 * pair typed `(() => void) | undefined`, which an exactOptionalPropertyTypes
 * project cannot accept without an assertion. The web-standard one declares it
 * plainly, so it is used instead and the twenty lines below are the price.
 */
function toRequest(req: IncomingMessage, body: Buffer, origin: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      for (const one of value) {
        headers.append(key, one);
      }
    }
  }
  const method = req.method ?? "GET";
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    // A GET or HEAD may not carry one, and node sends an empty buffer anyway.
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  // Streamed rather than buffered: this is how an SSE reply stays live.
  for await (const chunk of response.body) {
    res.write(Buffer.from(chunk));
  }
  res.end();
}

/** Constant time, so a wrong token cannot be found one character at a time. */
function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "content-type": "application/json",
    // Told the same way twice: the header is what a client acts on, the body
    // is what a person reads in a terminal.
    ...(status === 401 ? { "www-authenticate": 'Bearer realm="synartesis"' } : {}),
  });
  res.end(JSON.stringify({ error: message }));
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    // A cap, because this listens on a socket: an unbounded body is a way to
    // exhaust memory without ever authenticating.
    if (size > 8 * 1024 * 1024) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function isInitialize(body: unknown): boolean {
  const one = (message: unknown): boolean =>
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    message.method === "initialize";
  return Array.isArray(body) ? body.some(one) : one(body);
}

export async function serveHttp(options: HttpOptions): Promise<HttpServer> {
  interface Live {
    readonly transport: WebStandardStreamableHTTPServerTransport;
    readonly proxy: ProxyServer;
    lastSeen: number;
  }
  const sessions = new Map<string, Live>();

  // A client that drops without closing -- a network blip, a connector that
  // gives up -- used to leave its session, and the proxy and upstream handles
  // behind it, in this map for the life of the process. unref'd so an idle
  // server still exits when nothing else is holding it open.
  const sweep = setInterval(() => {
    const deadline = Date.now() - options.idleSeconds * 1000;
    for (const [id, live] of sessions) {
      if (live.lastSeen < deadline) {
        sessions.delete(id);
        options.log.info({ session: id }, "http session swept after going quiet");
        void live.transport.close().catch(() => undefined);
      }
    }
  }, Math.max(1000, (options.idleSeconds * 1000) / 4));
  sweep.unref();

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      try {
        const token = bearer(req);
        if (token === undefined || !tokenMatches(token, options.token)) {
          // Before anything is parsed or routed. An unauthenticated request
          // must not be able to reach the proxy, the journal or an upstream.
          refuse(res, 401, "a bearer token is required");
          return;
        }
        if (req.url !== undefined && !req.url.startsWith("/mcp")) {
          refuse(res, 404, "the endpoint is /mcp");
          return;
        }

        const origin = `http://${options.host}:${String(options.port)}`;
        const raw = await readRaw(req);
        const sessionId = req.headers["mcp-session-id"];
        const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
        if (existing !== undefined) {
          existing.lastSeen = Date.now();
          await writeResponse(res, await existing.transport.handleRequest(toRequest(req, raw, origin)));
          return;
        }

        const body: unknown =
          req.method === "POST" && raw.length > 0 ? JSON.parse(raw.toString("utf8")) : undefined;
        if (req.method !== "POST" || !isInitialize(body)) {
          refuse(res, 400, "no such session; start one with an initialize request");
          return;
        }

        // A session is a connection, and a connection is a run: each one gets
        // its own proxy so its actions are journalled as one story.
        const proxy = options.create();
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            sessions.set(id, { transport, proxy, lastSeen: Date.now() });
            options.log.info({ session: id }, "http session opened");
          },
        });
        await proxy.server.connect(transport);
        transport.onclose = (): void => {
          const id = transport.sessionId;
          if (id !== undefined) {
            sessions.delete(id);
          }
        };
        await writeResponse(res, await transport.handleRequest(toRequest(req, raw, origin)));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          refuse(res, 400, message);
        } else {
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;

  if (options.host !== "127.0.0.1" && options.host !== "localhost") {
    options.log.warn(
      `listening on ${options.host}, which is not loopback: anything that can reach this port and holds the token can write through your servers`,
    );
  }
  options.log.info({ host: options.host, port, endpoint: "/mcp" }, "http proxy ready");

  return {
    port,
    close: async (): Promise<void> => {
      clearInterval(sweep);
      for (const { transport } of sessions.values()) {
        await transport.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
