#!/usr/bin/env python3
"""Build the Synartesis user guide PDF.

make-pdf parses the markdown well but its styling is fixed: Helvetica, black on
white, no way in. So this keeps its parser and throws away its stylesheet,
wrapping the parsed body in the identity the rest of the project already uses,
and lets Paged.js do the pagination that Chrome alone cannot (page counters in
margin boxes, a full-bleed first page).

The palette is the site's, adapted for paper. A twenty-six page document on the
site's oxblood ground would be unreadable and unprintable, so the ground becomes
the accent: oxblood headings and rules on warm paper, with the terminal blocks
kept at their true panel colour because those are quotations of a screen.

    python3 docs/build-pdf.py
"""

import base64
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
MD = DOCS / "synartesis-user-guide.md"
OUT = DOCS / "synartesis-user-guide.pdf"

# Kept out of the repo: paged.js is 500kB of vendor code this only needs at
# build time, and the PDF it produces is what ships.
BUILD = pathlib.Path(tempfile.gettempdir()) / "synartesis-pdf-build"
PAGED = BUILD / "node_modules/pagedjs/dist/paged.polyfill.min.js"
MAKE_PDF = pathlib.Path.home() / ".claude/skills/gstack/make-pdf/dist/pdf"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

MARK = ROOT / "brand/synartesis-mark-1080.png"

CSS = """
:root {
  --oxblood: #5e1420;
  --oxblood-soft: #7a1c2b;
  --panel: #2c080f;
  --panel-ink: #f0d3cc;
  --panel-faint: #b98d84;
  --panel-hit: #e8927f;
  --paper: #ffffff;
  --ink: #1a1012;
  --ink-soft: #4a3a3d;
  --ink-faint: #8a7478;
  --rule: #e3d6d6;

  --display: "Cormorant Garamond", Georgia, serif;
  --sans: "IBM Plex Sans", -apple-system, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}

@page {
  size: letter;
  margin: 17mm 18mm 15mm;

  @bottom-left {
    /* Literal glyphs, not CSS escapes: "\\00a9 2026" eats the space after the
       escape as its terminator and sets "\u00a92026". */
    content: "\u00a9 2026 Synartesis \u00b7 Arhaan Khan";
    font-family: var(--mono);
    font-size: 7pt;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #8a7478;
    padding-bottom: 4mm;
  }
  @bottom-right {
    content: counter(page);
    font-family: var(--mono);
    font-size: 8pt;
    color: #5e1420;
    padding-bottom: 4mm;
  }
}

/* The cover is its own world: no margin, no furniture. */
@page cover {
  margin: 0;
  @bottom-left { content: none; }
  @bottom-right { content: none; }
}

* { box-sizing: border-box; }

body {
  font-family: var(--sans);
  font-size: 9.4pt;
  line-height: 1.5;
  color: var(--ink);
  background: var(--paper);
  margin: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* --- cover ------------------------------------------------------------- */

.cover {
  page: cover;
  break-after: page;
  background: var(--oxblood);
  color: #f6e9e5;
  height: 279.4mm;
  width: 215.9mm;
  padding: 30mm 26mm;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.cover-mark { width: 46mm; height: 46mm; display: block; }

/* The generic h1 below is oxblood with an oxblood rule under it, which on this
   ground is an invisible title above an invisible line. Everything it sets has
   to be undone here. */
.cover-title {
  font-family: var(--mono);
  font-weight: 500;
  font-size: 26pt;
  letter-spacing: 0.34em;
  line-height: 1;
  text-transform: uppercase;
  color: #f6e9e5;
  border-bottom: 0;
  padding-bottom: 0;
  margin: 0 0 7mm;
}

.cover-tagline {
  font-family: var(--display);
  font-weight: 300;
  font-size: 22pt;
  line-height: 1.15;
  color: #e8d3ce;
  margin: 0 0 10mm;
}

.cover-rule { border: 0; border-top: 1px solid rgba(246, 233, 229, 0.42); margin: 0 0 8mm; width: 62mm; }

.cover-note {
  font-family: var(--mono);
  font-size: 8.5pt;
  line-height: 1.85;
  color: #d3aaa2;
}

.cover-note b { color: #f6e9e5; font-weight: 500; }

.cover-foot {
  font-family: var(--mono);
  font-size: 7.5pt;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #c09189;
}

/* --- chapters ---------------------------------------------------------- */

.chapter { break-before: page; }
.chapter:first-of-type { break-before: avoid; }

h1 {
  font-family: var(--display);
  font-weight: 400;
  font-size: 22pt;
  line-height: 1.04;
  letter-spacing: 0.01em;
  color: var(--oxblood);
  margin: 0 0 5mm;
  padding-bottom: 3mm;
  border-bottom: 2px solid var(--oxblood);
  break-after: avoid;
}

h2 {
  font-family: var(--mono);
  font-weight: 500;
  font-size: 10pt;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--oxblood);
  margin: 6.5mm 0 2.4mm;
  break-after: avoid;
}

h3 {
  font-family: var(--sans);
  font-weight: 600;
  font-size: 10.5pt;
  color: var(--ink);
  margin: 4.5mm 0 1.6mm;
  break-after: avoid;
}

p { margin: 0 0 2.7mm; orphans: 2; widows: 2; }

a { color: var(--oxblood); text-decoration: none; border-bottom: 1px solid var(--rule); }

strong { font-weight: 600; color: var(--ink); }

hr { border: 0; border-top: 1px solid var(--rule); margin: 5mm 0; }

/* --- lists ------------------------------------------------------------- */

ul, ol { margin: 0 0 2.7mm; padding-left: 5mm; }
li { margin-bottom: 1.4mm; }
li::marker { color: var(--oxblood); }

/* --- code -------------------------------------------------------------- */

/* Inline code is a name, not a screen: tinted, not inverted. */
:not(pre) > code {
  font-family: var(--mono);
  font-size: 0.88em;
  background: #f4ebe9;
  color: #6d1a26;
  padding: 0.1em 0.36em;
  border-radius: 2px;
}

/* A block is a quotation of a terminal, so it keeps the terminal's colours. */
pre {
  font-family: var(--mono);
  font-size: 7.4pt;
  line-height: 1.5;
  background: var(--panel);
  color: var(--panel-ink);
  padding: 3mm 4mm;
  margin: 0 0 3.4mm;
  white-space: pre-wrap;
  word-break: break-word;
  border-left: 3px solid var(--oxblood-soft);
  break-inside: avoid;
}

pre code { font-family: inherit; font-size: inherit; background: none; color: inherit; padding: 0; }

/* --- tables ------------------------------------------------------------ */

table {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 4mm;
  font-size: 8.4pt;
  break-inside: avoid;
}

th {
  font-family: var(--mono);
  font-size: 7.5pt;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  text-align: left;
  color: var(--oxblood);
  border-bottom: 1.5px solid var(--oxblood);
  padding: 2mm 3mm 2mm 0;
}

td {
  padding: 1.7mm 3mm 1.7mm 0;
  border-bottom: 1px solid var(--rule);
  vertical-align: top;
  color: var(--ink-soft);
}

td:first-child { color: var(--ink); }
td code, th code { font-size: 0.9em; }

/* --- closing colophon -------------------------------------------------- */

.colophon {
  margin-top: 10mm;
  padding-top: 5mm;
  border-top: 2px solid var(--oxblood);
  font-family: var(--mono);
  font-size: 8pt;
  line-height: 1.9;
  color: var(--ink-faint);
  break-inside: avoid;
}

.colophon b { color: var(--oxblood); font-weight: 500; }
"""


