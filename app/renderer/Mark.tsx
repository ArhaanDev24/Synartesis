import logo from "./logo.png";
import logoWhite from "./logo-white.png";

/**
 * The mark: a circle that does not quite close, and an arrow going back round.
 *
 * One file, shown rather than drawn. It used to be drawn here from generated
 * coordinates, which is a reasonable thing to do right up until the drawing
 * and the logo are no longer the same object -- and by then there were three
 * of them, each nearly right. `logo.png` is the logo; this shows it small and
 * `Logo` shows it large, and neither has an opinion of its own.
 *
 * While a turn is running it breathes: it swells and settles on an eased two
 * and a half seconds, which reads as something working rather than something
 * loading. It used to spin, which stopped making sense the moment the mark
 * acquired a frame -- a border going round and round reads as a fault.
 */
export function Mark({
  working = false,
  size = 22,
}: {
  working?: boolean;
  size?: number;
}): React.JSX.Element {
  return (
    <img
      className="mark"
      data-working={working}
      src={logo}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

/**
 * The mark, large.
 *
 * The same file as `Mark`, at a size where the fringe and the frame are
 * legible. It was drawn here from the generated coordinates until the drawing
 * and the picture of the drawing stopped being the same thing in anybody's
 * mind but mine -- so there is one logo now, it is a file, and both of these
 * show it.
 *
 * One glyph, two weights, chosen by size. At twenty-two pixels five hundred
 * hairlines are a smudge, so `Mark` fills the same band instead of combing
 * it; at two hundred the comb is the whole point. Both are generated from the
 * same two circles and the same arrow as the application icon, so there is
 * one mark here rather than a family of things that resemble each other.
 */
export function Logo({
  size = 200,
  white = false,
}: {
  size?: number;
  /** The same artwork on a pale ground, for a page that is already pale. */
  white?: boolean;
}): React.JSX.Element {
  return (
    <img
      className="logo"
      src={white ? logoWhite : logo}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
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
