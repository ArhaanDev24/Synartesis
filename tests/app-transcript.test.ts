import { describe, expect, it } from "vitest";

import { fold, leads } from "../app/shared/transcript.js";
import type { CallCard, ChatMessage, SessionEvent } from "../app/shared/ipc.js";

/**
 * How a turn reads.
 *
 * This is shared by the engine and the window so that a conversation reopened
 * tomorrow reads exactly as it did while it was happening. It is tested on its
 * own because the failure is not a crash -- it is a transcript that puts a
 * tool call above the sentence that introduced it and runs two turns of speech
 * together into one, which is what this did before it was written down.
 */

function call(id: string, name: string): CallCard {
  return { id, name, args: { path: "/x" }, state: "running" };
}

function play(events: readonly SessionEvent[]): ChatMessage[] {
  return events.reduce<ChatMessage[]>((so_far, event) => fold(so_far, event), []);
}

describe("a reply that spoke, acted, and spoke again", () => {
  it("keeps the three in the order they happened", () => {
    const messages = play([
      { kind: "text", chunk: "Zeroing " },
      { kind: "text", chunk: "the row." },
      { kind: "call", call: call("c1", "fs__write_file") },
      { kind: "result", call: { ...call("c1", "fs__write_file"), state: "done", result: "ok" } },
      { kind: "text", chunk: "Done." },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]?.text).toBe("Zeroing the row.");
    expect(messages[0]?.calls).toHaveLength(0);
    expect(messages[1]?.text).toBe("");
    expect(messages[1]?.calls[0]?.id).toBe("c1");
    // Not appended to the first sentence. "Zeroing the row.Done." is what a
    // single bucket produces, and it is a different reply.
    expect(messages[2]?.text).toBe("Done.");
  });

  it("puts the calls of one batch together", () => {
    const messages = play([
      { kind: "call", call: call("c1", "fs__write_file") },
      { kind: "call", call: call("c2", "fs__write_file") },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.calls.map((one) => one.id)).toEqual(["c1", "c2"]);
  });

  it("answers the call that was made, not the last one on screen", () => {
    const messages = play([
      { kind: "call", call: call("c1", "fs__write_file") },
      { kind: "text", chunk: "and now the other one" },
      { kind: "call", call: call("c2", "fs__read_text_file") },
      // The first call's answer, arriving after a second message exists.
      { kind: "result", call: { ...call("c1", "fs__write_file"), state: "done", result: "wrote" } },
    ]);
    expect(messages[0]?.calls[0]?.result).toBe("wrote");
    expect(messages[0]?.calls[0]?.state).toBe("done");
    expect(messages[2]?.calls[0]?.state).toBe("running");
  });

  it("says a failure in its own line rather than in the model's voice", () => {
    const messages = play([
      { kind: "text", chunk: "I will try." },
      { kind: "error", message: "Ollama needs an API key." },
    ]);
    expect(messages[1]?.role).toBe("note");
    expect(messages[1]?.text).toBe("Ollama needs an API key.");
    // And it did not get glued onto what the model said, where a person would
    // read it as the model's own words.
    expect(messages[0]?.text).toBe("I will try.");
  });
});

describe("who is speaking", () => {
  it("is named once per speaker, not once per fragment", () => {
    const messages = play([
      { kind: "text", chunk: "one" },
      { kind: "call", call: call("c1", "fs__write_file") },
      { kind: "text", chunk: "two" },
    ]);
    const named = messages.map((_, at) => leads(messages, at));
    // One reply, three fragments: the label belongs on the first only.
    expect(named).toEqual([true, false, false]);
  });

  it("is named again when the speaker changes", () => {
    const messages: ChatMessage[] = [
      { id: "a", role: "you", text: "do it", calls: [] },
      { id: "b", role: "model", text: "done", calls: [] },
      { id: "c", role: "note", text: "stopped", calls: [] },
    ];
    expect(messages.map((_, at) => leads(messages, at))).toEqual([true, true, true]);
  });
});
