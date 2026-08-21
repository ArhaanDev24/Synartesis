/**
 * The house style, translated for a terminal.
 *
 * Electric ultramarine on white, uppercase letterspaced labels, everything
 * quiet except the one thing that matters. A terminal has no serif and no
 * engraving, so what carries over is the palette, the capitals and the
 * restraint.
 */
const ESC = "\u001b[";
const BLUE = `${ESC}38;2;90;90;255m`;
const ON_BLUE = `${ESC}48;2;0;0;242m${ESC}38;2;245;245;245m`;
const WHITE = `${ESC}38;2;245;245;245m`;
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
  label: (text: string): string => paint(BLUE + DIM, spaced(text.toUpperCase())),
  heading: (text: string): string => paint(WHITE + BOLD, text.toUpperCase()),
  accent: (text: string): string => paint(BLUE, text),
  strong: (text: string): string => paint(BOLD, text),
  quiet: (text: string): string => paint(DIM, text),
  /** White on ultramarine, the way the wordmark is set. */
  plate: (text: string): string => paint(ON_BLUE + BOLD, ` ${text} `),
};

export const WORDMARK = spaced("SYNARTESIS");

/**
 * Greek sunartesis, a fastening together. The whole idea in one word: every
 * action is bound to the action that undoes it.
 */
export const MEANING = "Greek sunartesis: a fastening together";
export const TAGLINE = "an undo layer for AI agents";

export function banner(): string {
  return [
    "",
    `  ${style.plate(WORDMARK)}`,
    "",
    `  ${style.accent(spaced(TAGLINE.toUpperCase()))}`,
    `  ${style.quiet(MEANING + ". Every action is bound to the action that undoes it.")}`,
    "",
  ].join("\n");
}
