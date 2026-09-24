import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { UpstreamError } from "../errors.js";
import { isRemote, type RemoteServerSpec, type ServerSpec } from "../manifest/types.js";
import { expandReferences, upstreamEnv, type EnvSource } from "./environment.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface UpstreamSpec {
  /** Key the manifest uses to qualify this server's tools, e.g. `crm`. */
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The directory the server starts in. `install` copies a client entry's
   * `cwd` onto the wrapped entry, and a server started with `.` in its args or
   * scoped to a project reads that directory -- so an undo started from
   * wherever the person happened to be standing could point a server at a
   * different root from the one the session wrote to.
   */
  readonly cwd?: string;
  /**
   * Where the server's own stderr goes. The proxy inherits it, so a server
   * that fails to boot says why in the client's logs. The CLI captures it, so
   * that reason can be repeated back in the error rather than shown as a
   * banner: a report for a person should not be interleaved with a server's
   * own logging, but it must not throw away the one line that explains the
   * failure either.
   */
  readonly stderr?: "inherit" | "ignore" | "capture";
}

export interface Upstream {
  readonly name: string;
  readonly client: Client;
  /**
   * Start the server again after its transport has died. A single oversized
   * response is enough to close a stdio connection, and without this the
   * proxy stayed connected to nothing for the rest of the session: every call
   * after it failed with "Not connected", whatever it was.
   *
   * Absent on an upstream that was not spawned from a command, which has
   * nothing to respawn.
   */
  reconnect?(): Promise<void>;
  /**
   * What a failed request says about whether it reached the tool, where the
   * transport can tell. The proxy's own reading of failures was written for a
   * process on a pipe; over HTTP an expired token arrives as a 401, and read
   * as "outcome unknown" it would leave a row that blocks undoing the whole
   * session, for a call the server refused at the door.
   *
   * "not-sent": refused before any handler ran. "lost": the session is gone,
   * which also means not handled, and a new one is needed. Anything else is
   * left to the ordinary reading, which treats it as unknown.
   */
  classify?(error: unknown): "not-sent" | "lost" | undefined;
  close(): Promise<void>;
}

export const PROXY_CLIENT_INFO = { name: "synartesis-proxy", version: "0.0.0" } as const;

/**
 * How much of a failing server's complaint to hold on to. Generous enough for
 * any real message and bounded so a server stuck in a logging loop cannot make
 * the proxy the thing that runs out of memory.
 */
const STDERR_KEPT = 256 * 1024;

/** Long enough for a stream already at its end, short enough not to be felt. */
const STDERR_SETTLE_MS = 200;

interface Readable {
  on(event: "data" | "end" | "close", listener: (chunk?: Buffer | string) => void): unknown;
  readonly readableEnded?: boolean;
}

/**
 * Give a stream a moment to finish before quoting it.
 *
 * The child has exited by the time connect rejects -- that is what rejected it
 * -- but `data` is delivered asynchronously, so its last words can still be in
 * flight. Without this the message quoted back was whatever had arrived, which
 * for a server that says a lot is its banner rather than its complaint.
 */
function settled(stream: Readable, ms: number): Promise<void> {
  if (stream.readableEnded === true) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    // Unref where available: a diagnostic must never hold the process open.
    (timer as { unref?: () => void }).unref?.();
    // `end` only. It fires after every chunk has been delivered, which is the
    // whole point of waiting; `close` can arrive first and leave the last of
    // what the server said undelivered -- which made this intermittent, and a
    // diagnostic that is right most times is worse than one that is plainly
    // limited. The timeout is the backstop for a stream destroyed without
    // ending.
    stream.on("end", done);
  });
}

/** The sdk types stderr as Stream, which has no on(); what it hands back does. */
function isReadable(stream: unknown): stream is Readable {
  return (
    typeof stream === "object" &&
    stream !== null &&
    "on" in stream &&
    typeof stream.on === "function"
  );
}

/**
 * Whatever a stream has buffered, without asserting it into a shape. The sdk
 * types stderr as Stream, which has no read(); what it hands back is a
 * Readable, and a wrong guess here would be a crash while reporting a crash.
 */
function bufferedText(stream: unknown): string {
  if (typeof stream !== "object" || stream === null || !("read" in stream)) {
    return "";
  }
  const read: unknown = stream.read;
  if (typeof read !== "function") {
    return "";
  }
  // Drained rather than read once. A single read() returns one chunk, which is
  // the whole of a short crash but not of a server that says a lot before it
  // fails -- and the sentence naming the fault can be anywhere in it. Reading
  // once was not what dropped the missing-module line (a mis-written regexp
  // was); this is here so a noisier server cannot drop it either.
  let text = "";
  for (;;) {
    const chunk: unknown = read.call(stream);
    if (typeof chunk === "string") {
      text += chunk;
    } else if (Buffer.isBuffer(chunk)) {
      text += chunk.toString("utf8");
    } else {
      // null when drained; anything else is a shape we should not keep pulling.
      break;
    }
  }
  return text;
}

