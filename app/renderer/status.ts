/**
 * Whether the journal says a call never reached the system.
 *
 * `denied` and `gated` are the two ways that happens, and the difference
 * matters on the card: nothing was changed, so there is nothing to put back.
 * Saying "no way back recorded" about a call that never ran reads as damage
 * nobody can undo, which is the opposite of what took place -- and on this
 * product, of all products, that sentence has to be right.
 */
export function stopped(status: string): boolean {
  return status === "denied" || status === "gated";
}
