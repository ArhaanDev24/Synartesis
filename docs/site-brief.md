# Working on synartesis.online

Read this before changing anything under `site/`. Most of it is the standing
contract. The last section is a commission: **make this site beautiful, and you
have a free hand doing it.**

It lives in `docs/` rather than in `site/` because everything in `site/` is
published verbatim, and a public page criticising the page next to it is not a
good look.

## What this is

Three static pages and two media files. No build step, no framework, no
bundler, no dependencies. Each page carries its own `<style>` and `<script>`
inline, which is why they are large files — that is deliberate, not neglect.

```
site/index.html    the argument, 2376 lines
site/install.html  getting it running, 1350 lines
site/404.html
site/undo-run.mp4  a real terminal recording, 896 kB
site/undo-run.jpg  its poster frame
```

**It ships twice, from the same directory.** Vercel serves
<https://synartesis.online> with `site/` as its root, on every push to `main`;
`.github/workflows/pages.yml` puts the same directory on GitHub Pages at
<https://arhaandev24.github.io/Synartesis/>. Nothing compiles either one, so
whatever you commit is exactly what ships, at both addresses, with no staging
step in between. Assume anything you leave in `site/` is public the moment it
merges.

`vercel.json` at the repository root holds what little configuration there is:
`outputDirectory: site`, empty install and build commands, a `www` redirect,
`nosniff` and a referrer policy on everything, and a seven-day cache on
`mp4|jpg|png|svg|ico|woff2`. Two things follow. Images you add are cached for a
week, so change the filename rather than the bytes. And self-hosted fonts get
that cache for free if they are `.woff2`, which is most of the argument for
self-hosting them.

## Looking at it

```bash
cd site && python3 -m http.server 8765
```

Then <http://127.0.0.1:8765/index.html>. Open it as a `file://` URL and the
reveal-on-scroll script behaves differently, so use the server.

Look at it at **1440, 1024, 768 and 375** wide before you believe anything.
Several of the faults below only exist at one of those.

## The product, in one paragraph, because the page has to be true

Synartesis is an MCP proxy with a SQLite journal. Every tool call an AI agent
makes passes through it and is recorded with the state that call replaced, so
it can be put back. Calls that cannot be undone are held until a person says
yes. There is a command line tool (`npm install -g synartesis`) and, since
0.6.2, a desktop window. Both share one journal.

**Do not invent capabilities, numbers, benchmarks, testimonials, logos, or
customers.** Everything on this page is currently true and that is the whole
reason anybody would trust a tool whose job is to be trusted. If you want a
claim you are not sure about, check `README.md` and `CHANGELOG.md` at the
repository root, or leave it out.

## What must not break

Short list. Everything not on it is yours.

1. **`npm install -g synartesis`**, and the copy button next to it, stays on
   the first screen. It is the only thing the page is actually asking for.
2. **No build step and no dependency.** Inline CSS and JS. The only external
   request is Google Fonts, and you may drop that (self-hosting the two faces
   would be an improvement, not a regression) but not replace it with a
   framework, a CDN library, or a package.json.
3. **No analytics, no tracking, no third-party embeds, no cookie banner.**
   There are none today and the product is about not being watched.
4. **Text stays at 16px or larger** for body copy on a phone. There is a
   comment in the file at the old font-size decision explaining why.
5. **`prefers-reduced-motion: no-preference` guards every animation**, as it
   does now. Nothing moves for somebody who asked for nothing to move.
6. **Keyboard focus stays visible.** There is exactly one `:focus-visible`
   rule today; more would be better, none is not an option.
7. **Contrast.** Body text on the oxblood ground must hold 4.5:1, and large
   display type 3:1. If you change the palette, check it rather than eyeball
   it.
8. The `<link rel="canonical">`, the favicon, the Open Graph tags, and the
   links to `install.html`, GitHub and npm all keep working.

## What is wrong with it now

These are observed, at the widths named. You do not have to fix them in this
order, or at all, if your redesign makes them moot.

**One colour, all the way down.** Ground `#5e1420`, panel `#2c080f`, ink
`#f6e9e5`, and that is the entire page for six thousand pixels. Nothing marks
a new idea except a thin meander rule, so the eye gets no rhythm and the whole
thing reads as one uniform band. This is the biggest one.

