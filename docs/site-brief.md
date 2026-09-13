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
6. **Keyboard focus stays visible.** There is a site-wide `:focus-visible`
   ring now, deliberately outside the motion guard -- somebody who asked for
   less movement still has to be able to see where they are. Restyle it if you
   like; removing it is not an option.
7. **Contrast.** Body text on the oxblood ground must hold 4.5:1, and large
   display type 3:1. If you change the palette, check it rather than eyeball
   it.
8. The `<link rel="canonical">`, the favicon, the Open Graph tags, and the
   links to `install.html`, GitHub and npm all keep working.

## Where it stands now

Two commissions have been carried out: make it beautiful, and make it move.
The fault lists both were written against described pages that no longer
exist, so they have been deleted rather than left to send you fixing what is
already fixed. What is true today:

- A light ground (`--paper #f5efe5`) with oxblood kept for the header, the
  closing band and accents.
- Seven sections on the home page: hero, ledger, the desktop window with four
  screenshots, mechanism, refusal, terminal, closing.
- Self-hosted Cormorant and IBM Plex. The site makes no external request.
- **Four things animate**, all on the home page.
- `install.html` and `404.html` share the base -- sticky header, progress
  rule, reveals, interaction transitions -- and have no scenes of their own.
  `404.html` gets the meander and nothing else.

## What the last pass built, and what was wrong with it

Read this before touching any of it.

### The four scenes

Each is an idea the page could previously only assert. Marked up as
`[data-motion="..."]`, played by an IntersectionObserver, replayable by a
button in `.motion-controls`:

- **`undo`** -- a copy of the file travels to the journal, *then* the value
  changes, then a copy travels back and the original returns. Seven animations
  over 7.6 seconds.
- **`proxy`** -- a call crosses the diagram and is marked as it passes.
- **`class`** -- four tracks with a packet on each. Measured, and worth
  keeping true if you rebuild it: read-only runs to the end and stays,
  reversible goes and **comes back**, compensable stops part-way, and
  irreversible stops *short of the gate* and waits. That last one is the whole
  product, drawn.
- **`meander`** -- twelve units of seven straight segments, each scaling from
  its own origin so the pen turns its own corners. No dashoffset paint loop
  and no library. It closes the home page and the 404.

### Built on the Web Animations API, not on hidden CSS states

This is the part worth preserving even if you throw away everything else.
There are **no hidden resting states**: the finished page is what the markup
renders, and motion is added on top by script. Cancelling an animation
therefore always lands on the finished page rather than stranding an element
half-revealed. If you go back to `opacity:0` resting states you inherit both
traps below, and they cost a day each.

**Trap one.** Chrome's IntersectionObserver measures an element's own
`clip-path`. A heading masked to nothing reports `intersectionRatio: 0`
forever, so any `threshold` above zero never fires and the heading never
appears. It looks exactly like a broken observer and is not.

**Trap two.** A backgrounded or suspended tab halts the rendering lifecycle:
the observer never fires, and any transition already running freezes where it
stands. Hence the net -- a timer that settles everything after three seconds,
plus handlers on `visibilitychange`, `pagehide`, `pageshow`, `freeze`,
`resume`, and a blur-then-focus pair. It must **finish** states, not start
them, and its rules must come **after** the heading rules or the specificity
ties.

### Three things it left behind, now fixed

Said plainly because they are the kind of thing that happens again:

1. All three pages had an empty `a, button { }` husk where their interaction
   transitions used to be. Every link, button and the primary call to action
   snapped between colours instead of easing -- a polish regression underneath
   a commission about polish. The transitions are restored.
2. There was no focus ring anywhere except on the new motion controls. There
   is a site-wide one now.
3. `404.html` carried the stylesheet for a progress bar it does not have.

### How it was checked, and how to check yours

- **No horizontal scroll in twelve of twelve**: three pages at 1440, 1024, 768
  and 375.
- **Reduce-motion**: the controls disappear, the play button creates *zero*
  animations, the progress rule hides, and all three steps of the undo still
  read as text.
- **Hidden mid-sequence for three seconds**: on return nothing is half-faded,
  no animation is left running, and replay still works.

**A warning about your own harness.** Any embedded or backgrounded browser
reports `document.hidden`, which freezes every animation on the page. Working
motion looks completely dead there. Three separate "bugs" were found and
dismissed that way in one evening. Verify motion in a real, visible, focused
window or you will chase ghosts.

## The commission: make it better. Anything.

**You have a free hand, and the fence above is the only fence.** Restructure,
repalette, rewrite the CSS from nothing, add pages, cut pages, replace the
motion, throw out the layout, change the type. If you think the right answer
is a different site, build the different site. Inside those eight constraints,
your judgement beats anything that could be specified here.

What "better" means for this product, so you are aiming at the same thing:

- **Confident and quiet.** It is a recovery tool for people who have been
  burned by an agent. Trust comes from looking like something maintained by
  somebody careful, not from looking exciting.
- **Evidence over decoration.** The screenshots, the journal rows, the four
  classes -- those are the argument. Ornament frames them and never competes.
- **The Greek thread is the identity.** The name means *a fastening together*.
  The meander, the medal, the Cormorant display face all come from that, and
  there is still more in it than a divider and a closing band.
- **Legible at arm's length on a phone**, which is where at least half of the
  people who hear about this will first see it.

### What looks weakest to me today

Observed, not guessed. Fix them, or make them moot, or disagree -- all three
are fine answers.

- **`install.html` is a left-hand column on a wide screen.** At 1440 the
  content stops around 58% and the right side is empty. It is the page that
  actually asks for the install, and it is the least designed of the three.
- **`install.html` has no motion at all.** That was a judgement -- it is the
  page somebody reads while typing a command, and movement beside the thing
  you are copying competes with the reason you came. If you disagree, you are
  allowed to; just say so when you hand it back.
- **Four "Watch this call" buttons stack up on a phone**, one per class, in a
  two-by-two grid. Four identical affordances in one screen is three too many.
- **The home page is long.** Seven sections and about nine thousand pixels.
  Nothing on it is obviously wrong, which is a different thing from every
  section earning its place.
- **Nothing on the site says what version it is**, and the desktop download
  points at "latest" and hopes.

### Budget

The whole site is about 1.1MB, most of it one video. There is room for inline
SVG and for CSS. There is no room for a library, and a library is not
permitted anyway -- see constraint 2. If you find yourself wanting GSAP, what
you want is about forty lines of the Web Animations API.

## Before you hand it back

- Screenshots at 1440, 1024, 768 and 375, all pages, top to bottom.
- No horizontal scroll at any width. `document.documentElement.scrollWidth`
  must equal `clientWidth`.
- **Load a page, switch away for a minute, come back.** Everything visible,
  nothing mid-animation. This is the failure that ships, because nobody tests
  it -- and remember that a hidden harness makes working motion look dead.
- Throttle the CPU 4x and scroll the whole page. Nothing stutters.
- Set reduce-motion and reload. Nothing moves, and nothing is missing.
- Tab through every page. Every interactive thing takes focus and shows it.
- The install command still copies.
- The last two `<script>` tags on `index.html` and `install.html` are still
  there.
- Every link resolves, including `install.html` and `404.html`.
- Say what you changed and why, in the same plain register as the rest of this
  repository. If you removed something on purpose, say that too -- silence
  reads as an accident.
