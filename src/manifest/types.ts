/** The four behaviours from spec 1.4. */
export type ToolClass = "readonly" | "reversible" | "compensable" | "irreversible";

/**
 * `on_write` is a heuristic for tools whose destructiveness cannot be decided
 * statically, such as a raw SQL runner. The heuristic itself lands with the
 * gate in Phase 5; the manifest only has to carry the intent.
 */
export type GateMode = "always" | "on_write" | "never";

export interface ServerSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | readonly TemplateValue[]
  | { readonly [key: string]: TemplateValue };

export interface CallTemplate {
  /** Qualified as `server.tool`. */
  readonly tool: string;
  readonly args: Readonly<Record<string, TemplateValue>>;
}

export interface ToolPolicy {
  readonly match: string;
  readonly class: ToolClass;
  readonly gate: GateMode;
  readonly snapshot?: CallTemplate;
  readonly inverse?: CallTemplate;
}

export interface Manifest {
  readonly version: 1;
  readonly servers: Readonly<Record<string, ServerSpec>>;
  readonly tools: readonly ToolPolicy[];
}

/** Qualified name used everywhere policy is looked up. */
export function qualify(server: string, tool: string): string {
  return `${server}.${tool}`;
}
