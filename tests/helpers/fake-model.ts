import { createServer, type Server } from "node:http";

/**
 * A model server that does exactly what the test says.
 *
 * The adapters are tested against real HTTP rather than against a mocked
 * client, because everything worth getting wrong in them is on the wire: how
 * an event stream is split across packets, how a tool call is assembled out of
 * fragments, which fields actually left the machine. A stub in front of the
 * SDK would skip all of it and still pass.
 *
 * No network and no key: it listens on a loopback port the OS picks.
 */

export interface Reply {
  /** Written in order, as separate packets, so a test can split an event. */
  readonly sse?: readonly string[];
  /** For testing what a refusal looks like. */
  readonly status?: number;
  readonly body?: string;
}

export interface FakeModel {
  readonly url: string;
  /** Every request body the adapter sent, parsed. */
  readonly sent: Record<string, unknown>[];
  /** Every request path, for checking a client built the URL it meant to. */
  readonly paths: string[];
  close(): Promise<void>;
}

/** Long enough that the kernel does not merge two writes into one read. */
const PACKET_GAP_MS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function fakeModel(
  reply: (body: Record<string, unknown>, path: string) => Reply,
): Promise<FakeModel> {
  const sent: Record<string, unknown>[] = [];
  const paths: string[] = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      paths.push(path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        parsed = {};
      }
      const body = isRecord(parsed) ? parsed : {};
      sent.push(body);

      const answer = reply(body, path);
      if (answer.sse === undefined) {
        response.writeHead(answer.status ?? 500, { "content-type": "application/json" });
        response.end(answer.body ?? "{}");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // One packet per entry, with a real gap between them.
      //
      // The gap is the point, not politeness. Back-to-back writes on loopback
      // are coalesced into a single read on the client, so a test that means
      // to cut an event in half would hand the adapter both halves at once
      // and pass whether or not the adapter buffers across packets. It was
      // doing exactly that before this was a timer.
      const write = (at: number): void => {
        const piece = answer.sse?.[at];
        if (piece === undefined) {
          response.end();
          return;
        }
        response.write(piece, () => {
          setTimeout(() => {
            write(at + 1);
          }, PACKET_GAP_MS);
        });
      };
      write(0);
    });
  });

  await new Promise<void>((settle) => {
    server.listen(0, "127.0.0.1", settle);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fake model never got a port");
  }
  const { port } = address;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    sent,
    paths,
    close: () =>
      new Promise<void>((settle, fail) => {
        server.close((error) => {
          if (error === undefined) settle();
          else fail(error);
        });
      }),
  };
}

/** One Anthropic event, spelled the way the wire spells it. */
export function anthropicEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** One OpenAI-compatible chunk. */
export function openAIEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** One Gemini chunk. */
export function geminiEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\r\n\r\n`;
}
