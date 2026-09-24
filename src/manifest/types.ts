/** The four behaviours from spec 1.4. */
export type ToolClass = "readonly" | "reversible" | "compensable" | "irreversible";

/**
 * `on_write` is a heuristic for tools whose destructiveness cannot be decided
 * statically, such as a raw SQL runner. The heuristic itself lands with the
 * gate in Phase 5; the manifest only has to carry the intent.
 */
export type GateMode = "always" | "on_write" | "never";

/**
 * How far the policy for a server has actually been tested.
 *
 * `live` means the policy met the real server and the shapes below were read
 * off its own answers. `documented` means they were derived from the server's
 * documentation and nothing has checked them -- which is not the same kind of
 * claim, and the difference is the difference between an undo that works and
 * one that looks like it will.
 *
 * Absent says nothing either way, which is the right default for a policy
 * somebody wrote themselves: the tool has no business grading their work.
 */
export type Provenance = "live" | "documented";

interface CommonServerSpec {
  readonly env?: Readonly<Record<string, string>>;
  readonly provenance?: Provenance;
  /**
   * Whether a tool no rule mentions may be treated as a read because the
   * server marks it read-only. On unless set to false. Only ever loosens a
   * hold on a read; nothing a server says makes a write go through unasked.
   */
  readonly trustAnnotations?: boolean;
}

/** A server this starts, and speaks to over its stdin and stdout. */
export interface StdioServerSpec extends CommonServerSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly url?: undefined;
}

/**
 * A hosted server, reached over HTTP with a token.
 *
 * `headers` values may hold `${VAR}` references, filled in when the server is
 * reached, the same way `env` is -- so the policy names a variable and never
 * holds the token itself.
 */
export interface RemoteServerSpec extends CommonServerSpec {
  readonly url: string;
  /** Streamable HTTP, the older SSE transport, or whichever answers. */
  readonly transport: "auto" | "http" | "sse";
  readonly headers?: Readonly<Record<string, string>>;
  readonly command?: undefined;
}

export type ServerSpec = StdioServerSpec | RemoteServerSpec;

export function isRemote(spec: ServerSpec): spec is RemoteServerSpec {
  return spec.url !== undefined;
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
  /**
   * What this server says when the thing is not there, as substrings of its
   * error text. Only meaningful on a snapshot.
   *
   * Without it every failed pre-read has to be read as absence, because the
   * protocol gives no way to tell the two apart -- which means a resource that
   * exists and could not be read is offered for approval as a creation. With
   * it, anything that is not one of these is a failed snapshot and the write
   * is refused outright.
   */
  readonly absentWhen?: readonly string[];
  /**
   * `absent` says this read is here to find nothing, and that finding
   * something is what makes the call unrecoverable.
   *
   * Every other pre-read is a before-image: it captures what the call is about
   * to replace, so undo can put it back, and a read that finds nothing means
   * there is nothing to restore. For a handful of calls that is exactly
   * inverted. Moving a file onto a path where nothing exists is undone by
   * moving it back; moving it onto a path where something does destroys what
   * was there, and one inverse cannot both move the file back and restore the
   * contents it overwrote.
   *
   * So the machinery's usual reading -- "the pre-read found nothing, therefore
   * this cannot be undone" -- gets the safe case and the dangerous one the
   * wrong way round for these. With `expect: absent` the two swap: finding
   * nothing is the reversible case and the inverse runs, finding something
   * makes it unrecoverable and a person is asked.
   *
   * The inverse of such a call must read only `$.`, because there is no
   * captured state to read: the state it puts back is absence itself.
   */
  readonly expect?: "absent";
}

export type RefusalMeaning = "uncertain" | "clean";

export interface ToolPolicy {
  readonly match: string;
  readonly class: ToolClass;
  readonly gate: GateMode;
  /**
   * What this server's `isError` proves. The protocol gives the flag no
   * transactional meaning -- it covers business-logic failures that happen
   * after a write as readily as a refusal before one -- so the default is that
   * it proves nothing. `clean` is an adapter saying, on evidence, that this
   * tool never changes anything on the way to reporting an error.
   */
  readonly refusal: RefusalMeaning;
  readonly snapshot?: CallTemplate;
  readonly inverse?: CallTemplate;
  /**
   * A read used only to tell whether anybody has touched the resource since.
   *
   * Drift checking normally rides on `snapshot`: the pre-read is repeated
   * after the write to record a post-state, and undo compares the world
   * against that. A compensable tool declares no pre-read -- it has a
   * compensating action instead of a before-image -- so it had no post-state
   * and undo could never rule out drift. It compensated anyway and said
   * `[unverified]`.
   *
   * This fills that gap. It is resolved *after* the call, with `$result`
   * available, so it can name a resource the call itself brought into
   * existence. It is consulted only where `snapshot` produced no read, so it
   * can never override a working pre-read with a differently shaped one.
   */
  readonly verify?: CallTemplate;
}

export interface Manifest {
  readonly version: 1;
  readonly servers: Readonly<Record<string, ServerSpec>>;
  readonly tools: readonly ToolPolicy[];
  /**
   * Per server, the shape each governed tool had when its policy was written.
   *
   * A policy is a claim about what a tool does, and a tool name is a poor
   * anchor for that claim: a server upgrade can keep the name and change the
   * arguments, leaving the policy confidently describing something else. A pin
   * makes that visible at startup instead of at undo time.
   *
   * Absent means unchecked, which is what every manifest written before this
   * existed wants. Present for a server means that server is checked in full.
   */
  readonly pins?: Readonly<Record<string, Readonly<Record<string, string>>>>;
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
