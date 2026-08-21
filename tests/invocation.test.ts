import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { cliCommandFrom } from "../src/invocation.js";

const originalPath = process.env["PATH"];
const dirs: string[] = [];

afterEach(() => {
  process.env["PATH"] = originalPath;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function emptyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-path-"));
  dirs.push(dir);
  return dir;
}

describe("telling someone how to run this", () => {
  it("spells out the full command when synartesis is not installed", () => {
    process.env["PATH"] = emptyPath();
    const from = pathToFileURL("/somewhere/dist/proxy.js").href;
    // Advice to run a command that does not exist is worse than no advice.
    expect(cliCommandFrom(from)).toBe("node /somewhere/dist/cli.js");
  });

  it("uses the short form once it is on the path", () => {
    const dir = emptyPath();
    const shim = join(dir, "synartesis");
    writeFileSync(shim, "#!/bin/sh\nexit 0\n");
    chmodSync(shim, 0o755);
    process.env["PATH"] = dir;

    expect(cliCommandFrom(pathToFileURL("/somewhere/dist/proxy.js").href)).toBe("synartesis");
  });

  it("does not mistake a non-executable file of the same name for the command", () => {
    const dir = emptyPath();
    const notACommand = join(dir, "synartesis");
    writeFileSync(notACommand, "just a file");
    chmodSync(notACommand, 0o644);
    process.env["PATH"] = dir;

    expect(cliCommandFrom(pathToFileURL("/somewhere/dist/proxy.js").href)).toContain("node ");
  });
});
