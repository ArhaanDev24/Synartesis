#!/usr/bin/env python3
"""Build the Synartesis slide deck PDF.

Twelve 16:9 slides for the Palantir Startup Fellowship application.

Slides are laid out explicitly rather than flowed from markdown, so this
writes the HTML itself instead of borrowing make-pdf's parser. Paged.js is not
needed either: every slide is exactly one page, so Chrome's own pagination is
enough, and the page raises the same data-paged-done flag print-pdf.mjs waits
on so that driver works unchanged.

    python3 docs/build-deck.py
"""

import base64
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OUT = DOCS / "synartesis-deck.pdf"
MARK = ROOT / "brand/synartesis-mark-1080.png"

CSS = """
:root {
  --ground: #5e1420;
  --lift: #7a1c2b;
  --panel: #2c080f;
  --ink: #f6e9e5;
  --ink-soft: #e0c4bf;
  --ink-faint: #b98d84;
  --hit: #e8927f;
  --rule: #8d4550;

  --display: "Cormorant Garamond", Georgia, serif;
  --sans: "IBM Plex Sans", -apple-system, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}

@page { size: 13.333in 7.5in; margin: 0; }

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.slide {
  width: 13.333in;
  height: 7.5in;
  padding: 0.82in 0.95in;
  position: relative;
  overflow: hidden;
  break-after: page;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.slide:last-child { break-after: auto; }

/* Slide number, bottom right. Quiet. */
.slide::after {
  content: attr(data-n);
  position: absolute;
  right: 0.95in;
  bottom: 0.5in;
  font-family: var(--mono);
  font-size: 9pt;
  color: var(--ink-faint);
}

.kicker {
  font-family: var(--mono);
  font-size: 10pt;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-bottom: 0.34in;
}

h1 {
  font-family: var(--display);
  font-weight: 300;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  line-height: 0.98;
  font-size: 54pt;
}

h2 {
  font-family: var(--display);
  font-weight: 300;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  line-height: 1;
  font-size: 34pt;
  margin-bottom: 0.3in;
}

p { font-size: 15pt; line-height: 1.5; max-width: 8.6in; color: var(--ink-soft); }
p + p { margin-top: 0.16in; }
p b, strong { color: var(--ink); font-weight: 600; }

/* Terminal quotations keep the product's real panel colour. */
pre {
  font-family: var(--mono);
  font-size: 11pt;
  line-height: 1.62;
  background: var(--panel);
  color: #f0d3cc;
  padding: 0.26in 0.32in;
  border-left: 3px solid var(--lift);
  white-space: pre;
}
pre .hit { color: var(--hit); }
pre .dim { color: var(--ink-faint); }

.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6in; align-items: center; }
.cols-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5in; }
.four { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.42in; margin-top: 0.1in; }

.card-h {
  font-family: var(--mono);
  font-size: 11pt;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink);
  padding-bottom: 0.1in;
  border-bottom: 1px solid var(--rule);
  margin-bottom: 0.14in;
}
.four p, .cols-3 p { font-size: 12.5pt; line-height: 1.45; }

/* The one number a slide is about, so it has to read as a number. Cormorant
   set 101 as IOI and 1.15s as I.I5S at this size: its figures are too close to
   its capitals to carry a statistic. Mono has unambiguous numerals and is
   already the face the terminals use. */
.stat { font-family: var(--mono); font-weight: 500; font-size: 52pt; letter-spacing: -0.01em; line-height: 1; color: var(--ink); }
.stat-l { font-family: var(--mono); font-size: 10.5pt; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-faint); margin-top: 0.16in; }

ul { list-style: none; }
li { font-size: 15pt; line-height: 1.5; color: var(--ink-soft); padding-left: 0.32in; position: relative; }
li + li { margin-top: 0.13in; }
li::before { content: ""; position: absolute; left: 0; top: 0.13in; width: 0.16in; height: 1px; background: var(--hit); }
li b { color: var(--ink); font-weight: 600; }

.rule { border: 0; border-top: 1px solid var(--rule); margin: 0.3in 0; }

/* --- cover ------------------------------------------------------------ */
.cover { justify-content: space-between; }
.cover-mark { width: 1.5in; height: 1.5in; display: block; }
.wordmark {
  font-family: var(--mono); font-weight: 500; font-size: 25pt;
  letter-spacing: 0.34em; text-transform: uppercase; line-height: 1;
  margin-bottom: 0.22in;
}
.cover p { font-family: var(--display); font-size: 30pt; line-height: 1.1; color: var(--ink-soft); max-width: 7in; }
.cover-foot { font-family: var(--mono); font-size: 10pt; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-faint); line-height: 1.9; }
.cover::after { content: none; }
"""


def slide(n, body, cls=""):
    return f'<section class="slide {cls}" data-n="{n}">{body}</section>'


