import type { ChatMessage, SessionEvent } from "./ipc.js";

/**
 * One event, folded into the transcript.
 *
 * Shared by both sides on purpose. The engine keeps a transcript so a
 * conversation can be reopened, and the window builds one from the same events
 * as they arrive; two copies of this logic would drift, and the symptom would
 * be a conversation that reads differently after a restart than it did while
 * it was happening.
 *
 * The ordering rule is the whole of it. A model says something, calls a tool,
 * and says something else, and that is three moments, not one -- flattening
 * them puts the card above both halves of the sentence and runs the halves
 * together, which is not what happened.
 */
export function fold(messages: readonly ChatMessage[], event: SessionEvent): ChatMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  const at = next.length - 1;

  if (event.kind === "text") {
    // Into the current reply, unless it has already called something -- after
    // which anything said is a reply to what came back.
    if (last !== undefined && last.role === "model" && last.calls.length === 0) {
      next[at] = { ...last, text: last.text + event.chunk };
      return next;
    }
    next.push({ id: newId(next.length, "model"), role: "model", text: event.chunk, calls: [] });
    return next;
  }

  if (event.kind === "call") {
    // Beside the other calls of the same batch, unless this reply has already
    // spoken, in which case the calls belong after those words.
    if (last !== undefined && last.role === "model" && last.text === "") {
      next[at] = { ...last, calls: [...last.calls, event.call] };
      return next;
    }
    next.push({ id: newId(next.length, "model"), role: "model", text: "", calls: [event.call] });
    return next;
  }

  if (event.kind === "result") {
    // Whichever message is holding it, which is not always the last one: a
    // batch of calls is answered one at a time while the next is running.
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const message = next[index];
      if (message === undefined) continue;
      if (message.calls.some((one) => one.id === event.call.id)) {
        next[index] = {
          ...message,
          calls: message.calls.map((one) => (one.id === event.call.id ? event.call : one)),
        };
        return next;
      }
    }
    return next;
  }

  if (event.kind === "error" || event.kind === "stopped") {
    // In its own line rather than folded into the model's words, where it
    // would read as something the model said.
    next.push({
      id: newId(next.length, "note"),
      role: "note",
      text: event.kind === "error" ? event.message : `Stopped: ${event.why}`,
      calls: [],
    });
    return next;
  }

  return next;
}

/** Whether this message should print its own name, or continue the one above. */
export function leads(messages: readonly ChatMessage[], at: number): boolean {
  const before = messages[at - 1];
  return before === undefined || before.role !== messages[at]?.role;
}

function newId(at: number, role: string): string {
  return `${role}-${String(at)}`;
}
