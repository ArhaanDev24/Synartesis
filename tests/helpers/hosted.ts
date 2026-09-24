import { createToyCrmServer } from "../../fixtures/toy-crm/server.js";
import { ToyCrmStore } from "../../fixtures/toy-crm/store.js";
import { serveHttp, type HttpServer } from "../../src/proxy/http.js";
import type { ProxyServer } from "../../src/proxy/proxy.js";

export interface Hosted {
  readonly url: string;
  readonly store: ToyCrmStore;
  close(): Promise<void>;
}

/**
 * The toy CRM as a hosted server would be: Streamable HTTP on loopback, and a
 * 401 for any request without the bearer token. The same serving code the
 * proxy's own `--http` uses, so the fixture is a pattern already tested.
 */
export async function hostedCrm(token: string, idleSeconds = 60): Promise<Hosted> {
  const store = new ToyCrmStore({ now: () => "2026-01-01T00:00:00.000Z" });
  const server: HttpServer = await serveHttp({
    port: 0,
    host: "127.0.0.1",
    token,
    idleSeconds,
    create: (): ProxyServer => ({
      server: createToyCrmServer(store),
      ready: Promise.resolve("hosted"),
      whenIdle: () => Promise.resolve(),
      runId: undefined,
      busy: () => false,
    }),
    log: { info: () => undefined, warn: () => undefined },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}/mcp`,
    store,
    close: () => server.close(),
  };
}
