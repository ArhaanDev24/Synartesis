/**
 * Run electron-builder, and do not hand back a stale application.
 *
 * Two failures, both of which have happened here:
 *
 * electron-builder fetches Electron and its checksums while packaging, and a
 * dropped connection fails the whole build with ECONNRESET. That is weather,
 * not a problem with the code, so it is retried.
 *
 * And a pack that does not run leaves the previous bundle sitting on disk,
 * looking exactly like a current one. Somebody then opens it and reports bugs
 * that were fixed hours ago. So afterwards this compares what was produced
 * against what went into it, and says so loudly if the output is older.
 *
 *   node app/build/pack.mjs [--dir] [any other electron-builder flags]
 *   node app/build/pack.mjs --check-only    just the staleness check
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const checkOnly = process.argv.includes("--check-only");
const passed = process.argv.slice(2).filter((flag) => flag !== "--check-only");

const ATTEMPTS = 4;
/** Only the ones that mean "the network went away", never a real build error. */
const WEATHER = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|getaddrinfo/i;

/** The newest mtime under a directory, or 0 if there is nothing there. */
function newest(dir) {
  let latest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}

function run() {
  return spawnSync(
    join(root, "node_modules/.bin/electron-builder"),
    [...passed, "--projectDir", join(root, "app")],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

let result;
for (let attempt = 1; checkOnly ? false : attempt <= ATTEMPTS; attempt += 1) {
  result = run();
  process.stdout.write(result.stdout ?? "");
  if (result.status === 0) {
    break;
  }
  const said = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!WEATHER.test(said) || attempt === ATTEMPTS) {
    process.stderr.write(said);
    process.stderr.write(
      attempt === ATTEMPTS && WEATHER.test(said)
        ? `\n  Gave up after ${String(ATTEMPTS)} attempts; the network kept dropping.\n`
        : "\n  electron-builder failed, and not because of the network.\n",
    );
    process.exit(result.status ?? 1);
  }
  process.stderr.write(
    `\n  Attempt ${String(attempt)} lost its connection while fetching Electron. Retrying.\n\n`,
  );
}

/*
 * The part that stops a stale bundle being handed over. Every macOS bundle
 * that was produced is compared against the renderer and main bundles that
 * went into it; on the platforms this does not build here, there is nothing
 * to compare and nothing to check.
 */
const release = join(root, "app/release");
const built = newest(join(root, "app/dist"));
const bundles = readdirSync(release, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
  .map((entry) => join(release, entry.name, "Synartesis.app/Contents/Resources/app.asar"));

for (const asar of bundles) {
  let packed;
  try {
    packed = statSync(asar).mtimeMs;
  } catch {
    continue;
  }
  if (packed < built) {
    process.stderr.write(
      `\n  ${asar}\n  is older than what went into it. The pack did not take, and the\n` +
        `  bundle on disk is a previous build. Do not ship or open it.\n`,
    );
    process.exit(1);
  }
}

process.stdout.write(`\n  Packed, and newer than its input.\n`);
