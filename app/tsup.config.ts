import { defineConfig } from "tsup";

/**
 * The two halves that run in Electron rather than in the window.
 *
 * Paths are relative to the repository root, which is where the scripts that
 * call this run from. The preload is CommonJS on purpose: it runs in a
 * sandboxed context, where the module loader is not available.
 */
export default defineConfig([
  {
    entry: { index: "app/main/index.ts" },
    outDir: "app/dist/main",
    format: ["esm"],
    platform: "node",
    target: "node22",
    // Everything but these two. better-sqlite3 is a native binding and cannot
    // be bundled at all; Electron supplies its own.
    external: ["electron", "better-sqlite3"],
    banner: {
      // Several libraries in here -- the model SDKs especially -- reach for
      // node builtins through `require` at run time. In an ES module there is
      // no `require`, and a bundler that leaves those calls alone produces a
      // file that throws "Dynamic require of child_process is not supported"
      // on first import. This gives them the one they expect.
      js: "import { createRequire as __nodeRequire } from 'node:module';\nconst require = __nodeRequire(import.meta.url);",
    },
    clean: true,
    sourcemap: true,
  },
  {
    entry: { bridge: "app/preload/bridge.ts" },
    outDir: "app/dist/preload",
    format: ["cjs"],
    platform: "node",
    target: "node22",
    external: ["electron"],
    outExtension: () => ({ js: ".cjs" }),
    sourcemap: true,
  },
]);
