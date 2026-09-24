import { describe, expect, it } from "vitest";

import { allowAlways } from "../src/manifest/edit.js";
import { parseManifest } from "../src/manifest/load.js";
import { createPolicyResolver } from "../src/manifest/match.js";

const POLICY = `# The CRM, and why each rule says what it says.
version: 1

servers:
  crm:
    command: node
    args: ["dist/toy-crm.js"]

tools:
  # Reading is free.
  - match: "crm.get_*"
    class: readonly

  # Email cannot be recalled once it has gone.
  - match: "crm.send_email"
    class: irreversible   # held, always
    gate: always

  - match: "crm.post_*"
    class: irreversible
    gate: always

  - match: "crm.update_customer"
    class: reversible
    snapshot:
      tool: "crm.get_customer"
      args:
        id: "$.id"
    inverse:
      tool: "crm.update_customer"
      args:
        id: "$.id"
        name: "$snapshot.name"
# the end
`;

const base = { file: "synartesis.yaml", server: "crm", by: "arhaan", date: "2026-09-24" };

function resolved(text: string, name: string) {
  return createPolicyResolver(parseManifest(text, "x.yaml")).resolve(name);
}

describe("letting one tool through for good", () => {
  it("changes an exact rule's gate in place and keeps every comment", () => {
    const edit = allowAlways({ ...base, text: POLICY, tool: "send_email" });
    expect(edit.how).toBe("changed");
    // One line differs, and it is the gate.
    const was = POLICY.split("\n");
    const now = edit.text.split("\n");
    expect(now).toHaveLength(was.length);
    const changed = now.filter((line, i) => line !== was[i]);
    expect(changed).toEqual(["    gate: never"]);
    // Still irreversible: it is no longer held, and still cannot be undone.
    expect(resolved(edit.text, "crm.send_email").policy).toMatchObject({
      class: "irreversible",
      gate: "never",
    });
  });

  it("adds a gate to an exact rule that had none, under its class", () => {
    const edit = allowAlways({ ...base, text: POLICY, tool: "update_customer" });
    expect(edit.text).toContain('  - match: "crm.update_customer"\n    class: reversible\n    gate: never\n');
    expect(edit.text).toContain("# the end");
  });

  it("gives a tool matched by a pattern its own rule, and leaves the pattern alone", () => {
    const edit = allowAlways({ ...base, text: POLICY, tool: "post_note" });
    expect(edit.how).toBe("added");
    expect(resolved(edit.text, "crm.post_note").policy.gate).toBe("never");
    // The rest of what the pattern covers is still held.
    expect(resolved(edit.text, "crm.post_invoice").policy.gate).toBe("always");
    expect(edit.text).toContain("It still cannot be undone");
    expect(edit.text.startsWith(POLICY.replace("# the end\n", ""))).toBe(true);
  });

  it("writes a rule for a tool no rule mentions, as one that cannot be undone", () => {
    const edit = allowAlways({ ...base, text: POLICY, tool: "archive_everything" });
    expect(resolved(edit.text, "crm.archive_everything").policy).toMatchObject({
      class: "irreversible",
      gate: "never",
    });
  });

  it("says so when there is nothing to do", () => {
    const once = allowAlways({ ...base, text: POLICY, tool: "send_email" }).text;
    const twice = allowAlways({ ...base, text: once, tool: "send_email" });
    expect(twice.how).toBe("already");
    expect(twice.text).toBe(once);
  });

  it("pins a newly matched tool on a pinned server, so the proxy still starts", () => {
    const pinned = `${POLICY}pins:\n  crm:\n    get_customer: "sha256:aa"\n`;
    expect(() => allowAlways({ ...base, text: pinned, tool: "archive_everything" })).toThrow(/pinned/);
    const edit = allowAlways({ ...base, text: pinned, tool: "archive_everything", pin: "sha256:bb" });
    expect(parseManifest(edit.text, "x.yaml").pins?.["crm"]).toEqual({
      get_customer: "sha256:aa",
      archive_everything: "sha256:bb",
    });
  });

  it("refuses a server the policy does not have", () => {
    expect(() => allowAlways({ ...base, text: POLICY, server: "crn", tool: "send_email" })).toThrow(
      /no server called crn/,
    );
  });

  it("refuses a rule written on one line rather than guess at it", () => {
    const flow = POLICY.replace(
      '  - match: "crm.send_email"\n    class: irreversible   # held, always\n    gate: always\n',
      '  - { match: "crm.send_email", class: irreversible, gate: always }\n',
    );
    expect(() => allowAlways({ ...base, text: flow, tool: "send_email" })).toThrow(/by hand/);
  });
});
