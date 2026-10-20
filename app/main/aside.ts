import { renameSync } from "node:fs";

/**
 * A file that will not parse is moved aside before anything replaces it.
 * Read as empty and then written over, one bad hand edit -- or a write cut
 * short -- lost every conversation for good, with nothing said.
 */
export function setAside(path: string): string | undefined {
  const aside = `${path}.damaged-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(path, aside);
    console.error(`synartesis: ${path} could not be read; it was moved to ${aside} and a new one started`);
    return aside;
  } catch {
    return undefined;
  }
}
