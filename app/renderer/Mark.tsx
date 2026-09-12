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
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <g className="mark-turn">
        <circle
          cx="16"
          cy="16"
          r="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeDasharray="41 16"
          transform="rotate(-58 16 16)"
        />
        <path d="M19.2 3.6l4.6 5.2-6.6 2.2z" fill="currentColor" />
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
export function Fret({ tall = false }: { tall?: boolean }): React.JSX.Element {
  return <div className="fret" data-tall={tall} aria-hidden="true" />;
}
