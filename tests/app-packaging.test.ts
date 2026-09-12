import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

import tsupConfig from "../app/tsup.config.js";

/**
 * Three files that have to agree, and never see each other.
 *
 * What tsup leaves out of the bundle has to be in the application's
 * dependencies, or the packaged program dies on its first import with
 * "Cannot find module". A native binding has to be unpacked out of the asar,
 * or it dies on the first call. And neither failure shows up in development,
 * where node_modules is sitting right there and nothing is archived -- they
 * show up on somebody else's machine, in a signed build, weeks later.
 *
 * So they are checked here rather than trusted.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A config file read off disk is unknown until it has been looked at. */
function fields(path: string, how: (text: string) => unknown): Record<string, unknown> {
  const parsed: unknown = how(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`${path} is not an object`);
  }
  return parsed;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function names(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((one) => typeof one === "string") : [];
}

const appPackage = fields("app/package.json", (raw): unknown => JSON.parse(raw));
const builder = fields("app/electron-builder.yml", (raw): unknown => parse(raw));
const mac = isRecord(builder["mac"]) ? builder["mac"] : {};

/** What the bundler refuses to inline, minus the one Electron supplies itself. */
function externals(): string[] {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const found = new Set<string>();
  for (const one of configs) {
    if (!isRecord(one)) continue;
    const listed = one["external"];
    if (!Array.isArray(listed)) continue;
    for (const name of listed) {
      if (typeof name === "string" && name !== "electron") {
        found.add(name);
      }
    }
  }
  return [...found];
}

describe("what gets packaged", () => {
  it("ships every module the bundle expects to find at run time", () => {
    const shipped = names(appPackage["dependencies"]);
    for (const name of externals()) {
      // Left out of the bundle and not declared: the application launches,
      // and then throws on its first import, only once it is packaged.
      expect(shipped).toContain(name);
    }
  });

  it("declares nothing it does not need", () => {
    // The other direction. A dependency nobody imports is a dependency nobody
    // is auditing, shipped inside something that is about to be signed.
    expect(names(appPackage["dependencies"]).sort()).toEqual(externals().sort());
  });

  it("unpacks the native binding, which cannot be loaded from an archive", () => {
    const unpacked = list(builder["asarUnpack"]).join(" ");
    for (const name of externals()) {
      expect(unpacked).toContain(name);
    }
  });

  it("points at something the build actually produces", () => {
    const main = text(appPackage["main"]);
    const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
    const outputs = configs.flatMap((one) => (isRecord(one) ? [text(one["outDir"])] : []));
    // "dist/main/index.js" against an outDir of "app/dist/main".
    expect(outputs.some((out) => out.endsWith(main.replace(/\/[^/]+$/, "")))).toBe(true);
  });
});

describe("what gets signed", () => {
  it("has the entitlements a hardened Electron application cannot start without", () => {
    expect(mac["hardenedRuntime"]).toBe(true);
    const path = `app/${text(mac["entitlements"])}`;
    expect(existsSync(path)).toBe(true);
    const plist = readFileSync(path, "utf8");
    // Chromium compiles and runs code it wrote itself. Without these three the
    // signed application launches to a blank window, and the unsigned one used
    // in development is perfectly fine -- so nothing catches it but this.
    expect(plist).toContain("com.apple.security.cs.allow-jit");
    expect(plist).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    expect(plist).toContain("com.apple.security.cs.disable-library-validation");
  });

  it("has an icon, and a notarisation hook that exists", () => {
    expect(existsSync(`app/${text(mac["icon"])}`)).toBe(true);
    // Resolved against the working directory rather than the project folder,
    // unlike every other path in that file, which is easy to get wrong once
    // and then only discover during a release.
    expect(existsSync(resolve(text(builder["afterSign"])))).toBe(true);
  });

  it("never asks for credentials it should not have", () => {
    const hook = readFileSync("app/build/notarize.cjs", "utf8");
    // The developer's Apple credentials are read from the environment at the
    // moment they are used. Anything that wrote them down would put them in a
    // file, a log, or this repository.
    expect(hook).not.toMatch(/appleIdPassword\s*[:=]\s*["'][^"']/);
    expect(hook).toMatch(/process\.env/);
  });
});
