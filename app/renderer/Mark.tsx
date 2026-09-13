import { ARROWHEAD, BOX, FRINGE, KEY, SOLID, SQUARE, STROKES, TILE, TILES } from "./logo-art.js";

/**
 * The mark: a circle that does not quite close, and an arrow going back round.
 *
 * The same glyph as the site's favicon, drawn rather than fetched so it can
 * take the ink colour of wherever it is put and move when there is something
 * to move about. `currentColor` throughout for that reason.
 *
 * While a turn is running it goes round, slowly and unevenly -- it eases into
 * each revolution rather than sweeping at a constant rate, which reads as
 * something working rather than something loading. The two are different
 * feelings and a spinner only ever gives you the second.
 */
export function Mark({
  working = false,
  size = 22,
}: {
  working?: boolean;
  size?: number;
}): React.JSX.Element {
  return (
    <svg
      className="mark"
      data-working={working}
      viewBox={`0 0 ${String(BOX)} ${String(BOX)}`}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <g className="mark-turn">
        {/* Pulled up to fill its box: the glyph is generated at the size that
            sits inside the meander frame, which on its own is far too timid. */}
        <g transform="translate(512 512) scale(1.72) translate(-512 -512)">
          <path d={SOLID} fill="currentColor" />
          <polygon points={ARROWHEAD} fill="currentColor" />
        </g>
      </g>
    </svg>
  );
}

/**
 * The mark at full detail: the same glyph drawn as a fan of fine lines.
 *
 * One glyph, two weights, chosen by size. At twenty-two pixels five hundred
 * hairlines are a smudge, so `Mark` fills the same band instead of combing
 * it; at two hundred the comb is the whole point. Both are generated from the
 * same two circles and the same arrow as the application icon, so there is
 * one mark here rather than a family of things that resemble each other.
 */
export function Logo({
  size = 200,
  framed = false,
}: {
  size?: number;
  framed?: boolean;
}): React.JSX.Element {
  return (
    <svg
      className="logo"
      viewBox={`0 0 ${String(BOX)} ${String(BOX)}`}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {framed ? (
        <g fill="none" stroke="currentColor" opacity="0.45">
          <rect
            x={SQUARE.at}
            y={SQUARE.at}
            width={SQUARE.side}
            height={SQUARE.side}
            strokeWidth="4"
          />
          {TILES.map(([x, y], at) => (
            <path
              key={at}
              d={KEY}
              transform={`translate(${String(x)} ${String(y)}) scale(${String(TILE)})`}
              strokeWidth={5 / TILE}
            />
          ))}
        </g>
      ) : null}
      <g transform={framed ? "translate(512 512) scale(0.62) translate(-512 -512)" : ""}>
        {/* The hairs first and lighter, so the crescent sits on top of them
            rather than being lost in them. */}
        <g stroke="currentColor" strokeWidth="1.4" fill="none" opacity="0.3">
          {FRINGE.map(([x1, y1, x2, y2], at) => (
            <line key={at} x1={x1} y1={y1} x2={x2} y2={y2} />
          ))}
        </g>
        <g stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.5">
          {STROKES.map(([x1, y1, x2, y2], at) => (
            <line key={at} x1={x1} y1={y1} x2={x2} y2={y2} />
          ))}
        </g>
        <polygon points={ARROWHEAD} fill="currentColor" />
      </g>
    </svg>
  );
}

/**
 * A meander: one line that turns back on itself without ever breaking.
 *
 * Which is the name, more or less -- and the reason it is here rather than a
 * plain rule. It divides rather than decorates, and it is the one place the
 * palette is allowed to go properly pale, because a page that is oxblood from
 * edge to edge has nothing for the eye to rest against.
 */
export function Fret(): React.JSX.Element {
  return <div className="fret" aria-hidden="true" />;
}

/**
 * A pin, and a cross, drawn rather than imported.
 *
 * Two glyphs is not worth an icon font, and an icon font is not worth a
 * network the page is not allowed to have. They take the ink of wherever they
 * are put, like everything else here.
 */
export function Pin({ filled = false }: { filled?: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M9.6 1.6 14.4 6.4 12 7.1 9.6 9.5l.5 2.6-1.4 1L3.4 8l1-1.4 2.6.5L9.4 4.7z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6.2 9.8 2.4 13.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function Cross(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M4 4 12 12 M12 4 4 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
