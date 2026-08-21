import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { UpstreamError } from "../errors.js";

export interface UpstreamSpec {
  /** Key the manifest uses to qualify this server's tools, e.g. `crm`. */
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
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
    // Inherit the child's stderr so a server that fails to boot says why on
    // our stderr instead of dying silently.
    stderr: "inherit",
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
