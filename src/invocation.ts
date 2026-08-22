import { accessSync, constants } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How to invoke this CLI, as the reader would have to type it.
 *
 * Printing `synartesis approve ...` is only useful advice if that command
 * exists. Until someone installs it globally it does not, and telling a person
 * to run something that is not there is worse than saying nothing.
 */
function onPath(command: string): boolean {
  const dirs = (process.env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  return dirs.some((dir) => {
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

let cached: string | undefined;

export function cliCommand(): string {
  if (cached !== undefined) {
    return cached;
  }

  // Installed globally: the shim is a file named for the command itself.
  const invokedAs = process.argv[1];
  if (invokedAs !== undefined && basename(invokedAs) === "synartesis") {
    cached = "synartesis";
    return cached;
  }
  if (onPath("synartesis")) {
    cached = "synartesis";
    return cached;
  }

  // Run straight out of a checkout. Spell out what actually works.
  cached = `node ${invokedAs ?? "dist/cli.js"}`;
  return cached;
}

/**
 * The same, worked out from inside the proxy, which lives beside the cli in
 * whatever directory the build put them.
 */
export function cliCommandFrom(moduleUrl: string): string {
  if (onPath("synartesis")) {
    return "synartesis";
  }
  return `node ${fileURLToPath(new URL("cli.js", moduleUrl))}`;
}

/**
 * How to start the proxy, as the reader would have to type it.
 *
 * Not the cli command with a flag on the end. `synartesis --manifest x` opens
 * the screen; it is not a server, and printing it as the thing to point a
 * client at is advice that fails the moment somebody follows it.
 */
export function proxyCommand(): string {
  if (onPath("synartesis-proxy")) {
    return "synartesis-proxy";
  }
  const invokedAs = process.argv[1];
  if (invokedAs !== undefined && invokedAs.endsWith("cli.js")) {
    return `node ${invokedAs.replace(/cli\.js$/, "proxy.js")}`;
  }
  return `node ${fileURLToPath(new URL("proxy.js", import.meta.url))}`;
}
