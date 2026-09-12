# Working on the Synartesis desktop window

Read this before changing anything under `app/`. It is the standing contract,
not a task list — the task is whatever you were asked to do.

## What this program is

A chat window whose MCP client points at the Synartesis proxy rather than at
the user's servers directly. Every tool call therefore arrives with the state
it replaced already captured, and undo is a function call rather than a feature
this app implements.

That is the whole product, and it is why the tool-call card is not decoration.
**A person must be able to see, while a change is happening, whether it can be
put back.** If a change you make would hide or soften that, it is the wrong
change, however much cleaner it looks.

## Running it

```bash
pnpm app:sandbox              # throwaway policy, journal, files and a fake model
pnpm app:sandbox -- --dark    # the other theme
pnpm app:sandbox -- --fresh   # start from nothing
```

This needs no API key, reaches no network, and cannot touch anything real —
the model is `app/dev/stand-in.mjs` and the only files it can write are sample
ones under `app/dev/.sandbox/files`. Use it. `pnpm app` runs against the user's
real `~/.synartesis`, which means a prompt writes to their actual disk.

To look at what you changed without squinting at your own screen:

```bash
pnpm app:sandbox -- --remote-debugging-port=9223
PORT=9223 node app/dev/shot.mjs out.png
PORT=9223 node app/dev/shot.mjs out.png "zero out the north revenue" 7000
PORT=9223 node app/dev/shot.mjs out.png --click .picker
```

A change to a window is not finished until somebody has looked at it, and
looking is cheaper than guessing.

## Where things are

| | |
|---|---|
| `renderer/App.tsx` | The whole window. Draws state, sends events, decides nothing. |
| `renderer/theme.css` | Every colour, every animation. Tokens at the top. |
| `renderer/Mark.tsx` | The mark, the meander, the full logo. |
| `renderer/logo-art.ts` | **Generated.** Edit `build/make-logo.py`, run `pnpm app:logo`. |
| `renderer/bridge.ts` | The typed view of what the preload exposes. |
| `shared/ipc.ts` | Every type that crosses the process boundary. |
| `shared/transcript.ts` | How events become messages. Used by **both** sides. |
| `preload/bridge.ts` | The only way the page reaches anything. |
| `main/` | Electron, the desk, the engine. Not yours unless the task says so. |

## Rules

Each of these has a reason. A rule whose reason you do not know is a rule you
will work around, so the reasons are here.

**The renderer decides nothing.** It draws what the engine sends and sends back
what the person did. No policy, no classification, no "is this safe" logic in
the window — all of that lives in the library, where it is tested.

**Never widen the bridge into a hole.** `preload/bridge.ts` exposes a fixed list
of named calls. It must never accept a channel name from the page. A renderer
that can name its own channel can reach every handler in the main process, and
this is a window that renders text somebody else wrote.

**Nothing loads from anywhere.** The CSP in `renderer/index.html` is
`default-src 'none'`. No CDN, no Google Fonts, no icon library, no telemetry.
Fonts are bundled through `@fontsource/*`. If a dependency wants a network at
runtime, it is the wrong dependency.

**`--force` is not reachable from this window, ever.** Overwriting somebody
else's edit is a decision a person makes in a terminal, looking at the
difference. Not a button.

**Undo asks twice, and the first sheet is the real plan** — `previewUndo` reads
the journal, it is not a guess. An undo changes files as surely as the thing it
is undoing did.

**The tool card keeps its three facts**: what was called, what class Synartesis
gave it, and whether the state it replaced was captured. `not recorded` is the
most important label on it — it means the change is not in the journal — so it
must not be quietly dropped for being ugly.

**Keys never reach the renderer.** `ModelChoice.hasKey` is a boolean. Do not add
a field that carries the key itself, not even to show a masked version.

**Motion lives inside `@media (prefers-reduced-motion: no-preference)`**, and is
`opacity` and `transform` only. Those are the two properties a browser can
animate without laying the page out again. Motion is a preference the operating
system already knows the answer to.

**Do not fork `shared/transcript.ts`.** The engine folds events into a stored
transcript with the same function the window uses live. Two copies drift, and
the symptom is a conversation that reads differently after a restart than it
did while it was happening.

## Colour

Two surfaces, and the split is the point:

- `--rail-*` is the chrome. Oxblood in **both** themes. Nothing is read on it,
  which is where a strong colour belongs.
- everything else is the document. Parchment by default, oxblood in dark.

Never hard-code a hex outside the token block at the top of `theme.css`. Never
use `--rail-*` in the document area or the reverse. The palette comes from
`site/index.html` — the site and the application should not look like two
products.

## What you are free to change

Layout, spacing, type scale, component structure, new views, better empty
states, keyboard shortcuts, more motion, a settings surface, anything that
makes it easier to use. The rules above are about what the window *promises*,
not about how it looks.

Markdown, copy, per-conversation drafts, prompt history and keyboard handling
all landed — see `renderer/README.md` for what each promises. Still open:

- nothing can be attached to a message, and nothing renders an image;
- a long conversation is one unbroken scroll with no way to jump within it;
- there is no way to rename or delete a conversation from the rail.

## Style

Comments explain **why**, never what. `// increment the counter` is noise;
`// Left, not centre: centring lands the repeat mid-glyph` is the reason
somebody will otherwise undo the line below it. Match the density around you.

TypeScript is strict and the escape hatches are banned outright: no `any`, no
type assertions, no `@ts-expect-error`. `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess` are on, so an optional property is spread
conditionally (`...(x === undefined ? {} : { x })`) rather than set to
`undefined`.

## Verifying

```bash
pnpm typecheck   # two projects: the root, and app/renderer
pnpm lint
pnpm test        # the library suite and app/renderer/*.test.tsx together
```

All three must be clean. The renderer has its own `tsconfig.json` because it is
a browser program and needs DOM types the rest of the repository must not have;
`pnpm typecheck` runs both.

If you change anything under `main/` or `shared/`, there are tests for it —
`tests/app-*.test.ts`. Add to them. A test that passes before your fix is a
test that is not testing your fix: break the thing on purpose and watch it
fail before you believe it.

## Traps, all of which have already cost a day

- **A top-level `await` in an Electron main module deadlocks.** Module
  evaluation blocks the loop, `ready` never fires, and nothing errors — it
  simply waits for ever. Hang everything off `app.whenReady().then(...)`.
- **`capturePage` on an offscreen window never returns.** Same symptom.
- **Smooth scrolling while text streams is a judder**, because the scroll is
  restarted on every chunk. `.scroll[data-streaming="true"]` turns it off.
- **A popover that is centred with `translateX(-50%)` must carry that
  translation in its own keyframes**, or it jumps sideways as it arrives. See
  `come-centred`.
- **Tool names are qualified.** `fs__write_file`, never `write_file` — the proxy
  fronts the user's servers *and* Synartesis's own, so it always prefixes.
  Tests that hard-code the bare name pass against a file nobody touched.
- **`app/dist` is build output.** It is git-ignored and eslint-ignored. Do not
  edit it and do not be surprised when it is stale — run `pnpm app:build`.
