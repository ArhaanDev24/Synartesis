import { describe, expect, it } from "vitest";

import { connectStdioUpstream } from "../src/proxy/upstream.js";

describe("a server that fails to start", () => {
  it("repeats what the server said instead of only that it closed", async () => {
    // A server that cannot start almost always says why, on stderr, and the
    // first thing a new user runs is the command that starts one. "Connection
    // closed" on its own leaves them with nothing to act on.
    await expect(
      connectStdioUpstream({
        name: "fs",
        command: "node",
        args: ["-e", "console.error('Error: None of the specified directories are accessible'); process.exit(1);"],
        stderr: "capture",
      }),
    ).rejects.toThrow(/None of the specified directories are accessible/);
  });

  it("still says the server closed, when it said nothing at all", async () => {
    await expect(
      connectStdioUpstream({
        name: "fs",
        command: "node",
        args: ["-e", "process.exit(1);"],
        stderr: "capture",
      }),
    ).rejects.toThrow(/fs/);
  });
});
