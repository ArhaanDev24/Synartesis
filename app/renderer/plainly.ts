/**
 * A held call's reason, said in words rather than in JSON.
 *
 * The gate explains itself honestly and at length: a snapshot that failed
 * carries the error the server gave back, and an MCP server gives its errors
 * back as a content envelope. Put on screen verbatim, the most common reason
 * of all -- the file does not exist yet, so there is nothing to keep -- reaches
 * somebody as a wall of `{"content":[{"type":"text",...` with the one sentence
 * that matters buried in the middle of it.
 *
 * Nothing here decides anything or hides anything. It unwraps the envelope,
 * drops a clause the sentence already said once, and turns the single most
 * frequent errno into the sentence a person would have written. Anything it
 * does not recognise is passed through exactly as it arrived, which is the
 * important half: a reason nobody anticipated must still be readable.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text inside an MCP error envelope, if that is what this is. */
function insideEnvelope(json: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["content"])) {
    return undefined;
  }
  const said = parsed["content"]
    .map((block: unknown) => (isRecord(block) && typeof block["text"] === "string" ? block["text"] : ""))
    .filter((text) => text !== "")
    .join(" ");
  return said === "" ? undefined : said;
}

export function plainly(reason: string): string {
  let said = reason;

  // The envelope, wherever in the sentence it landed.
  const opened = said.indexOf("{");
  const closed = said.lastIndexOf("}");
  if (opened !== -1 && closed > opened) {
    const inside = insideEnvelope(said.slice(opened, closed + 1));
    if (inside !== undefined) {
      said = `${said.slice(0, opened)}${inside}${said.slice(closed + 1)}`;
    }
  }

  // "the read said: ... the read reported an error: ..." says it twice.
  if (said.includes("the read said:")) {
    said = said.replace("the read reported an error: ", "");
  }

  // The one that is not really an error: there was nothing there to keep.
  said = said.replace(
    /ENOENT: no such file or directory, open '([^']+)'/g,
    (_whole, path: string) => `there is no file at ${path} yet`,
  );

  return said;
}
