import type { Manifest, ToolPolicy } from "./types.js";

export interface PolicyMatch {
  readonly policy: ToolPolicy;
  /** False when the fail-closed default was synthesised instead of matched. */
  readonly matched: boolean;
}

export interface PolicyResolver {
  resolve(qualifiedName: string): PolicyMatch;
}

/** `*` stands for any run of characters that is not a dot. */
function toRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.]*");
  return new RegExp(`^${source}$`);
}

function literalLength(pattern: string): number {
  return pattern.length - pattern.split("*").length + 1;
}

interface CompiledPolicy {
  readonly policy: ToolPolicy;
  readonly test: RegExp;
  readonly specificity: number;
  readonly wildcards: number;
}

/**
 * D4. An unrecognised tool is irreversible and gated. A silent passthrough on
 * an unknown destructive tool is worse than having no product at all.
 */
function failClosed(qualifiedName: string): ToolPolicy {
  return { match: qualifiedName, class: "irreversible", gate: "always", refusal: "uncertain" };
}

/** The more a class costs if it is wrong, the higher. */
const CAUTION: Readonly<Record<ToolPolicy["class"], number>> = {
  readonly: 0,
  reversible: 1,
  compensable: 2,
  irreversible: 3,
};

const GATED: Readonly<Record<ToolPolicy["gate"], number>> = { never: 0, on_write: 1, always: 2 };

export function createPolicyResolver(manifest: Manifest): PolicyResolver {
  const compiled: CompiledPolicy[] = manifest.tools
    .map((policy) => ({
      policy,
      test: toRegExp(policy.match),
      specificity: literalLength(policy.match),
      wildcards: policy.match.split("*").length - 1,
    }))
    // Longest literal wins, ties broken by fewer wildcards, and a tie past
    // that by the more cautious rule. Ordering is a property of the patterns,
    // never of the order they were written in: `fs.read_*` and `fs.*_file`
    // both match `fs.read_file`, are equally specific, and whichever was
    // written first decided whether it was a read or something held.
    .sort(
      (a, b) =>
        b.specificity - a.specificity ||
        a.wildcards - b.wildcards ||
        CAUTION[b.policy.class] - CAUTION[a.policy.class] ||
        GATED[b.policy.gate] - GATED[a.policy.gate],
    );

  const cache = new Map<string, PolicyMatch>();

  return {
    resolve(qualifiedName: string): PolicyMatch {
      const cached = cache.get(qualifiedName);
      if (cached !== undefined) {
        return cached;
      }
      const hit = compiled.find((candidate) => candidate.test.test(qualifiedName));
      const match: PolicyMatch =
        hit === undefined
          ? { policy: failClosed(qualifiedName), matched: false }
          : { policy: hit.policy, matched: true };
      cache.set(qualifiedName, match);
      return match;
    },
  };
}

/**
 * Whether a rule's server part -- itself a pattern -- names this server.
 * `*.write_file` covers every server, which a prefix check did not see.
 */
export function coversServer(match: string, server: string): boolean {
  return toRegExp(match.split(".")[0] ?? "").test(server);
}
