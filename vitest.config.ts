import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The renderer's own suite is in here rather than behind a second command.
    // A test suite you have to remember to run is a test suite that is not
    // run, and the one thing CI must not do is pass while half of it sat out.
    include: ["tests/**/*.test.ts", "app/renderer/*.test.tsx"],
    // The journal file and fixture stores are process-global; running test
    // files in parallel would race on them.
    fileParallelism: false,
  },
});
