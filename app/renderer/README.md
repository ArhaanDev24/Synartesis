# Renderer checks

Read `../AGENTS.md` before making changes. Develop with `pnpm app:sandbox`, never the real `pnpm app` profile.

Run the repository checks and the renderer's small, separate JSX test suite:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm exec vitest run --config app/renderer/vitest.config.ts
pnpm app:build
```

The renderer suite checks inert Markdown rendering, unfinished code fences, nested lists, task states, tables, and conversation draft storage/failure handling. The root Vitest configuration searches `tests/`; use the explicit renderer configuration above for these additional tests.

## Window behavior

- `Copy` preserves the message's original Markdown; code blocks have their own copy control.
- Markdown supports fenced code, headings, lists, nested lists, task markers, tables, blockquotes, inline emphasis/code, and rules. It is a deliberately limited text renderer, not a full CommonMark implementation. Raw HTML stays text. Images show their captions and links copy their addresses; neither can initiate navigation or network requests.
- Drafts are saved locally per conversation as they change. A storage failure preserves the draft in memory and says so. API-key entry is separate and is never passed to draft storage.
- Alt+Up/Down browses the current conversation's sent prompts and restores the unsent draft when leaving history. Normal arrow keys retain their text-editing behavior.
- Cmd/Ctrl+L focuses the composer; Cmd/Ctrl+Shift+O starts a chat; Cmd/Ctrl+/ opens the shortcut guide. IME Enter does not send.
- Dialogs contain their tab sequence, Escape dismisses them, and closing restores the originating control. Each undo step starts on Cancel. The first step uses the engine's actual preview; only the second confirmation invokes undo.
- Transcript scrolling follows new output only while the reader is near the bottom. Keyboard scrolling and reading older messages do not get pulled back down; Latest message resumes following.

## Visual and keyboard regression pass

Start `pnpm app:sandbox -- --remote-debugging-port=9223`. Capture a real turn with:

```sh
PORT=9223 node app/dev/shot.mjs out.png "zero out the north revenue" 7000
```

Check light and dark themes, a compact window, reduced motion, and these paths:

1. Type a draft, reload, switch chats, return, and verify the text stays with its chat.
2. Browse history and return to an unsent draft; check Enter, Shift+Enter, and IME composition.
3. Reach model/account popovers using Tab. Check forward/reverse Tab, Escape, and the returned focus ring.
4. Copy a message and a code block and compare their clipboard contents with the original text.
5. Review a recorded tool card. Its class, capture evidence, and recovery badge remain visible when details collapse. Failed calls expand their error details. A call with no journal evidence must still say **not recorded**.
6. Reach an approval using Tab and deny it. A rejected approval request must leave the card visible with an error and allow retry.
7. Open undo using the keyboard, cancel at each step, and verify no file changed. Then confirm both steps and verify the sandbox file was restored.

The current bridge supplies recorded tool details after a proxy response and ledger totals after a turn. The renderer must not invent earlier classifications or totals: running cards explicitly say **Undo not confirmed yet**, and the busy ledger labels its counts as recorded before this turn.
