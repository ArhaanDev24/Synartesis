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
  close(): Promise<void>;
}

export const PROXY_CLIENT_INFO = { name: "synartesis-proxy", version: "0.0.0" } as const;

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
  const chunk: unknown = read.call(stream);
  if (typeof chunk === "string") {
    return chunk;
  }
  return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
}

/** The tail of what a server said, tidied for repeating back in one error. */
function lastWords(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const kept = lines.slice(-4).join("; ");
  return kept === "" ? undefined : kept;
}

export async function connectStdioUpstream(spec: UpstreamSpec): Promise<Upstream> {
  const wanted = spec.stderr ?? "inherit";
  const transport = new StdioClientTransport({
    command: spec.command,
    args: [...(spec.args ?? [])],
    ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
    // "pipe" is what the sdk calls it; captured here so a failure can quote it.
    stderr: wanted === "capture" ? "pipe" : wanted,
  });

  const client = new Client({ ...PROXY_CLIENT_INFO });
  let said = "";
  try {
    await client.connect(transport);
  } catch (error: unknown) {
    // Read after the failure: the stream is only attached once the child is
    // spawned, and by the time connect rejects the server has already spoken.
    said = bufferedText(transport.stderr);
    const reason = lastWords(said);
    throw new UpstreamError(
      spec.name,
      "connect",
      reason === undefined ? error : `${describeError(error)} — the server said: ${reason}`,
    );
  }

  return {
    name: spec.name,
    client,
    close: async (): Promise<void> => {
      await client.close();
    },
  };
}
