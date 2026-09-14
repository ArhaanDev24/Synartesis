import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { UpstreamError } from "../errors.js";

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
