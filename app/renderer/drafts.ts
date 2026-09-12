const memory = new Map<string, string>();
const unsaved = new Set<string>();
const prefix = "synartesis.draft.v1.";

export function readDraft(id: string): string {
  if (memory.has(id)) return memory.get(id) ?? "";
  try { return localStorage.getItem(prefix + id) ?? ""; }
  catch { return ""; }
}

export function draftIsSaved(id: string): boolean { return !unsaved.has(id); }

/** Storage failure must not break typing or throw away the in-window draft. */
export function saveDraft(id: string, text: string): boolean {
  memory.set(id, text);
  try {
    if (text === "") localStorage.removeItem(prefix + id);
    else localStorage.setItem(prefix + id, text);
    unsaved.delete(id);
    return true;
  } catch { unsaved.add(id); return false; }
}
