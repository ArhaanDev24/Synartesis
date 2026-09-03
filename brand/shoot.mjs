/**
 * Render an HTML file to a PNG, at an exact size, with a device scale factor.
 *
 * The brand assets are HTML because the type is: Cormorant and IBM Plex Mono
 * from Google Fonts, the meander as a CSS mask. Chrome is the only renderer
 * that agrees with what the site does, so the cards are shot rather than drawn.
 *
 * Same CDP approach as docs/print-pdf.mjs, and for the same reason: Chrome's
 * one-shot --screenshot flag fires on its own schedule, which here is before
 * the webfonts land, so the wordmark comes out in Times. This waits for
 * document.fonts.ready and for the images to decode before it asks.
 *
 *   node brand/shoot.mjs <input.html> <output.png> <width> <height> [scale]
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const READY_TIMEOUT_MS = 60_000;

const [input, output, width, height, scale = "1"] = process.argv.slice(2);
if (!input || !output || !width || !height) {
  console.error("usage: node brand/shoot.mjs <input.html> <output.png> <width> <height> [scale]");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "synartesis-shoot-"));
const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let socket;
const cleanup = () => {
  try { socket?.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);

async function targetUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await res.json()).find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  throw new Error("chrome never opened its debugging port");
}

const pending = new Map();
let nextId = 1;

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const { result } = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.value;
}

async function main() {
  const url = await targetUrl();
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) return;
    const waiting = pending.get(message.id);
    if (waiting === undefined) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: Number(width),
    height: Number(height),
    deviceScaleFactor: Number(scale),
    mobile: false,
  });
  await send("Page.navigate", { url: pathToFileURL(input).href });

  // Webfonts and the mark are both late. Waiting on fonts.ready alone shot the
  // card with the PNG still blank, so both are awaited.
  const started = Date.now();
  for (;;) {
    const ready = await evaluate(
      "(async () => { await document.fonts.ready;" +
        " await Promise.all([...document.images].map(i => i.decode().catch(() => {})));" +
        " return document.fonts.status === 'loaded'; })()",
    );
    if (ready) break;
    if (Date.now() - started > READY_TIMEOUT_MS) {
      throw new Error(`fonts and images were not ready within ${READY_TIMEOUT_MS}ms`);
    }
    await sleep(300);
  }
  // One frame after the fonts land, so the relayout they cause is painted.
  await sleep(400);

  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(output, Buffer.from(data, "base64"));
  console.log(`${output} ${width}x${height}@${scale}x`);
}

main().then(
  () => { cleanup(); process.exit(0); },
  (error) => { console.error(String(error.message ?? error)); cleanup(); process.exit(1); },
);
