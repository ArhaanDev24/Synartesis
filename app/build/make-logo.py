"""
Draw the mark, once, so the icon and the window cannot disagree about it.

The glyph is a circle that does not close with an arrow coming back round it,
drawn as a fan of fine straight lines rather than as a stroke. Two things make
it look the way it does rather than like a plain band:

  - the inner edge is a true circle, because every line starts on one, so the
    counter of the C stays clean and readable at any size;
  - the outer edge is not, because each line's length rides a slow wave around
    the sweep. That is what produces the lobes and the fringe of spikes. A
    constant outer radius gives a washer, which is what this was before.

The frame is a ring of meander tiles set outside a thin square, corners left
empty -- one line turning back on itself without ever breaking, which is
roughly what the name means.

Writes two files and is the only thing that should ever edit either:
  app/renderer/logo-art.ts   strokes and frame, for the window
  app/build/icon.html        the application icon
"""
import math

SIZE = 1024
CX, CY = 512.0, 512.0

# Angles are screen angles: 0 is three o'clock and they increase clockwise,
# because y runs down. The opening faces right, and the sweep runs the other
# way round so it finishes at the lower right -- where the arrow is, and why
# it reads as coming back rather than going on.
START = math.radians(310.0)
END = math.radians(56.0)
FORWARD = -1.0 if END < START else 1.0

R_IN = 152.0            # the counter, a true circle
R_OUT = 236.0           # the outer edge of the body, also a true circle

LINES = 560
TWIST = 0.30            # radians the outer end leads the inner end by
SETTLE = 0.08           # the stretch before the arrow where the lean fades

# The fringe: fine hairs standing off the outer edge, their length riding a
# slow wave so the silhouette scallops. Kept separate from the body on
# purpose -- letting the wave move the body's own edge turns the crescent
# into a lump, which is what it did when they were one fan.
HAIRS = 460
REACH = 0.26            # how far a hair reaches out, at the crest of the wave
LOBES = 6.0             # crests around the sweep
PHASE = 0.9
HAIR_TWIST = -0.16


def at(radius: float, angle: float):
    return (CX + radius * math.cos(angle), CY + radius * math.sin(angle))


def fan(count: int, inner, outer, twist: float):
    """
    One sweep of lines, each from an inner radius to an outer one.

    The lean is what makes it feather: every line is a chord rather than a
    spoke, so the crowding forms caustics instead of a flat fill. It fades to
    nothing over the last stretch before the arrow, because a fan still
    leaning when it arrives throws hairlines past the arrowhead, and they read
    as a fray rather than as a point.
    """
    out = []
    for index in range(count):
        along = index / (count - 1)
        angle = START + (END - START) * along
        lean = twist * min(1.0, (1.0 - along) / SETTLE)
        x1, y1 = at(inner(angle), angle)
        x2, y2 = at(outer(angle), angle + lean)
        out.append((x1, y1, x2, y2))
    return out


def body():
    """The crescent: a clean band between two true circles."""
    return fan(LINES, lambda _a: R_IN, lambda _a: R_OUT, TWIST)


def fringe():
    """The hairs standing off it, as long as the wave says."""
    crest = lambda a: R_OUT * (1.0 + REACH * (0.5 + 0.5 * math.sin(LOBES * a + PHASE)))
    return fan(HAIRS, lambda _a: R_OUT * 0.90, crest, HAIR_TWIST)


def arrowhead() -> str:
    """
    Solid, at the end of the sweep, pointing the way the sweep was going.

    The one filled shape in the mark, and the whole reason it reads as coming
    back round rather than as a letter -- so it has to survive at sixteen
    pixels, where every hairline has already gone.
    """
    tip = at((R_IN + R_OUT) / 2, END + FORWARD * 0.30)
    points = [tip, at(R_IN - 26, END), at(R_OUT + 22, END)]
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in points)


# --- the frame ------------------------------------------------------------

FRAME = 208.0                     # the thin square's inset from the edge
GAP = 16.0                        # between the square and the ring of tiles
PER_SIDE = 8
SQUARE = SIZE - 2 * FRAME
TILE = SQUARE / PER_SIDE

#: One meander, drawn in a unit box and scaled into place.
KEY = "M0.17 0.80 V0.22 H0.80 V0.62 H0.44 V0.44 H0.60"