**Half the page is empty on a wide screen.** The text column is pinned left at
about 60 characters and the right 40% of "What happens on every call", "What it
will not do", and "The whole interface" is dead ground with a cropped ornament
floating in it. At 1440 the page looks like a phone layout that was stretched.

**The hero ends 400px before the section does.** Real, measured: content stops
around y=480 and the section runs to 903.

**The ornaments read as stickers.** The engraved sun-faces in the margins are
clipped by the viewport edge at every width, sit at unrelated sizes, and follow
no grid. Either commit to them as a system or cut them.

**The one diagram is lost.** "Synartesis sits between your agent and your
systems" is the clearest idea on the page and it is a 190px terminal with two
tiny chips either side, adrift in a field of nothing.

**The terminal panels are illegible on a phone.** At 375 wide they scale down
rather than reflow, so the showreel's journal is 4px type. They are the
evidence — the thing that makes the argument — and on a phone they are a smudge.

**The type scale is flat.** Every section heading is the same size, in the same
uppercase Cormorant, broken over the same two lines. Every lede is the same
size. Nothing is louder than anything else, so nothing is the point.

**The site does not know the desktop app exists.** Not one word, anywhere. It
shipped at 0.6.2 with installers for macOS, Windows and Linux, and the site
still describes a CLI only. See below.

## The commission

**Make it look good. You have a free hand.** Restructure sections, change the
palette, change the fonts, throw away the layout, rewrite the CSS from nothing,
add pages, add SVG, add motion, cut anything that is not earning its place. If
you think the right answer is a different site, build the different site. The
seven constraints above are the fence; inside it, your judgement beats
anything I would specify.

What "better" means for this particular product, so you are aiming at the same
thing I would:

- **Confident and quiet.** It is a recovery tool for people who have been burned
  by an agent. Trust comes from looking like something maintained by somebody
  careful, not from looking exciting.
- **Evidence over decoration.** The terminal recordings, the journal rows, the
  four-classes cards — those are the argument. Ornament should frame them,
  never compete.
- **The Greek thread is the identity, and it is currently underused.** The
  name means *a fastening together*; the meander, the medal, the Cormorant
  display face all come from that. There is far more to do with it than a
  divider rule. The desktop app's own frame — a meander border around a mark —
  is generated by `app/build/make-logo.py` into `brand/synartesis-logo.svg`,
  and the site shows that file rather than drawing its own.
- **It should be legible at arm's length on a phone**, since that is where at
  least half of the people who hear about this will first see it.

### The one addition worth making

Give the desktop window a section, with pictures. Four screenshots are already
in the repository at `brand/synartesis-desktop.png`, `-approval.png`, `-undo.png`
and `-dark.png` — the same ones the README uses, about 220–275 kB each. Copy
them into `site/` or reference them from `raw.githubusercontent.com`, your
call. The facts:

- Installers for macOS (Apple silicon and Intel), Windows, and Linux, at
  <https://github.com/ArhaanDev24/Synartesis/releases/latest>.
- `synartesis desktop` opens it once installed, on every platform.
- It talks to Claude, Gemini, Mistral, OpenAI, or anything speaking
  `/v1/chat/completions` — including Ollama and LM Studio locally, which cost
  nothing and send nothing anywhere.
- Every tool call the model makes shows a card saying whether the state before
  it was captured. A call that cannot be undone stops and waits for a person.
- **The builds are not signed yet**, so the first launch is blocked by
  Gatekeeper on macOS and SmartScreen on Windows. Say so. Hiding it would be
  exactly the kind of thing this product exists to argue against.

### Budget

The page is 88 kB of HTML today and the whole site is about 1.1 MB, most of it
one video. Adding four screenshots roughly doubles it, which is fine — but keep
the first screen fast: nothing render-blocking beyond the fonts, images below
the fold lazy, and no layout shift as they arrive.

## Before you hand it back

- Screenshots at 1440, 1024, 768 and 375, all four sections deep.
- No horizontal scroll at any width. `document.documentElement.scrollWidth`
  must equal `clientWidth`.
- Tab through it once. Every interactive thing takes focus and shows it.
- Set "reduce motion" in the OS and reload. Nothing moves.
- The install command copies to the clipboard.
- Every link still resolves, including the two other pages.
- Say what you changed and why, in the same plain register the rest of this
  repository uses. If you removed something on purpose, say that too — silence
  reads as an accident.
