/**
 * Making the tests agree about how this command is spelled.
 *
 * Output is full of commands to run next, and how they are written depends on
 * whether `synartesis` is on PATH: installed, it says `synartesis undo ...`;
 * run out of a checkout, it spells out `node /path/to/dist/cli.js undo ...`,
 * because advice to run a command that does not exist is worse than none.
 *
 * That makes any test asserting on the short form pass or fail by accident of
 * the machine. On a developer's laptop, where a global install is usually
 * linked to the checkout, they pass; on a clean CI runner they do not -- which
 * is exactly how eleven of them went green here and red there.
 *
 * So the tests say which world they are in. An executable named `synartesis`,
 * ahead of everything on PATH, is all `onPath` looks for.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * An environment in which this command is installed. `keep` collects the
 * directory so the caller can clean it up.
 */
export function asInstalled(keep: string[]): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-onpath-"));
  keep.push(dir);
  const shim = join(dir, "synartesis");
  // Never run: onPath only asks whether it exists and is executable.
  writeFileSync(shim, "#!/bin/sh\nexit 0\n");
  chmodSync(shim, 0o755);
  return { PATH: `${dir}${delimiter}${process.env["PATH"] ?? ""}` };
}
