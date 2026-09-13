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
2. **No build step and no dependency.** Inline CSS and JS, one file per page.
   The faces are self-hosted now, in `site/assets/*.woff2` with their licences
   beside them, so there is no external request left at all. Do not introduce a
   framework, a CDN library, an animation library, or a package.json. If a
   thing cannot be done in CSS, the Web Animations API, or a few dozen lines of
   inline JavaScript, it is not being done here.
3. **No third-party tracking, no embeds, no cookie banner** -- with one
   exception that is already there and must stay. The last two lines before
   `</body>` load `/_vercel/insights/script.js` and
   `/_vercel/speed-insights/script.js`. Those are first-party paths served by
   the host, they set no cookie, and **they are the owner's, deliberately**.
   An earlier pass through this file read the old wording of this rule and
   deleted them; they had to be put back. Leave them alone. Anything else
   third-party is still out.
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

## Where it stands now

The last commission -- make it beautiful, free hand -- has been carried out.
The site is not the page the faults below were written about, and that section
has been deleted rather than left to mislead you. What exists today:

- A light ground (`--paper #f5efe5`) with the oxblood kept for the header, the
  closing band and accents. The uniform six-thousand-pixel wine field is gone.
- Seven sections with a real type hierarchy: hero, ledger, **the desktop
  window with four screenshots**, mechanism, refusal, terminal, closing.
- Self-hosted Cormorant and IBM Plex, so the page makes no external request.
- 52 kB of HTML, down from 88.

## What I added after that, and why it is the way it is

Read this before you touch any of it. Two of these cost a day to find.

**One curve, two speeds.** `--ease` and `--ease-soft`, and nothing animates
except `opacity`, `transform` and `clip-path` -- the three a browser can move
without laying the page out again. Add a fourth property only with a reason.

**A sticky header** that grows a shadow past the fold (`.is-scrolled`), and a
2px `.scroll-progress` bar under it driven by `scaleX`.

**A reveal system.** `.reveal` fades and lifts; `.reveal-head` wipes headings
in with `clip-path`; both stagger through a `--d` custom property. Both hidden
states live behind **`html.js` *and* the no-preference guard**, so a page with
no JavaScript, or one belonging to somebody who asked for less movement, is
the finished page immediately rather than a page waiting to be revealed.

**The trap that makes this hard, number one.** Chrome's IntersectionObserver
measures an element's own `clip-path`. A heading masked to nothing reports
`intersectionRatio: 0` forever, so any `threshold` above zero never fires and
the heading never appears. It looks exactly like a broken observer and is not.

**The trap that makes this hard, number two.** A backgrounded or suspended tab
halts the rendering lifecycle: the observer never fires and any transition
already running freezes where it stands. So there is a net -- a timer that,
if nothing has revealed after three seconds, disconnects the observer and adds
`settled` to `<html>`. Two things about it that are not optional. It must
**finish** states, not start them, or a refocused tab animates a page the
person has been looking at for a minute. And its rules must come **after** the
heading rules in the file, or the specificity ties and the heading stays
hidden.

If you rewrite the motion system, you inherit both traps. Keep the net.

## The commission: make it move like something expensive

**Add real animation. You have a free hand, and the same fence as last time.**

What is there now is competent and safe -- things fade up as you reach them.
That is the floor, not the ceiling, and it is doing nothing for the argument.

What "professional" means for this product specifically, since it does not
mean the same thing everywhere:

- **Motion that explains.** This product has an actual idea to animate: a
  thing is copied *before* it is changed, and can be put back *after*. A
  person who watches that happen understands the product; a person who reads
  about it is still deciding whether to believe you. That is the animation
  worth building, and nothing on the page does it today.
- **Confident and quiet.** Slow, few, deliberate. It is a recovery tool for
  people who have been burned by an agent, and it should feel like something
  maintained by somebody careful. No bounce, no elastic, no confetti, nothing
  that says startup landing page.
- **The evidence must stay legible.** The terminal panels and journal rows are
  the argument. Frame them, reveal them, never animate them into a smudge.
- **The Greek thread is still underused.** The meander is a line that folds
  back on itself, which is the product drawn as an ornament -- and it has
  never once been drawn. A meander that traces itself as you arrive at the
  closing band would be worth more than twenty fades.

Four places with something real to animate, in the order I would take them:

1. **The undo, as a sequence.** State, change, and the change coming back out.
   There is a recording at `site/undo-run.mp4` already; it may deserve to
   become a built thing rather than a video.
2. **The proxy diagram.** "Synartesis sits between your agent and your
   systems" -- a call travelling that path, and its snapshot being taken on
   the way through, in one loop.
3. **The four classes.** Read-only, reversible, compensable, cannot-be-undone
   is a state machine with four states and it is currently a static list.
4. **The held call.** Something arriving at a gate and stopping. This is the
   product's whole promise and the page states it in prose.

### Rules for the motion itself

- **Compositor-only.** `opacity`, `transform`, `clip-path`. Animating `width`,
  `top`, `margin` or `box-shadow` in a loop is an instant no.
- **Nothing on the first paint.** The hero may reveal; it may not wait on a
  script to become readable.
- **No scroll-jacking, no hijacked wheel, no pinned sections that fight the
  scrollbar, no parallax on the hero.** Scroll-*linked* is fine and welcome --
  scroll-*driven* narrative that takes the scrollbar away from somebody is not.
- **60fps on a laptop.** Check with the CPU throttled 4x in devtools, not on
  your own machine at full speed.
- **Anything that loops must stop when it is off screen.** An SVG animating
  forever in a section nobody is looking at is a battery bug.
- **`prefers-reduced-motion: reduce` removes all of it**, and the page must
  still make every point it makes. If a diagram only works in motion, it needs
  a still state that works too.
- **Keyboard focus is never animated away.** Focus rings appear instantly.

### Budget

The whole site is about 1.1 MB, most of it one video. You have room for
inline SVG and for CSS; you do not have room for a library, and a library is
not permitted anyway (see constraint 2). If you find yourself wanting GSAP,
what you actually want is about forty lines of Web Animations API.

## Before you hand it back

- Screenshots at 1440, 1024, 768 and 375, all sections deep.
- No horizontal scroll at any width. `document.documentElement.scrollWidth`
  must equal `clientWidth`.
- **Load the page, switch to another tab for a minute, come back.** Everything
  is visible and nothing is mid-animation. This is the failure mode that gets
  shipped, because nobody tests it.
- Throttle the CPU 4x and scroll the whole page. Nothing stutters.
- Set "reduce motion" in the OS and reload. Nothing moves, and nothing is
  missing.
- Tab through it once. Every interactive thing takes focus and shows it.
- The install command still copies to the clipboard.
- The last two `<script>` tags before `</body>` are still there.
- Every link still resolves, including `install.html` and `404.html`.
- Say what you changed and why, in the same plain register as the rest of this
  repository. If you removed something on purpose, say that too -- silence
  reads as an accident.
