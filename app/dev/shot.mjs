/**
 * Photograph the running window, and optionally drive it first.
 *
 *   pnpm app:sandbox -- --remote-debugging-port=9222
 *   node app/dev/shot.mjs out.png
 *   node app/dev/shot.mjs out.png "zero out the north revenue" 6000
 *   node app/dev/shot.mjs out.png --click .picker
 *
 * Over the devtools protocol, so nothing about taking a picture has to live
 * in the product. Worth using: a change to the window is not finished until
 * somebody has looked at it, and looking at it is cheaper than guessing.
 */
import { writeFileSync } from "node:fs";

const [out, what, held] = process.argv.slice(2);
const port = process.env.PORT ?? "9222";

let pages = [];
for (let tries = 0; tries < 60; tries += 1) {
  try {
    const found = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    pages = found.filter((one) => one.type === "page" && one.webSocketDebuggerUrl);
    if (pages.length > 0) break;
  } catch {
    // Not up yet.
  }
  await new Promise((settle) => setTimeout(settle, 500));
}
if (pages.length === 0) {
  console.error(`nothing listening on ${port}; start the sandbox with --remote-debugging-port=${port}`);
  process.exit(1);
}

const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((settle) => socket.addEventListener("open", settle, { once: true }));
let next = 1;
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = next++;
    const hear = (event) => {
      const message = JSON.parse(event.data);
      if (message.id === id) {
        socket.removeEventListener("message", hear);
        resolve(message.result);
      }
    };
    socket.addEventListener("message", hear);
    socket.send(JSON.stringify({ id, method, params }));
  });
const wait = (ms) => new Promise((settle) => setTimeout(settle, ms));

/** Click something by selector, the way a person would. */
async function click(selector) {
  const box = await send("Runtime.evaluate", {
    expression: `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return "";const r=e.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()`,
    returnByValue: true,
  });
  if (box.result.value === "") throw new Error(`no ${selector}`);
  const { x, y } = JSON.parse(box.result.value);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

await wait(3000);
if (what === "--click") {
  await click(held);
  await wait(600);
} else if (what !== undefined) {
  await click("textarea");
  await send("Input.insertText", { text: what });
  await wait(200);
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }
  await wait(Number(held ?? 6000));
}

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(`wrote ${out}`);
process.exit(0);
