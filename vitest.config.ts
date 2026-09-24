import { delimiter, resolve } from "node:path";
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
    // A held call now notifies the person, and many tests start a real proxy
    // and hold a call. Two layers, because the processes they start do not all
    // inherit the same things: the switch reaches anything spawned with this
    // environment, and the stand-in notifiers reach anything started with the
    // SDK's minimal one, which still carries PATH. Without these, running the
    // suite put real notifications on the screen of whoever ran it.
    env: {
      SYNARTESIS_NOTIFY: "0",
      PATH: `${resolve("tests/helpers/quiet-bin")}${delimiter}${process.env["PATH"] ?? ""}`,
    },
  },
});
