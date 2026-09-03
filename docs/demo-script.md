# Synartesis — demo film script

**Runtime:** 75 seconds. **Format:** 1920×1080, 30fps, no audio, no voiceover.
**Destination:** unlisted YouTube, Palantir Startup Fellowship application.

Every line of terminal output in this script is real. It was produced by
Synartesis 0.3.2 and copied, not written for the film. Do not paraphrase it.
If a line has to be shortened to fit, cut whole lines, never edit the words
inside one.

---

## Design system

Use the project's identity exactly.

| Token | Value |
|---|---|
| Ground | `#5e1420` oxblood |
| Ground lift | `#7a1c2b` |
| Panel (terminals) | `#2c080f` |
| Ink | `#f6e9e5` bone |
| Panel ink | `#f0d3cc` |
| Accent / alarm | `#e8927f` |
| Display face | Cormorant Garamond, 300 weight, uppercase, letter-spacing 0.06em |
| Mono face | IBM Plex Mono, 400/500 |

**Rules.** No gradients. No border-radius, anywhere, on anything. No drop
shadows. No emoji. No stock icons. Nothing centred except the final card.
Motion is opacity and transform only. One easing curve throughout:
`cubic-bezier(0.22, 0.61, 0.36, 1)`.

The mark is the return-loop: a bone ring on oxblood, opening at the east,
with a triangular arrowhead on the terminus, turning **anticlockwise**.
Clockwise reads as redo and is wrong. Asset: `brand/synartesis-mark-1080.png`.

---

## SHOT 1 — Cold open
**0:00 – 0:06**

Full oxblood field. Silence.

The mark draws itself: the band sweeps in anticlockwise from the tail over
1.2s, the arrowhead lands last with a single 100ms opacity pop. Then the
double rim rings scale in from 1.04 to 1.0.

Wordmark fades up beneath it, mono, tracked wide:

```
S Y N A R T E S I S
```

Hold 1s. Cut.

---

## SHOT 2 — What you have
**0:06 – 0:14**

Left half: a file, rendered as a panel `#2c080f`, mono, typed out at ~40cps.

```
~/notes/roadmap.md

# Roadmap

- ship 0.3
- rewrite the parser
```

Right half, Cormorant, arriving line by line:

> An agent with write
> access to your files

Hold 1.5s.

---

## SHOT 3 — The damage
**0:14 – 0:24**

The counter is the whole shot. Mono, large, centred in the right half,
climbing fast:

```
101 files changed
```

It should climb from 0 to 101 in **0.2 seconds of screen time** and then
stop dead. That number is real: it is what an agent did to a 483-file
open-source repository through the proxy.

As it climbs, the file panel on the left thrashes: lines being replaced,
`- ship 0.3` struck through and overwritten. Let it become unreadable.

Then everything stops. Beat of 1s on the wreckage. Under the counter, in
`#e8927f`:

```
0.2 seconds
```

---

## SHOT 4 — One command
**0:24 – 0:40**

Cut to a clean terminal panel filling the frame. A prompt types:

```
$ synartesis undo
```

Beat. Then the real output arrives, one row every 220ms:

```
  U N D O  4b886da5

    2  skip     fs.move_file    never applied (awaiting approval)
    1  revert   fs.write_file   state matches; applying inverse

  R E S U L T  rolled_back
```

`rolled_back` in `#e8927f`.

As each `revert` row lands, the file panel behind it heals: the original
lines fade back in. By the last row it reads exactly as it did in Shot 2.

Then, mono, small, under the panel:

```
1.15 seconds. git status clean.
```

Hold 2s. This is the shot the film exists for. Do not rush it.

---

## SHOT 5 — What it will not do
**0:40 – 0:54**

Cut. Cormorant, left:

> Some things cannot
> be taken back

Terminal panel, right. An agent call arrives and stops:

```
  A W A I T I N G   A P P R O V A L

  08f8d6fd
  files.create_directory
  irreversible  this action cannot be undone

  synartesis approve 08f8d6fd --by <name>
```

The word `irreversible` in `#e8927f`. Nothing else moves for 2s. The
stillness is the point: the call is not happening.

Then, mono, small:

```
It was never sent.
```

---

## SHOT 6 — The refusal
**0:54 – 1:06**

The hardest idea in the product. Give it room.

Cormorant, left:

> And it will not
> overwrite you

Terminal, right. Real drift output:

```
  halted at sequence 1   drift detected

  the resource is not in the state this run left it in.
    at line 1:
    - AGENT VERSION
    + A HUMAN FIXED THIS BY HAND
    1 removed, 1 added.

  R E S U L T  partial
```

Animate the diff: `- AGENT VERSION` fades to 40%, then
`+ A HUMAN FIXED THIS BY HAND` types in at `#e8927f`.

Under it:

```
Your colleague edited that file. Undo stopped.
```

Hold 2s.

---

## SHOT 7 — Close
**1:06 – 1:15**

Everything clears to flat oxblood. The meander runs once, left to right,
across the lower third, at 32% opacity, drawn over 0.8s.

Centred above it — the only centred frame in the film:

```
S Y N A R T E S I S
```

Cormorant beneath, small:

> An undo layer for AI agents

Mono, smaller, last to arrive:

```
$ npm install -g synartesis
synartesis.online
```

Hold 3s on black-free oxblood. End.

---

## Notes for whoever animates this

**The 0.2s / 1.15s pairing is the entire argument.** Destruction is fast and
recovery is fast. If a viewer takes away one thing, it is those two numbers
next to each other. Shots 3 and 4 should feel like a single breath.

**Do not add a voiceover.** The terminal is the voice. Text on screen is
already dense; narration on top of it competes.

**Do not speed-ramp the undo.** The temptation is to make Shot 4 fast and
exciting. It should be calm. The product's claim is that recovery is boring,
and the film should look like that is true.

**Legibility beats fidelity.** If real output does not fit at a readable size
in 1080p, drop whole lines. Never shrink type below 24px on a 1080 frame.

**Resist decorating empty space.** Two shots are mostly empty ground. That is
the design, not a gap to fill.
