/**
 * A model that does what the script says, so the window can be worked on.
 *
 * Speaks the OpenAI-compatible wire format, which is the one the app's most
 * general adapter uses -- so nothing about the window knows it is not talking
 * to Ollama. It costs nothing, needs no key, reaches no network, and does the
 * same thing every time, which is what you want when the thing being changed
 * is the drawing rather than the model.
 *
 *   node app/dev/stand-in.mjs [port]
 *
 * Edit SCRIPT below to make it do something else. The tool names are the
 * qualified ones the proxy advertises -- `fs__write_file`, not `write_file` --
 * because this app always fronts more than one server.
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 11888);
const FILE = process.env.SANDBOX_FILE ?? "/tmp/report.txt";

/** One entry per turn. `calls` are made, then the next turn is used. */
const SCRIPT = [
  {
    say: "Let me look at the report and zero the north row.",
    calls: [
      {
        name: "fs__write_file",
        args: { path: FILE, content: "Region   Revenue\nNorth    0\nSouth    288,400\n" },
      },
    ],
  },
  {
    say:
      "Done — report.txt now reads North 0. The old contents were captured first, " +
      "so say “put that back” whenever you like.",
    calls: [],
  },
  // Creating a file has no prior state to restore and this server cannot
  // delete, so the policy holds it. Ask a second time to see an approval.
  {
    say: "I will start a summary file for it.",
    calls: [
      {
        name: "fs__write_file",
        args: { path: FILE.replace("report.txt", "summary.md"), content: "# Summary\n\nNorth is zero.\n" },
      },
    ],
  },
  { say: "That one is waiting for you — it cannot be undone, so you decide.", calls: [] },
];

let turn = 0;
const sse = (frame) => `data: ${JSON.stringify(frame)}\n\n`;
const wait = (ms) => new Promise((settle) => setTimeout(settle, ms));

const handler = (request, response) => {
  request.on("data", () => undefined);
  request.on("end", async () => {
    const step = SCRIPT[Math.min(turn, SCRIPT.length - 1)];
    turn += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });

    // A word at a time, so streaming and the working animation are visible.
    for (const word of step.say.split(" ")) {
      response.write(sse({ choices: [{ index: 0, delta: { content: `${word} ` } }] }));
      await wait(45);
    }
    if (step.calls.length > 0) {
      response.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: step.calls.map((call, at) => ({
                  index: at,
                  id: `call_${String(turn)}_${String(at)}`,
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              },
            },
          ],
        }),
      );
    }
    response.write("data: [DONE]\n\n");
    response.end();
  });
};

const server = createServer(handler);

/**
 * Refuse to start if something else already has the port.
 *
 * Without this the listen fails, the window carries on, and it quietly talks
 * to whatever was there instead -- a stale server from another session, which
 * answers plausibly and makes the app look broken in a way that has nothing to
 * do with the app. That happened; this is why the check is here.
 */
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `\n  Port ${String(PORT)} is already taken, so this did not start.\n` +
        `  Something else would answer the window instead of this script.\n` +
        `  Find it with: lsof -i:${String(PORT)}\n`,
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stand-in model on http://127.0.0.1:${String(PORT)}/v1`);
});
