import { isMap, isNode, isScalar, isSeq, parseDocument, stringify } from "yaml";

import { canonical } from "../canonical.js";
import { createPolicyResolver } from "./match.js";
import { parseManifest } from "./load.js";
import type { Manifest, ToolPolicy } from "./types.js";

/** Why an edit could not be made, in words for the person who asked for it. */
export class PolicyEditError extends Error {
  override readonly name = "PolicyEditError";
}

export interface AllowAlways {
  /** The file as it should be written. Unchanged when `how` is "already". */
  readonly text: string;
  /**
   * "changed": an exact rule had its gate set in place. "added": a rule was
   * appended for this one tool. "already": nothing needed doing.
   */
  readonly how: "changed" | "added" | "already";
  /** What the tool is now, so the person is told if it still cannot be undone. */
  readonly policy: ToolPolicy;
}

export interface AllowAlwaysInput {
  readonly text: string;
  readonly file: string;
  readonly server: string;
  readonly tool: string;
  /** Who, for the comment above an added rule. */
  readonly by: string;
  readonly date: string;
  /**
   * The tool's current fingerprint, needed only when its server is pinned and
   * the tool is not: a rule that newly matches it would otherwise stop the
   * proxy from starting, which is a strange way to be told yes was heard.
   */
  readonly pin?: string;
}

/**
 * Stops the policy holding one tool, for good.
 *
 * An edit to the text by source range rather than a re-serialised document.
 * `toString()` on a parsed document refolds long lines and moves comments,
 * and the comments in these files are the explanations of why each rule says
 * what it says -- losing them to say yes to one tool would be a poor trade.
 *
 * Only a gate changes. The class stays what it was, so a tool that cannot be
 * undone is still shown as one that cannot be undone everywhere it appears;
 * it is simply no longer held. A tool matched only by a pattern gets its own
 * rule, copied from the one it matched, so no other tool the pattern covers
 * is let through with it. The result is parsed and compared against the
 * original: anything other than the one intended change is refused.
 */
export function allowAlways(input: AllowAlwaysInput): AllowAlways {
  const { text, file, server, tool } = input;
  const qualified = `${server}.${tool}`;
  const before = parseManifest(text, file);
  if (before.servers[server] === undefined) {
    throw new PolicyEditError(`${file} has no server called ${server}`);
  }
  const current = createPolicyResolver(before).resolve(qualified);

  const doc = parseDocument(text, { keepSourceTokens: true });
  const tools = doc.get("tools", true);
  const exact = isSeq(tools)
    ? tools.items.find((item) => isMap(item) && item.get("match") === qualified)
    : undefined;

  let edited: string;
  let how: AllowAlways["how"];
  if (exact !== undefined) {
    if (!isMap(exact) || exact.flow === true) {
      throw new PolicyEditError(`the rule for ${qualified} is written on one line; change its gate by hand`);
    }
    const gate = exact.items.find((pair) => isScalar(pair.key) && pair.key.value === "gate");
    if (gate !== undefined && isScalar(gate.value) && gate.value.value === "never") {
      how = "already";
      edited = text;
    } else if (gate !== undefined) {
      const at = rangeOf(gate.value, qualified);
      edited = text.slice(0, at[0]) + "never" + text.slice(at[1]);
      how = "changed";
    } else {
      const cls = exact.items.find((pair) => isScalar(pair.key) && pair.key.value === "class");
      const key = cls?.key;
      if (cls === undefined || !isScalar(key)) {
        throw new PolicyEditError(`the rule for ${qualified} has no class; add one by hand first`);
      }
      const keyAt = rangeOf(key, qualified)[0];
      const indent = " ".repeat(keyAt - lineStart(text, keyAt));
      const lineEnd = endOfLine(text, rangeOf(cls.value, qualified)[1]);
      edited = `${text.slice(0, lineEnd)}\n${indent}gate: never${text.slice(lineEnd)}`;
      how = "changed";
    }
  } else {
    if (tools !== undefined && (!isSeq(tools) || tools.flow === true || tools.items.length === 0)) {
      throw new PolicyEditError(`the tools list in ${file} is not written one rule to a line; add the rule by hand`);
    }
    const base: Record<string, unknown> = current.matched
      ? { ...current.policy }
      : { class: "irreversible" };
    delete base["match"];
    delete base["refusal"];
    const rule = { match: qualified, ...base, gate: "never" };
    const said = [`# Let through without asking, by ${input.by} on ${input.date}.`];
    if (base["class"] === "irreversible") {
      said.push("# It still cannot be undone: it is recorded, and no longer held.");
    }
    // Quoted like every hand-written match, since a pattern's `*` needs it.
    const body = stringify([rule], { lineWidth: 0 })
      .trimEnd()
      .replace(/^- match: .*$/m, `- match: ${JSON.stringify(qualified)}`);
    if (isSeq(tools)) {
      const seqAt = rangeOf(tools, "tools")[0];
      const indent = " ".repeat(seqAt - lineStart(text, seqAt));
      const lines = [...said, ...body.split("\n")].map((line) => indent + line);
      edited = insertAfter(text, rangeOf(tools, "tools")[2], `\n${lines.join("\n")}\n`);
    } else {
      edited = `${text.replace(/\n*$/, "\n")}\ntools:\n${[...said, ...body.split("\n")].map((line) => `  ${line}`).join("\n")}\n`;
    }
    how = "added";
  }

  const pins = before.pins?.[server];
  if (how !== "already" && pins !== undefined && pins[tool] === undefined) {
    if (input.pin === undefined) {
      throw new PolicyEditError(`${server} is pinned, and ${tool} has no pin yet`);
    }
    edited = addPin(edited, server, tool, input.pin, qualified);
  }

  const after = parseManifest(edited, file);
  const policy = createPolicyResolver(after).resolve(qualified).policy;
  confirmOnly(before, after, { server, tool }, current.policy, policy, input.pin);
  return { text: edited, how, policy };
}