def build_html() -> str:
    mark = base64.b64encode(MARK.read_bytes()).decode("ascii")

    slides = []

    slides.append(slide(1, f"""
      <img class="cover-mark" src="data:image/png;base64,{mark}" alt="">
      <div>
        <div class="wordmark">Synartesis</div>
        <p>An undo layer<br>for AI agents</p>
      </div>
      <div class="cover-foot">
        Palantir Startup Fellowship &middot; Cohort 003<br>
        Arhaan Khan &middot; Phagwara, Punjab, India
      </div>""", "cover"))

    slides.append(slide(2, """
      <div class="kicker">The problem</div>
      <h1>An agent runs twenty steps<br>and gets step seven wrong</h1>
      <p style="margin-top:0.38in">It has write access to a real system. It misreads one step and
      applies the remaining thirteen to the wrong records. You find out an hour later.</p>"""))

    slides.append(slide(3, """
      <div class="kicker">What you can do today</div>
      <h2>Three bad options</h2>
      <ul>
        <li><b>Reverse it by hand</b> from the transcript, if there is one, and if you can tell
        which of the forty calls were the wrong ones.</li>
        <li><b>Restore a backup</b> and lose every legitimate change anyone made in the same
        window.</li>
        <li><b>Accept the damage.</b></li>
      </ul>
      <hr class="rule">
      <p>Sandboxes do not help: the container is disposable, the CRM row it updated over the
      network is not. Tracing does not help: a log says <b>update_customer</b> ran forty times,
      not what the values were before.</p>"""))

    slides.append(slide(4, """
      <div class="kicker">What it is</div>
      <h2>A proxy that remembers<br>what every call replaced</h2>
      <p>Synartesis sits between an AI client and the servers it calls. Every tool call is
      recorded together with <b>the state that call replaced</b>, and that state can be put
      back: one run, walked backwards, newest call first.</p>
      <p>What cannot be put back, it refuses to let an agent do unsupervised.</p>
      <p style="margin-top:0.26in;color:#b98d84">The agent sees the same tools, the same names, the
      same results. Nothing about how you work changes.</p>"""))

    slides.append(slide(5, """
      <div class="kicker">The model</div>
      <h2>Every tool gets one<br>of four classifications</h2>
      <div class="four">
        <div><div class="card-h">Readonly</div><p>Changes nothing. Recorded, forwarded.</p></div>
        <div><div class="card-h">Reversible</div><p>Prior state read before the write. Written back on undo.</p></div>
        <div><div class="card-h">Compensable</div><p>Cannot be reversed. A second call neutralises it.</p></div>
        <div><div class="card-h">Irreversible</div><p>Neither. Held until a person approves it.</p></div>
      </div>
      <hr class="rule">
      <p>A tool the policy does not name is treated as <b>irreversible</b> and held. Silently
      forwarding an unknown destructive call is the one failure worth avoiding most.</p>"""))

    slides.append(slide(6, """
      <div class="kicker">Proof</div>
      <div class="cols">
        <div>
          <div class="stat">101</div>
          <div class="stat-l">files wrecked in 0.2 seconds</div>
          <div class="stat" style="margin-top:0.4in">1.15s</div>
          <div class="stat-l">to put every one of them back</div>
        </div>
        <div>
          <p style="font-size:14pt">A real agent, through the proxy, against a real 483-file
          open-source repository. 284 lines changed across 101 files.</p>
          <p style="font-size:14pt"><b>synartesis undo</b> restored all of them. <b>git status</b>
          came back clean.</p>
          <p style="font-size:14pt;color:#b98d84">Six concurrent agents in the same journal:
          180 writes, zero errors, integrity check ok.</p>
        </div>
      </div>"""))

    slides.append(slide(7, """
      <div class="kicker">The part that matters</div>
      <h2>It refuses</h2>
      <div class="cols">
        <div>
          <p>Anything can write an old value back. Declining to is the hard part.</p>
          <p>Before undoing a step, Synartesis re-reads the resource and compares it against the
          state that step left behind. If somebody has been there since, <b>it stops</b> and
          shows the lines that differ.</p>
          <p style="color:#b98d84">Undo walks newest first, so whatever it had already put back
          stays put back.</p>
        </div>
<pre>  <span class="hit">halted</span> <span class="dim">at sequence 1</span>  drift detected

<span class="dim">  the resource is not in the</span>
<span class="dim">  state this run left it in.</span>

<span class="dim">    at line 1:</span>
<span class="dim">    - AGENT VERSION</span>
<span class="hit">    + A HUMAN FIXED THIS BY HAND</span>
<span class="dim">    1 removed, 1 added.</span>

  <span class="dim">R E S U L T</span>  <span class="hit">partial</span></pre>
      </div>"""))

    slides.append(slide(8, """
      <div class="kicker">Status</div>
      <h2>Shipped, not a prototype</h2>
      <div class="cols-3">
        <div><div class="card-h">On npm</div><p>v0.3.2, ten releases since 22 August. 1,118 downloads in the last 30 days.</p></div>
        <div><div class="card-h">Tested</div><p>300 tests across macOS and Linux, Node 22 and 24. Every release verified against the registry before tagging.</p></div>
        <div><div class="card-h">Open</div><p>MIT. ~9,900 lines of TypeScript, 130 commits. Four finished policies: filesystem, git, GitHub, memory.</p></div>
      </div>
      <hr class="rule">
      <p>The journal is a secrets-bearing store, so it is created <b>0600</b> in a <b>0700</b>
      directory and re-tightened on every open. <b>synartesis prune</b> is how history stops
      accumulating. Nothing still active or waiting on a person is ever pruned.</p>"""))

    slides.append(slide(9, """
      <div class="kicker">Why Foundry</div>
      <h2>The Ontology is the best<br>substrate this could have</h2>
      <p>Today Synartesis wraps servers whose write semantics it has to <b>infer from a tool
      schema</b>. Foundry is the opposite: Action types are declared, typed and versioned.</p>
      <p>That makes classification and inverse-resolution far more reliable than anything
      possible over generic MCP. And AIP agents already write to the Ontology, which is exactly
      where an agent's mistake is most expensive.</p>
      <p style="color:#b98d84">This is not a port. It is the version of the product with the
      right substrate underneath it.</p>"""))

    slides.append(slide(10, """
      <div class="kicker">What we would build</div>
      <h2>Synartesis for the Ontology</h2>
      <ul>
        <li><b>Ontology &amp; Action Types</b> — Actions are the write primitive, so
        classification and inverse-resolution attach at the Action type level.</li>
        <li><b>OSDK</b> — the read-before-write that captures prior object state, and the
        re-read at rollback that detects a human edit since.</li>
        <li><b>AIP Agent Studio / Logic</b> — where the agent lives. The proxy sits between it
        and its Action tools.</li>
        <li><b>Foundry Functions</b> — server-side resolution of compensating Actions where
        reversal is impossible but offsetting is not.</li>
        <li><b>Datasets</b> — the journal lands as one, so what an agent did and what it
        replaced is queryable alongside everything else.</li>
        <li><b>Manual review on Actions</b> — the approval gate.</li>
      </ul>"""))

    slides.append(slide(11, """
      <div class="kicker">Ten weeks</div>
      <h2>Milestones</h2>
      <div class="cols-3">
        <div><div class="card-h">25% &middot; late Oct</div><p>Foundry-native policy reading Action type metadata. One Action type round-tripped: agent invokes, state captured via OSDK, undo restores. Journal landing as a dataset.</p></div>
        <div><div class="card-h">50% &middot; buildcamp</div><p>All four classes working against Ontology Actions, including drift detection. An approval gate on a real irreversible Action type. Demoable on a live workflow, not a fixture.</p></div>
        <div><div class="card-h">100% &middot; early Dec</div><p>An AIP agent making a run of Ontology writes, one held for approval, the whole run reversed on one command with a human's edits intact.</p></div>
      </div>"""))

    slides.append(slide(12, """
      <div class="kicker">Who</div>
      <h2>Arhaan Khan</h2>
      <p>Self-taught. Solo founder. Phagwara, Punjab, India. Available on IST, able to travel
      self-funded for the in-person events.</p>
      <p>Synartesis is not incorporated and has raised nothing. It exists because I wanted to
      give an agent write access to something I cared about and could not find a way back.</p>
      <hr class="rule">
      <pre style="border-left:0;background:transparent;padding:0;font-size:12pt">synartesis.online
github.com/ArhaanDev24/Synartesis
npm install -g synartesis
linkedin.com/in/arhaankhan143</pre>"""))

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Synartesis &middot; Palantir Startup Fellowship</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>{CSS}</style>
</head>
<body>
{"".join(slides)}
<script>
  // print-pdf.mjs waits on this flag. There is no Paged.js here (one slide is
  // one page, so Chrome's own pagination is enough), so the page raises it
  // itself once the webfonts have actually loaded -- printing before that
  // gives a deck set in Times.
  document.fonts.ready.then(() => {{
    requestAnimationFrame(() => {{
      const de = document.documentElement;
      de.dataset.pages = String(document.querySelectorAll(".slide").length);
      de.dataset.pagedDone = "1";
    }});
  }});
</script>
</body>
</html>"""


def main() -> None:
    if not MARK.exists():
        sys.exit(f"build-deck: the mark is missing at {MARK}")
    staged = pathlib.Path("/tmp/synartesis-deck.html")
    staged.write_text(build_html(), encoding="utf-8")
    result = subprocess.run(
        ["node", str(DOCS / "print-pdf.mjs"), str(staged), str(OUT)],
        check=True, capture_output=True, text=True,
    )
    kb = OUT.stat().st_size // 1024
    print(f"{OUT}  {kb} KB  {result.stdout.strip()}")


if __name__ == "__main__":
    main()
