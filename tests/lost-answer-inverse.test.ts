/**
 * The inverse for a write that landed while its answer was lost.
 *
 * When the transport fails and a read-back proves the write applied anyway,
 * the proxy rebuilds the inverse from what it captured before the call. That
 * rebuild can fail for one very specific reason: an inverse that reads
 * `$result.` needs the answer, and the answer is precisely what went missing.
 *
 * It used to fail silently -- caught bare, `recovered = undefined` -- so the
 * action was recorded as applied with no inverse and undo said "done, cannot
 * undo" with nothing to explain it. Seventy lines earlier in the same function
 * the identical failure is recorded as a warning. This is the path where undo
 * matters most, and it was the one that said least.
 */
import { describe, expect, it } from "vitest";

import { recoverInverse } from "../src/proxy/proxy.js";
import { parseManifest } from "../src/manifest/load.js";
import type { ToolPolicy } from "../src/manifest/types.js";

function policyFor(inverse: string): ToolPolicy {
  const manifest = parseManifest(
    `
version: 1
servers:
  crm:
    command: node
    args: ["dist/toy-crm.js"]
tools:
  - match: "crm.get_customer"
    class: readonly
  - match: "crm.update_customer"
    class: reversible
    snapshot:
      tool: "crm.get_customer"
      args: { id: "$.id" }
    inverse:
      tool: "crm.update_customer"
      args: { id: ${inverse}, plan: "$snapshot.plan" }
`,
    "p.yaml",
  );
  const rule = manifest.tools.find((one) => one.match === "crm.update_customer");
  if (rule === undefined) {
    throw new Error("the fixture policy lost its rule");
  }
  return rule;
}

const CAPTURED = { args: { id: "c_001", plan: "enterprise" }, snapshot: { plan: "pro" } };

describe("rebuilding an inverse without the answer", () => {
  it("succeeds when the inverse never needed the answer", () => {
    const recovered = recoverInverse(policyFor('"$.id"'), CAPTURED, false);
    expect(recovered.inverse).toMatchObject({ args: { id: "c_001", plan: "pro" } });
    expect(recovered.warning).toBeUndefined();
  });

  it("says why when the inverse needed the answer that went missing", () => {
    const recovered = recoverInverse(policyFor('"$result.id"'), CAPTURED, false);
    expect(recovered.inverse).toBeUndefined();
    // The part that was missing: not just that there is no inverse, but that
    // the lost answer is the reason for it.
    expect(recovered.warning).toContain("could not be resolved");
    expect(recovered.warning).toContain("without that answer");
  });

  it("does not invent one when there was no prior state to restore", () => {
    const recovered = recoverInverse(policyFor('"$.id"'), CAPTURED, true);
    expect(recovered.inverse).toBeUndefined();
    // Silent on purpose here: the caller already records the missing prior
    // state, and saying it twice reads as two separate faults.
    expect(recovered.warning).toBeUndefined();
  });
});