function rangeOf(node: unknown, what: string): readonly [number, number, number] {
  const range = isNode(node) ? node.range : undefined;
  if (range === undefined || range === null) {
    throw new PolicyEditError(`could not find where ${what} is written in the policy`);
  }
  return range;
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

function endOfLine(text: string, at: number): number {
  const next = text.indexOf("\n", Math.max(0, at - 1));
  return next === -1 ? text.length : next;
}

/** At `at` when a line starts there, else at the end of the line `at` is on. */
function insertAfter(text: string, at: number, block: string): string {
  if (at > 0 && text[at - 1] === "\n") {
    return text.slice(0, at) + block.slice(1) + text.slice(at);
  }
  const end = endOfLine(text, at);
  return text.slice(0, end) + block.replace(/\n$/, "") + text.slice(end);
}

function addPin(text: string, server: string, tool: string, pin: string, qualified: string): string {
  const doc = parseDocument(text, { keepSourceTokens: true });
  const map = doc.getIn(["pins", server], true);
  if (!isMap(map) || map.flow === true || map.items.length === 0) {
    throw new PolicyEditError(`the pins for ${server} are not written one to a line; pin ${qualified} by hand`);
  }
  const at = rangeOf(map, "pins")[0];
  const indent = " ".repeat(at - lineStart(text, at));
  return insertAfter(text, rangeOf(map, "pins")[2], `\n${indent}${tool}: ${JSON.stringify(pin)}\n`);
}

/**
 * The edit, and nothing but the edit.
 *
 * Every rule that was there is still there and says the same; at most one
 * rule was added, for this tool; the tool's class did not move; its gate is
 * now never; and the pins differ by at most the one intended.
 */
function confirmOnly(
  before: Manifest,
  after: Manifest,
  { server, tool }: { readonly server: string; readonly tool: string },
  was: ToolPolicy,
  now: ToolPolicy,
  pin: string | undefined,
): void {
  const qualified = `${server}.${tool}`;
  const refuse = (why: string): never => {
    throw new PolicyEditError(`the edit came out wrong (${why}), so nothing was written`);
  };
  if (now.match !== qualified || now.gate !== "never") {
    refuse(`${qualified} is not let through`);
  }
  if (now.class !== was.class) {
    refuse(`${qualified} would change from ${was.class} to ${now.class}`);
  }
  const others = (manifest: Manifest): string[] =>
    manifest.tools.filter((rule) => rule.match !== qualified).map((rule) => canonical(rule));
  if (canonical(others(before)) !== canonical(others(after))) {
    refuse("another rule changed");
  }
  if (canonical(before.servers) !== canonical(after.servers)) {
    refuse("a server changed");
  }
  const pinned = before.pins?.[server];
  const expected =
    pin === undefined || pinned === undefined || pinned[tool] !== undefined
      ? before.pins
      : { ...before.pins, [server]: { ...pinned, [tool]: pin } };
  if (canonical(expected ?? null) !== canonical(after.pins ?? null)) {
    refuse("the pins changed");
  }
}
