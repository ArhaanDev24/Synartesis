import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The journal file and fixture stores are process-global; running test
    // files in parallel would race on them.
    fileParallelism: false,
  },
});
