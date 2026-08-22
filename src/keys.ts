/**
 * Splitting what a terminal actually hands over into the keys a person pressed.
 *
 * A raw terminal delivers whatever has accumulated since the last read, not one
 * keypress per event. Two quick presses arrive as one string, and a paste
 * arrives as a hundred. Matched whole, "uy" is neither u nor y, so both are
 * lost -- which is how confirming an undo by typing u and then y quickly did
 * nothing at all.
 */

/**
 * ESC [ params final, or ESC O final. Everything a keyboard sends that is more
 * than one character is one of these two shapes; anything else beginning with
 * an escape is a lone escape, which is a key in its own right here.
 */
const SEQUENCE = /^\u001b(\[[0-9;?]*[ -\/]*[@-~]|O[@-~])/;

export function keysIn(chunk: string): string[] {
  const keys: string[] = [];
  let at = 0;
  while (at < chunk.length) {
    const rest = chunk.slice(at);
    const sequence = rest.startsWith("\u001b") ? SEQUENCE.exec(rest) : null;
    const key = sequence?.[0] ?? rest.slice(0, 1);
    keys.push(key);
    at += key.length;
  }
  return keys;
}