/**
 * A line that states a fault rather than decorating one. Deliberately narrow:
 * anything broader starts matching a server's ordinary banner.
 */
const NAMES_A_FAULT =
  /^(?:[A-Za-z]*(?:Error|Exception)\b|Cannot find |ENOENT\b|EACCES\b|EADDRINUSE\b|.*: command not found)/;

/**
 * What a server said before it died, reduced to the part that answers the
 * question.
 *
 * The tail is the right choice for a server that prints one clear message and
 * stops. It is exactly wrong for a runtime that crashes, and that is the
 * commonest way to get here: node puts `Error: Cannot find module '/path'` in
 * the middle of its output and ends with `code: 'MODULE_NOT_FOUND'`,
 * `requireStack: []`, a closing brace and its own version number. So the tail
 * was four lines of ceremony, and the path -- the whole answer, and the only
 * thing that tells somebody their manifest points at a file that is not there
 * -- was thrown away. Reported for weeks as "MODULE_NOT_FOUND" with nothing to
 * act on.
 */
function lastWords(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    // A stack frame says where a failure surfaced, never what it was.
    .filter((line) => line !== "" && !/^at\s/.test(line));

  const named = lines.find((line) => NAMES_A_FAULT.test(line));
  if (named !== undefined) {
    return named;
  }
  const kept = lines.slice(-4).join("; ");
  return kept === "" ? undefined : kept;
}

/**
 * Start a server named in the policy, with the environment it should have.
 *
 * The one way in. There were six places that started a server, each copying
 * `command`, `args` and the manifest's `env` by hand, and none of them could
 * give a server anything the client had configured -- which is how wrapping a
 * server came to drop its API key. They all come through here now, and say
 * where the environment comes from rather than each deciding.
 */
export async function connectUpstream(
  name: string,
  spec: ServerSpec,
  options: {
    readonly env: EnvSource;
    readonly stderr?: UpstreamSpec["stderr"];
    readonly cwd?: string;
  },
): Promise<Upstream> {
  const env = upstreamEnv(name, spec, options.env);
  if (isRemote(spec)) {
    return await connectRemoteUpstream(name, spec, (variable) => env?.[variable] ?? process.env[variable]);
  }
  return await connectStdioUpstream({
    name,
    command: spec.command,
    args: spec.args,
    ...(env === undefined ? {} : { env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
  });
}

export async function connectStdioUpstream(spec: UpstreamSpec): Promise<Upstream> {
  const started = await start(spec);
  let current = started;
  return {
    name: spec.name,
    get client(): Client {
      return current.client;
    },
    async reconnect(): Promise<void> {
      // Best effort: the old one is already broken, and failing to close a
      // broken thing must not stop the new one being made.
      await current.client.close().catch(() => undefined);
      current = await start(spec);
    },
    close: async (): Promise<void> => {
      await current.client.close();
    },
  };
}

async function start(spec: UpstreamSpec): Promise<{ client: Client }> {
  const wanted = spec.stderr ?? "inherit";
  const transport = new StdioClientTransport({
    command: spec.command,
    args: [...(spec.args ?? [])],
    ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    // "pipe" is what the sdk calls it; captured here so a failure can quote it.
    stderr: wanted === "capture" ? "pipe" : wanted,
  });

  const client = new Client({ ...PROXY_CLIENT_INFO });

  // Read as it arrives, not after the failure. A pipe nobody reads fills at
  // around 64kB and then blocks the writer, so a server that says more than
  // that before dying never exits, connect never rejects, and `check` hangs
  // for ever with no output. Draining it as it comes also means the sentence
  // naming the fault is still there however much follows it.
  let said = "";
  const stderr = transport.stderr;
  const listening = isReadable(stderr);
  if (listening) {
    stderr.on("data", (chunk?: Buffer | string) => {
      if (chunk !== undefined && said.length < STDERR_KEPT) {
        said += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      }
    });
  }

  try {
    await client.connect(transport);
  } catch (error: unknown) {
    if (listening) {
      await settled(stderr, STDERR_SETTLE_MS);
    }
    // Plus whatever never reached the listener at all: on a failure fast
    // enough to beat it, the stream is still paused and holds the lot.
    const reason = lastWords(said === "" ? bufferedText(transport.stderr) : said);
    throw new UpstreamError(
      spec.name,
      "connect",
      reason === undefined ? error : `${describeError(error)} — the server said: ${reason}`,
    );
  }

  return { client };
}

/**
 * A hosted server, over Streamable HTTP or the older SSE transport.
 *
 * Headers are filled in here, from the same environment a local server would
 * be given, so the policy holds `${GITHUB_TOKEN}` and never the token.
 *
 * Redirects are refused. A redirect to another origin drops Authorization
 * but not a custom header like X-API-Key, so following one could hand a key
 * to whoever the first server pointed at.
 */
export async function connectRemoteUpstream(
  name: string,
  spec: RemoteServerSpec,
  lookup: (name: string) => string | undefined,
): Promise<Upstream> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.headers ?? {})) {
    headers[key] = expandReferences(name, key, value, lookup);
  }
  const url = new URL(spec.url);
  const requestInit: RequestInit = { headers, redirect: "error" };
  const open = async (kind: "http" | "sse"): Promise<Client> => {
    const client = new Client({ ...PROXY_CLIENT_INFO });
    if (kind === "http") {
      // The class types sessionId as string | undefined, the interface as an
      // optional string, and exactOptionalPropertyTypes reads those as
      // different. They are the same at run time; the SDK's own tests connect
      // it exactly like this.
      // @ts-expect-error -- see above: an SDK typing gap, not a runtime one.
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
    } else {
      // Deprecated, and still what some hosted servers speak; the SDK's own
      // note says clients may need both during the migration.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      await client.connect(new SSEClientTransport(url, { requestInit }));
    }
    return client;
  };

  // Which transport answers is settled once, on the first connect. The SSE
  // fallback is taken only where the server said it does not speak the newer
  // one -- never on a 401 or 403, which would hide the real problem and send
  // the token a second time to find out the same thing.
  let kind: "http" | "sse" = spec.transport === "sse" ? "sse" : "http";
  let current: Client;
  try {
    current = await open(kind);
  } catch (error: unknown) {
    const code = statusOf(error);
    if (spec.transport === "auto" && (code === 400 || code === 404 || code === 405)) {
      kind = "sse";
      try {
        current = await open(kind);
      } catch (fallback: unknown) {
        throw new UpstreamError(name, "connect", fallback);
      }
    } else {
      throw new UpstreamError(name, "connect", refusal(error) ?? error);
    }
  }

  return {
    name,
    get client(): Client {
      return current;
    },
    async reconnect(): Promise<void> {
      await current.close().catch(() => undefined);
      current = await open(kind);
    },
    classify(error: unknown): "not-sent" | "lost" | undefined {
      const code = statusOf(error);
      if (code === undefined || code < 400 || code >= 500) {
        return undefined;
      }
      // A session the server no longer knows. The request was not handled;
      // the next one needs a new session.
      return code === 404 ? "lost" : "not-sent";
    },
    close: async (): Promise<void> => {
      await current.close();
    },
  };
}