def die(message: str) -> None:
    sys.exit(f"build-pdf: {message}")


def ensure_pagedjs() -> None:
    """Fetch paged.js on first run, so this works on a fresh clone."""
    if PAGED.exists():
        return
    BUILD.mkdir(parents=True, exist_ok=True)
    print(f"fetching paged.js into {BUILD} ...", file=sys.stderr)
    subprocess.run(
        ["npm", "install", "pagedjs", "--no-fund", "--no-audit", "--silent"],
        cwd=BUILD,
        check=True,
    )
    if not PAGED.exists():
        die("npm install pagedjs did not produce the polyfill")


def main() -> None:
    for path, what in ((MD, "the guide"), (MARK, "the mark"), (MAKE_PDF, "make-pdf")):
        if not path.exists():
            die(f"{what} is missing at {path}")
    ensure_pagedjs()

    # make-pdf for the markdown parsing, and nothing else.
    tmp_html = BUILD / "parsed.html"
    subprocess.run(
        [str(MAKE_PDF), "generate", str(MD), str(tmp_html), "--to", "html", "--quiet"],
        check=True,
        cwd=ROOT,
    )
    parsed = tmp_html.read_text(encoding="utf-8")

    body = re.search(r"<body[^>]*>(.*)</body>", parsed, re.S)
    if body is None:
        die("could not find a body in the parsed html")
    content = body.group(1)

    # Its first section is the markdown's own title block, which the cover says
    # better. Drop it rather than say it twice.
    content = re.sub(
        r"^\s*<section class=\"chapter\"><h1>Synartesis</h1>.*?</section>",
        "",
        content,
        count=1,
        flags=re.S,
    )

    mark = base64.b64encode(MARK.read_bytes()).decode("ascii")

    # Inlined, not linked. Chrome refuses a file:// subresource from a file://
    # page, so a <script src> pointing at node_modules loads in a normal browser
    # and silently does nothing under --print-to-pdf -- which prints the
    # unpaginated document and looks like a Paged.js bug rather than a blocked
    # request.
    paged = PAGED.read_text(encoding="utf-8")

    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Synartesis · User Guide</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>{CSS}</style>
</head>
<body>

<section class="cover">
  <img class="cover-mark" src="data:image/png;base64,{mark}" alt="">
  <div>
    <h1 class="cover-title">Synartesis</h1>
    <p class="cover-tagline">An undo layer<br>for AI agents</p>
    <hr class="cover-rule">
    <p class="cover-note">
      A user guide, from install to undo.<br>
      Version <b>0.3.2</b> · September 2026
    </p>
  </div>
  <p class="cover-foot">
    &copy; 2026 Synartesis · Arhaan Khan<br>
    www.linkedin.com/in/arhaankhan143
  </p>
</section>

{content}

<script>
  window.PagedConfig = {{
    auto: true,
    after() {{ document.documentElement.dataset.pagedDone = "1"; }},
  }};
</script>
<script>{paged}</script>
</body>
</html>"""

    staged = BUILD / "guide.html"
    staged.write_text(html, encoding="utf-8")

    # Not --print-to-pdf: it snapshots before Paged.js has finished, and a
    # larger --virtual-time-budget snapshots earlier still. The driver waits for
    # the document to say it is paginated.
    result = subprocess.run(
        ["node", str(DOCS / "print-pdf.mjs"), str(staged), str(OUT)],
        check=True,
        capture_output=True,
        text=True,
    )

    print(f"{OUT}  {OUT.stat().st_size // 1024} KB  {result.stdout.strip()}")


if __name__ == "__main__":
    main()