def tiles():
    """
    Meanders set outside the square on all four sides, corners left empty.

    Empty corners on purpose: a tile in the corner belongs to both runs and
    reads as a mistake in whichever one you follow.
    """
    out = []
    for step in range(PER_SIDE):
        near = FRAME + step * TILE
        out.append((near, FRAME - GAP - TILE))          # above
        out.append((near, SIZE - FRAME + GAP))          # below
        out.append((FRAME - GAP - TILE, near))          # left
        out.append((SIZE - FRAME + GAP, near))          # right
    return out


def frame_svg(stroke: str, width: float, opacity: float) -> str:
    parts = [
        f'<rect x="{FRAME:.0f}" y="{FRAME:.0f}" width="{SQUARE:.0f}" height="{SQUARE:.0f}" '
        f'fill="none" stroke="{stroke}" stroke-width="{width:.1f}" opacity="{opacity}" />'
    ]
    for x, y in tiles():
        parts.append(
            f'<path d="{KEY}" transform="translate({x:.1f} {y:.1f}) scale({TILE:.2f})" '
            f'fill="none" stroke="{stroke}" stroke-width="{width / TILE:.4f}" '
            f'opacity="{opacity}" />'
        )
    return "\n      ".join(parts)


def ts() -> str:
    rows = ",\n".join(
        f"  [{x1:.1f}, {y1:.1f}, {x2:.1f}, {y2:.1f}]" for x1, y1, x2, y2 in body()
    )
    hairs = ",\n".join(
        f"  [{x1:.1f}, {y1:.1f}, {x2:.1f}, {y2:.1f}]" for x1, y1, x2, y2 in fringe()
    )
    places = ",\n".join(f"  [{x:.1f}, {y:.1f}]" for x, y in tiles())
    return f'''/**
 * The mark, as line segments in a 0-{SIZE} box.
 *
 * GENERATED by app/build/make-logo.py. Edit that, not this.
 *
 * Coordinates rather than a path so the window and the application icon are
 * drawn from the same numbers; a logo that is traced twice is a logo that
 * drifts.
 */

/** x1, y1, x2, y2. */
export type Stroke = readonly [number, number, number, number];

export const BOX = {SIZE};

export const ARROWHEAD = "{arrowhead()}";

/** The thin square the meanders are set around. */
export const SQUARE = {{ at: {FRAME:.0f}, side: {SQUARE:.0f} }};

/** One meander, in a unit box, to be translated and scaled into place. */
export const KEY = "{KEY}";

export const TILE = {TILE:.2f};

/** Where each meander goes. Corners are left empty on purpose. */
export const TILES: readonly (readonly [number, number])[] = [
{places},
];

export const STROKES: readonly Stroke[] = [
{rows},
];

/** The hairs standing off the outer edge. Drawn lighter than the body. */
export const FRINGE: readonly Stroke[] = [
{hairs},
];
'''


def icon_html() -> str:
    lines = "\n".join(
        f'        <line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" />'
        for x1, y1, x2, y2 in body()
    )
    hairs = "\n".join(
        f'        <line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" />'
        for x1, y1, x2, y2 in fringe()
    )
    return f'''<!doctype html>
<meta charset="utf-8" />
<style>
  html, body {{ margin: 0; background: transparent; }}
  svg {{ display: block; }}
</style>
<!-- GENERATED by app/build/make-logo.py. Edit that, not this. -->
<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6b1725" />
      <stop offset="1" stop-color="#460e18" />
    </linearGradient>
  </defs>

  <!-- macOS insets its icons; 100 of 1024 a side is the usual ratio. -->
  <rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="url(#ground)" />

  <!-- The whole mark, pulled in so the ring of meanders clears the corners. -->
  <g transform="translate(512 512) scale(0.70) translate(-512 -512)">
      {frame_svg("#f6e9e5", 5.0, 0.55)}
    <g transform="translate(512 512) scale(0.80) translate(-512 -512)">
      <g stroke="#f6e9e5" stroke-width="1.2" opacity="0.34" fill="none" stroke-linecap="round">
{hairs}
      </g>
      <g stroke="#f6e9e5" stroke-width="1.7" opacity="0.55" fill="none" stroke-linecap="round">
{lines}
      </g>
      <polygon points="{arrowhead()}" fill="#f6e9e5" />
    </g>
  </g>
</svg>
'''


open("app/renderer/logo-art.ts", "w").write(ts())
open("app/build/icon.html", "w").write(icon_html())
print("logo-art.ts and icon.html written")
