/**
 * D7. The key a call presents so that the same call made twice is done once.
 *
 * Derived from the action rather than generated, so a retry presents the same
 * key the first attempt did. It rides in `_meta`, which is advisory: a server
 * that ignores it gives no protection, which is why the journal's own state
 * transitions remain the real guard against re-applying an inverse.
 *
 * It is sent on the forward call as well as on the inverse, and the forward
 * call is the one that matters more. A write that times out in flight leaves
 * the agent free to try again; without a key the server has no way to tell the
 * retry from a second intention, and two side effects end up behind one
 * journal row. Undo would then faithfully reverse one of them and report
 * success, which is a worse outcome than not having recorded the call at all.
 */
export const IDEMPOTENCY_META_KEY = "synartesis.dev/idempotency-key";

/**
 * Merges the key into whatever `_meta` the client already sent.
 *
 * `_meta` is not ours: a client puts `progressToken` there and expects it back
 * on the notifications it gets. Replacing the object wholesale would drop it,
 * so the client's own entries are preserved and only this one key is added.
 */
export function withIdempotencyKey(meta: unknown, key: string): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  if (typeof meta === "object" && meta !== null) {
    for (const [name, value] of Object.entries(meta)) {
      merged[name] = value;
    }
  }
  merged[IDEMPOTENCY_META_KEY] = key;
  return merged;
}
