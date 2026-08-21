/**
 * The house style, translated for a terminal.
 *
 * Electric ultramarine on white, uppercase letterspaced labels, everything
 * quiet except the one thing that matters. A terminal has no serif and no
 * engraving, so what carries over is the palette, the capitals and the
 * restraint.
 */
const ESC = "\u001b[";
const GREEN = `${ESC}38;2;56;205;115m`;
// A bright plate with dark ink on it, so the wordmark holds on a light
// terminal as well as a dark one.
const ON_GREEN = `${ESC}48;2;74;222;128m${ESC}38;2;5;46;22m`;
const BRIGHT = `${ESC}38;2;190;250;215m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const RESET = `${ESC}0m`;

/**
 * Colour is for people. Piped output goes to a program that wants the text and
 * not the escape codes, and NO_COLOR is the convention for saying so outright.
 */
const enabled =
  process.env["NO_COLOR"] === undefined &&
  process.env["TERM"] !== "dumb" &&
  process.stdout.isTTY;

function paint(codes: string, text: string): string {
  return enabled ? `${codes}${text}${RESET}` : text;
}

/**
 * Letterspacing, the one typographic move a terminal can actually make. Only
 * ever applied to the plain ascii labels below, so splitting by code unit is
 * safe here in a way it would not be for arbitrary text.
 */
export function spaced(text: string): string {
  return Array.from(text).join(" ");
}

export const style = {
  /** A section label: small, capital, spaced out. */
  label: (text: string): string => paint(GREEN + DIM, spaced(text.toUpperCase())),
  heading: (text: string): string => paint(BRIGHT + BOLD, text.toUpperCase()),
  accent: (text: string): string => paint(GREEN, text),
  strong: (text: string): string => paint(BOLD, text),
  quiet: (text: string): string => paint(DIM, text),
  /** White on ultramarine, the way the wordmark is set. */
  plate: (text: string): string => paint(ON_GREEN + BOLD, ` ${text} `),
};

export const WORDMARK = spaced("SYNARTESIS");

/**
 * A meander, the Greek fret. A single line that turns back on itself without
 * ever breaking, which is the same idea the name carries and the same idea the
 * product does.
 */
export function meander(width: number): string {
  const unit = "\u2517\u2501\u2513\u250f\u2501\u251b";
  return unit.repeat(Math.max(1, Math.ceil(width / unit.length))).slice(0, width);
}

/** A dim fret rule, for separating one region of output from the next. */
export function rule(width = 48): string {
  return style.quiet(meander(width));
}

/**
 * Greek sunartesis, a fastening together. The whole idea in one word: every
 * action is bound to the action that undoes it.
 */
export const GREEK = spaced("\u03a3\u03a5\u039d\u0391\u03a1\u03a4\u0397\u03a3\u0399\u03a3");
export const MEANING = "a fastening together";
export const TAGLINE = "an undo layer for AI agents";

export function banner(): string {
  return [
    "",
    `  ${style.plate(WORDMARK)}`,
    `  ${style.accent(meander(24))}`,
    "",
    `  ${style.quiet(GREEK)}  ${style.quiet("\u00b7")}  ${style.quiet(MEANING)}`,
    "",
    `  ${style.accent(spaced(TAGLINE.toUpperCase()))}`,
    `  ${style.quiet("Every action is bound to the action that undoes it.")}`,
    "",
  ].join("\n");
}
