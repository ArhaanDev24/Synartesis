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

export interface QualifiedName {
  readonly server: string;
  readonly tool: string;
}

/** Splits on the first dot only; tool names may contain further dots. */
export function splitQualified(qualified: string): QualifiedName | undefined {
  const dot = qualified.indexOf(".");
  if (dot <= 0 || dot === qualified.length - 1) {
    return undefined;
  }
  return { server: qualified.slice(0, dot), tool: qualified.slice(dot + 1) };
}
