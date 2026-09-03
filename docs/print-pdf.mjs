/**
 * Print a Paged.js document to PDF, after it has actually finished paginating.
 *
 * Chrome's --print-to-pdf flag snapshots on its own schedule, which for this
 * document is somewhere around page two. --virtual-time-budget makes it worse
 * rather than better: virtual time races ahead of the real layout work Paged.js
 * is doing, so a bigger budget snapshots earlier.
 *
 * So this drives Chrome over the DevTools protocol instead and waits for a
 * signal the document itself raises. Paged.js calls window.PagedConfig.after
 * when pagination is complete; the page sets a data attribute there, and this
 * polls for it before asking for the PDF. Node 22 has a global WebSocket, so
 * there is no dependency to install.
 *
 *   node docs/print-pdf.mjs <input.html> <output.pdf>
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const PAGINATION_TIMEOUT_MS = 120_000;

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node print-pdf.mjs <input.html> <output.pdf>");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "synartesis-print-"));
const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
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

/** Chrome needs a moment before its debugging port answers. */
async function targetUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
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
  await send("Page.navigate", { url: pathToFileURL(input).href });

  // Wait for the document to say it is paginated, not for a guess at how long
  // that takes. Reported page count comes back with it, so a silent zero-page
  // render is a failure here rather than a surprise in the PDF.
  const started = Date.now();
  let pages = 0;
  for (;;) {
    // Paged.js documents report their own page boxes; a document that
    // paginates natively (one slide, one @page) has none, so it declares the
    // count itself. Either way a zero here is still a failure rather than a
    // surprise in the PDF.
    pages =
      (await evaluate(
        "document.querySelectorAll('.pagedjs_page').length" +
          " || Number(document.documentElement.dataset.pages) || 0",
      )) ?? 0;
    const done = await evaluate("document.documentElement.dataset.pagedDone === '1'");
    if (done && pages > 0) break;
    if (Date.now() - started > PAGINATION_TIMEOUT_MS) {
      throw new Error(`pagination did not finish within ${PAGINATION_TIMEOUT_MS}ms (saw ${pages} pages)`);
    }
    await sleep(400);
  }

  const { data } = await send("Page.printToPDF", {
    printBackground: true,
    preferCSSPageSize: true,
    marginTop: 0,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
  });

  writeFileSync(output, Buffer.from(data, "base64"));
  console.log(`${pages} pages`);
}

main().then(
  () => { cleanup(); process.exit(0); },
  (error) => { console.error(String(error.message ?? error)); cleanup(); process.exit(1); },
);