/** The HTTP status a transport failed with, when it failed with one. */
function statusOf(error: unknown): number | undefined {
  if (error instanceof StreamableHTTPError || error instanceof SseError) {
    return typeof error.code === "number" && error.code > 0 ? error.code : undefined;
  }
  return undefined;
}

/** A refusal at the door, in words, rather than the transport's own. */
function refusal(error: unknown): string | undefined {
  const code = statusOf(error);
  if (code === 401 || code === 403) {
    return `the server refused the credentials it was given (HTTP ${String(code)}); check the token its headers name`;
  }
  return undefined;
}

export interface Started<T> {
  /** In the order they were asked for, not the order they answered. */
  readonly started: readonly Upstream[];
  readonly failed: readonly { readonly item: T; readonly error: unknown }[];
}

/**
 * Starts several servers at once rather than one after another.
 *
 * Every place that starts more than one server waited for each before
 * beginning the next, so three npx servers cost the sum of their start-ups --
 * each of which can be seconds while npx resolves a package -- instead of the
 * slowest. The order of what is returned is the order asked for, so routing
 * and reports do not change with which server happened to be quickest.
 */
export async function startTogether<T>(
  items: readonly T[],
  start: (item: T) => Promise<Upstream>,
): Promise<Started<T>> {
  const settled = await Promise.allSettled(
    items.map(async (item) => ({ item, upstream: await start(item) })),
  );
  const started: Upstream[] = [];
  const failed: { item: T; error: unknown }[] = [];
  items.forEach((item, index) => {
    const result = settled[index];
    if (result?.status === "fulfilled") {
      started.push(result.value.upstream);
    } else if (result !== undefined) {
      failed.push({ item, error: result.reason });
    }
  });
  return { started, failed };
}

/**
 * All of them, or none: a failure closes whatever did start, then throws the
 * first failure in the order asked for, as starting them one by one would.
 */
export async function startAll<T>(
  items: readonly T[],
  start: (item: T) => Promise<Upstream>,
): Promise<readonly Upstream[]> {
  const { started, failed } = await startTogether(items, start);
  const first = failed[0];
  if (first !== undefined) {
    await Promise.all(started.map((upstream) => upstream.close().catch(() => undefined)));
    throw first.error;
  }
  return started;
}
