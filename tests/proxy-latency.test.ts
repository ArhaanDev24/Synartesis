import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "./helpers/harness.js";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

async function measure(call: () => Promise<unknown>, iterations: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await call();
    samples.push(performance.now() - start);
  }
  return samples;
}

describe("proxy latency", () => {
  it("adds under 10ms at p95, journal write included", async () => {
    const active = await createHarness();
    harness = active;
    const args = { name: "update_customer", arguments: { id: "c_001", notes: "bench" } };
    const direct = (): Promise<unknown> => active.direct.callTool(args);
    const proxied = (): Promise<unknown> => active.proxied.callTool(args);

    // Warm both paths so JIT and prepared-statement compilation are not
    // charged to the proxy.
    await measure(direct, 50);
    await measure(proxied, 50);

    const directP95 = percentile(await measure(direct, 300), 95);
    const proxiedP95 = percentile(await measure(proxied, 300), 95);
    const overhead = proxiedP95 - directP95;

    console.log(
      `p95 direct ${directP95.toFixed(3)}ms, proxied ${proxiedP95.toFixed(3)}ms, ` +
        `overhead ${overhead.toFixed(3)}ms`,
    );
    expect(overhead).toBeLessThan(10);
  });
});
