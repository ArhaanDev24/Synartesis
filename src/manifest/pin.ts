import { createHash } from "node:crypto";

import { canonical } from "../canonical.js";
import { createPolicyResolver } from "./match.js";
import { qualify, type Manifest } from "./types.js";

/**
 * A fingerprint of the shape a tool accepts.
 *
 * Taken over the canonical form rather than the raw text, because key order in
 * a schema carries no meaning and a server that reserialises its own manifest
 * must not read as a changed tool.
 */
export function fingerprint(inputSchema: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(inputSchema)).digest("hex")}`;
}

export interface ToolShape {
  readonly name: string;
  readonly inputSchema: unknown;
}

export type PinFault =
  /** The pin and the server disagree: the tool changed under a live policy. */
  | { readonly kind: "moved"; readonly tool: string; readonly pinned: string; readonly found: string }
  /** Governed by a real policy on a pinned server, with nothing vouching for it. */
  | { readonly kind: "unpinned"; readonly tool: string; readonly found: string }
  /** Pinned, but the server no longer offers it, so the pin describes nothing. */
  | { readonly kind: "gone"; readonly tool: string };

/**
 * Compares one server's advertised tools against the pins recorded for it.
 *
 * Pinning is per server and all-or-nothing. A server with no pins is not
 * checked, so every manifest written before this existed keeps working; a
 * server with any pins is checked completely, because a half-pinned server is
 * the worst of both -- it reads as protected and is not.
 *
 * What this defends against is narrow and worth stating: a server upgrade that
 * keeps a tool's name and changes what it does. The policy still says
 * `reversible`, the snapshot template still reads a field that has moved, and
 * the before-image captured no longer corresponds to the write. Nothing fails.
 * The undo is produced on request, confidently, and is wrong -- which is worse
 * than having no undo, because a person acted on it.
 */
export function auditPins(
  server: string,
  advertised: readonly ToolShape[],
  manifest: Manifest,
): readonly PinFault[] {
  const pins = manifest.pins?.[server];
  if (pins === undefined) {
    return [];
  }

  const resolver = createPolicyResolver(manifest);
  const faults: PinFault[] = [];
  const present = new Set<string>();

  for (const tool of advertised) {
    present.add(tool.name);
    // An unmatched tool is already fail-closed as irreversible and gated, so
    // there is no classification for a schema change to corrupt. Demanding a
    // pin for it would make every new tool on the server a startup failure.
    if (!resolver.resolve(qualify(server, tool.name)).matched) {
      continue;
    }
    const found = fingerprint(tool.inputSchema);
    const pinned = pins[tool.name];
    if (pinned === undefined) {
      faults.push({ kind: "unpinned", tool: tool.name, found });
    } else if (pinned !== found) {
      faults.push({ kind: "moved", tool: tool.name, pinned, found });
    }
  }

  for (const name of Object.keys(pins)) {
    if (!present.has(name)) {
      faults.push({ kind: "gone", tool: name });
    }
  }

  return faults;
}

/** The `pins:` block for a manifest, ready to be read and pasted by a person. */
export function pinBlock(shapes: ReadonlyMap<string, readonly ToolShape[]>, manifest: Manifest): string {
  const resolver = createPolicyResolver(manifest);
  const lines = ["pins:"];
  for (const server of [...shapes.keys()].sort()) {
    const governed = (shapes.get(server) ?? [])
      .filter((tool) => resolver.resolve(qualify(server, tool.name)).matched)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (governed.length === 0) {
      continue;
    }
    lines.push(`  ${server}:`);
    for (const tool of governed) {
      lines.push(`    ${tool.name}: "${fingerprint(tool.inputSchema)}"`);
    }
  }
  return lines.join("\n");
}

/** Reads as a list a person can act on, one fault per line. */
export function explainPins(server: string, faults: readonly PinFault[]): string[] {
  return faults.map((fault) => {
    switch (fault.kind) {
      case "moved":
        return (
          `${server}.${fault.tool} no longer has the shape it was pinned at. ` +
          `Its policy was written for the old one, so the snapshot and inverse ` +
          `it carries may no longer describe this tool.\n      pinned ${fault.pinned}\n      now    ${fault.found}`
        );
      case "unpinned":
        return (
          `${server}.${fault.tool} is governed by a policy and has no pin, on a ` +
          `server where everything else is pinned.\n      add    ${fault.tool}: "${fault.found}"`
        );
      case "gone":
        return (
          `${server}.${fault.tool} is pinned but the server does not expose it, ` +
          `so the pin vouches for nothing. Remove it, or connect the server that has it.`
        );
    }
  });
}
