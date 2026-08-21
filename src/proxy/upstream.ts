import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { UpstreamError } from "../errors.js";

export interface UpstreamSpec {
  /** Key the manifest uses to qualify this server's tools, e.g. `crm`. */
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Where the server's own stderr goes. The proxy inherits it, so a server
   * that fails to boot says why in the client's logs. The CLI discards it: its
   * output is a report for a person, and a startup failure already surfaces as
   * a typed error rather than as a banner.
   */
  readonly stderr?: "inherit" | "ignore";
}

export interface Upstream {
  readonly name: string;
  readonly client: Client;
  close(): Promise<void>;
}

export const PROXY_CLIENT_INFO = { name: "synartesis-proxy", version: "0.0.0" } as const;

export async function connectStdioUpstream(spec: UpstreamSpec): Promise<Upstream> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: [...(spec.args ?? [])],
    ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
    stderr: spec.stderr ?? "inherit",
  });

  const client = new Client({ ...PROXY_CLIENT_INFO });
  try {
    await client.connect(transport);
  } catch (error: unknown) {
    throw new UpstreamError(spec.name, "connect", error);
  }

  return {
    name: spec.name,
    client,
    close: async (): Promise<void> => {
      await client.close();
    },
  };
}
