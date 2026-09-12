import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Finding the desktop application, and being honest when it is not there.
 *
 * `synartesis desktop` opens the window. It does not install it, and it will
 * not download anything: a command that fetches a binary and runs it is a
 * supply chain, and this package is a few hundred kilobytes of command line
 * tool that people install with `npm i -g`. Carrying Electron through npm
 * would make that a hundred and fifty megabytes for everybody who only ever
 * wanted `synartesis undo`.
 *
 * So this looks in the places an installed application actually lives, opens
 * it if it is there, and otherwise says exactly where to get it. The release
 * is built by `pnpm app:dist` in this repository.
 */

export const RELEASES = "https://github.com/ArhaanDev24/Synartesis/releases";

export interface Found {
  readonly path: string;
  /** How to start it, since an application bundle is not an executable. */
  readonly open: { readonly command: string; readonly args: readonly string[] };
}

/** Every place the installed application might be, for this platform. */
export function candidates(platform: NodeJS.Platform = process.platform): string[] {
  const home = homedir();
  if (platform === "darwin") {
    return [
      "/Applications/Synartesis.app",
      join(home, "Applications/Synartesis.app"),
    ];
  }
  if (platform === "win32") {
    const local = process.env["LOCALAPPDATA"] ?? join(home, "AppData/Local");
    return [
      join(local, "Programs/Synartesis/Synartesis.exe"),
      join(process.env["PROGRAMFILES"] ?? "C:/Program Files", "Synartesis/Synartesis.exe"),
    ];
  }
  return [
    "/opt/Synartesis/synartesis-desktop",
    "/usr/bin/synartesis-desktop",
    join(home, ".local/bin/synartesis-desktop"),
    join(home, "Applications/Synartesis.AppImage"),
  ];
}

export function findDesktop(
  platform: NodeJS.Platform = process.platform,
  here: (path: string) => boolean = existsSync,
): Found | undefined {
  for (const path of candidates(platform)) {
    if (!here(path)) {
      continue;
    }
    if (platform === "darwin") {
      // `open` rather than the binary inside: it hands the application to the
      // window server properly, so it gets a dock icon and survives this
      // terminal closing.
      return { path, open: { command: "open", args: ["-a", path] } };
    }
    return { path, open: { command: path, args: [] } };
  }
  return undefined;
}

/** What to print when it is not installed. Written once so both callers agree. */
export function whereToGetIt(platform: NodeJS.Platform = process.platform): string {
  const asset =
    platform === "darwin"
      ? "the .dmg for your chip (Apple silicon or Intel)"
      : platform === "win32"
        ? "the Windows installer"
        : "the AppImage or .deb";
  return [
    "The Synartesis desktop application is not installed.",
    "",
    `Download ${asset} from:`,
    `  ${RELEASES}`,
    "",
    "It is a separate download on purpose. Shipping it through npm would mean",
    "every install of this command line tool pulled a browser engine with it.",
    "",
    "The journal is shared either way: something the window does is undoable",
    "here with `synartesis undo`, and the other way round.",
  ].join("\n");
}
