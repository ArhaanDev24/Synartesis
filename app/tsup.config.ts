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
    external: ["electron"],
    // Nothing from node_modules is bundled. better-sqlite3 is a native binding
    // and cannot be; the model SDKs reach for `child_process` and `http2`
    // through dynamic requires a bundler has to rewrite, and rewriting them
    // turns a working library into one that throws on the first import. The
    // app carries its dependency tree instead, which is how Electron apps ship
    // anyway.
    skipNodeModulesBundle: true,
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
