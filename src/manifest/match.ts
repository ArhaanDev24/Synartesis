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
  return { match: qualifiedName, class: "irreversible", gate: "always" };
}

export function createPolicyResolver(manifest: Manifest): PolicyResolver {
  const compiled: CompiledPolicy[] = manifest.tools
    .map((policy) => ({
      policy,
      test: toRegExp(policy.match),
      specificity: literalLength(policy.match),
      wildcards: policy.match.split("*").length - 1,
    }))
    // Longest literal wins, ties broken by fewer wildcards. Ordering is a
    // property of the patterns, never of the order they were written in.
    .sort((a, b) => b.specificity - a.specificity || a.wildcards - b.wildcards);

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
