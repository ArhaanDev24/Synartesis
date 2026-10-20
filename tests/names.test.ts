import { describe, expect, it } from "vitest";

import { parse } from "yaml";

import { policyName } from "../src/install/install.js";
import { yamlKey } from "../src/manifest/yaml-key.js";

describe("a name written as a YAML key", () => {
  it("reads back as the same string, whatever it is", () => {
    for (const name of ["send_email", "null", "true", "&anchor", "*star", "-dash", "has: colon", "a#b", "No"]) {
      const read: unknown = parse(`${yamlKey(name)}: 1`);
      expect(read !== null && typeof read === "object" ? Object.keys(read) : [], name).toEqual([name]);
    }
  });

  it("stays bare where it can, so ordinary files do not change", () => {
    expect(yamlKey("read_file")).toBe("read_file");
    expect(yamlKey("github-mcp")).toBe("github-mcp");
  });
});

describe("a client's server name, as the policy will call it", () => {
  it("never has a dot or a double underscore, which qualify tool names", () => {
    expect(policyName("context7.com")).toBe("context7-com");
    expect(policyName("my__server")).toBe("my_server");
    expect(policyName("github")).toBe("github");
    expect(policyName("...")).toBe("server");
  });
});
