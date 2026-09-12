/**
 * Render `icon.html` to an .icns.
 *
 * Uses the Electron already installed here rather than a drawing library: it
 * is the same renderer that draws the window, so what the icon looks like and
 * what the mark looks like cannot drift apart. Run with `pnpm app:icon`.
 *
 * Everything hangs off `whenReady().then` rather than a top-level await. A
 * top-level await in an Electron main module runs while module evaluation is
 * still blocking the loop, and `ready` never arrives -- the script does not
 * fail, it simply waits for ever.
 */
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const iconset = join(here, "icon.iconset");

/** The ten sizes iconutil expects, under the names it expects. */
const SIZES = [
  [16, "icon_16x16.png"], [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"], [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"], [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"], [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"], [1024, "icon_512x512@2x.png"],
];

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
  });
  await window.loadFile(join(here, "icon.html"));
  await new Promise((settle) => setTimeout(settle, 500));
  const shot = await window.webContents.capturePage();

  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const master = join(here, "icon.png");
  writeFileSync(master, shot.toPNG());
  for (const [size, name] of SIZES) {
    execFileSync("sips", ["-z", String(size), String(size), master, "--out", join(iconset, name)],
      { stdio: "ignore" });
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(here, "icon.icns")]);
  rmSync(iconset, { recursive: true, force: true });
  console.log("icon.icns and icon.png written");
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
