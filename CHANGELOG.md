# Changelog

What changed, and why it mattered. Dates are release dates.

## 0.9.2 — 2026-09-24

For someone who has never used a terminal. Every screen was walked through as a
new user would meet it, in a real terminal, from a fresh machine. Each place
they would have got stuck is fixed.

### Added

- **`synartesis clean`**: one command, no questions to answer first. It clears
  every finished session with nothing left to undo, and closes sessions left
  open by an app that has since exited. It keeps anything you could still undo,
  anything waiting for you, and anything whose outcome is unknown. Your
  connected apps and your policy are not touched. It shows what it will do and
  asks once. On a journal three weeks old it cleared 119 of 126 sessions.
  `list` suggests it once there is clutter worth clearing.
- Sessions now record which process opened them, so one left open by an app
  that crashed or was force-quit can be told apart from one still in use.

### Fixed

- **The first screen was a dead end.** `synartesis` on a fresh machine said
  "point your client at it" and accepted no keys. It now opens on the AI apps
  found and their tools: `a` covers all of them, `enter` covers one. When the
  first session arrives it switches to the sessions by itself.
- **`watch` ignored keys.** With nothing waiting it showed no keys at all, not
  even how to quit, and silently swallowed every key pressed. It always shows
  its keys now, says so when there is nothing to approve yet, and answers a key
  that does nothing instead of ignoring it. The console does the same.
- **Opening `synartesis` because of a notification landed on the wrong
  screen.** Approving was a screen away, behind a key labelled "held", so `a`
  did nothing. It opens on the waiting call now, shows why it was held, and
  flags new ones from any other screen.
- **The notification said to type an approve command** with an id and an
  absolute path, cut off before its end. It now says to open a terminal and run
  `synartesis`.
- After covering apps from the screen, it names which apps to quit and reopen,
  and says why any server was not covered. It used to say "see the reasons
  above" on a screen with nothing above.
- The proxy wrote a routine schema note into the client's log as a warning, once
  per tool on every start (fourteen for the filesystem server). It is debug
  level now.

### Docs

- The README's Install section is three steps for somebody who has never used a
  terminal, then what to do when something needs your OK, how to undo, how to
  clean up, and how to take it all out.

## 0.9.1 — 2026-09-24

This release attacks undo instead of describing it. The new tests generate the
agent sessions rather than script them, kill undo with SIGKILL partway through,
and race several agents against one approval. They found five bugs that no
hand-written scenario had reached.

### Fixed

- **An undo that succeeded could be stuck for good.** A server that applies an
  inverse and then fails before answering (a crashed handler, a gateway timeout)
  was read as having refused it. The next attempt found the resource already put
  back, called that drift, and every attempt after that refused on it. Undo now
  reads the resource when an inverse errors, and counts it as done when the
  resource is where that inverse puts it.
- **An undo killed at the wrong moment could block that action for ever.**
  Claiming an action and recording which process holds it were two separate
  writes, though the code's own comment said they were one transaction. A kill
  between them left an action claimed by nobody, which no later undo could tell
  from one still in progress. They are now one transaction.
- **An undo killed while compensating stopped on its own success.** The delete
  that undoes a create went through, and the resumed undo called the record's
  absence drift. It now recognises it, but only when the owner is certainly
  gone and the record is certainly gone. An edit a person made instead still
  stops it.
- **Running `install` from your home directory covered servers twice.** There,
  a client's project config and its global one are the same file. It was listed
  twice, and every server in it was drafted into the policy a second time under
  another name.
- **"Covered, nothing through it yet" about a server in daily use.** The connect
  screen looked up the last use under the client entry's name, not the name the
  policy gives the server, and those differ when two clients list a server with
  the same name.
- **A policy reading a field every object inherits** (`constructor`,
  `toString`) resolved to nothing when the record lacked it, instead of saying
  it was absent. The inverse then quietly left that field out of what it
  restored.

### Faster

- **Servers start together.** Every path that starts more than one server
  (a proxy serving several, `undo`, `check`, `pin`) waited for each before
  starting the next. Three servers that take 800 ms each answered after 2.9 s;
  now it is under 1.6 s, and the order they are reported in is unchanged.
- **Each server's tools are listed once at start-up**, not three times.

### Tests

- `tests/stress-undo.test.ts`: random sessions with awkward values (unicode,
  5,000-character strings, `__proto__`, text that looks like a template), undone
  through injected crashes before and after writes, undone to random steps, and
  with a person's edit that must survive.
- `tests/kill-undo.test.ts`: `synartesis undo` killed with SIGKILL the moment a
  random number of actions have been undone, again and again, with a real server
  and store.
- `tests/race-approval.test.ts`: eight separate agent processes retrying one
  approved email in the same instant. Exactly one is sent.
- Direct tests for the code only child processes reached before: which clients
  are covered, the environment an undo starts a server with, and the Linux
  notifier.
- `pnpm stress` runs all three at full strength; `pnpm coverage` reports what
  the suite reaches.

## 0.9.0 — 2026-09-24

0.8.4 to 0.8.8 made Synartesis correct once you were using it. This release is
about the part before and around that: connecting what you already have without
breaking it, and being asked less once you have. Several bugs made someone who
followed the instructions worse off than someone who never installed it. Those
come first.

### Fixed: wrapping a server no longer breaks it

- **Wrapping a server dropped its API keys.** `install` copied the client
  entry's `env` onto the proxy's entry, and the proxy then started the real
  server with almost none of it. Every server now starts through one path,
  with the environment it was given. Existing installs are fixed without
  re-running anything.
- **`undo` could not authenticate, and in one case undid the wrong store.** It
  started servers with only what the policy declared, so a token held in the
  client config was missing. For the memory server that was silent: without
  `MEMORY_FILE_PATH` it opened its default file, sent the inverse there, and
  reported success. `undo` now reads the environment and working directory from
  the client entry that wraps the server. Each session records a keyed
  fingerprint of every declared variable, never the value, and an undo whose
  variables differ refuses and names them.
- **One server's missing token was everybody's problem.** `${VAR}` in a policy
  was expanded for every server when the file was read, so undoing a filesystem
  session failed unless the GitHub token was exported. It is expanded per
  server, when that server starts.
- **A server update took GitHub down.** github-mcp-server 1.12.2 renamed the
  tools the shipped policy read from, and the proxy refused to start. A rule
  whose snapshot, inverse or verify tool has gone now falls back to being held,
  and the proxy starts and says which rules it disabled. `check` still fails
  hard. `github.yaml` is rewritten for 1.12.
- **`install` covers what it says.** It reads every Claude Code project, not
  only the one it was run from (Claude Code's default scope is per project).
  Running it again after `uninstall` covers the same server again instead of
  duplicating it and then dropping it. Skip reasons are printed whole, where
  "Please set SLACK_BOT_TOKEN" used to be cut off. It will not rewrite a Codex
  table it could not fully read. `installed.json`, which holds the original
  entries and their tokens, is now owner-only.
- **Bare `undo` and `show` skip empty sessions.** Most sessions record nothing;
  bare `undo` refused on the empty one instead of finding the one with work.

### Added: cover more of what people connect

- **Browsers.** Policies for Playwright MCP and Chrome DevTools MCP, written
  from each server's real tool list. Reads are reads. Every interaction is
  recorded, arguments included, and not held: nothing a browser does can be
  undone, and holding every click made both unusable. Running agent-written
  code and uploading files are still held.
- **A tool its server marks read-only is read as a read** when no rule mentions
  it, instead of held. The MCP specification calls annotations untrusted unless
  they come from a trusted server; the trust relied on is that you chose to
  connect this one. It only ever loosens a hold on a read. It never applies on a
  pinned server, `trust_annotations: false` turns it off, and `check` lists
  every tool let through this way.
- **Hosted servers.** A server with a token in its headers is reached directly:
  Streamable HTTP, falling back to SSE only where the server says it does not
  speak the newer one, with redirects refused. `install` moves the header values
  into the client entry's `env`, and the policy names the variables. A request
  refused at the door, such as an expired token, is recorded as never sent. A
  server that signs in through a browser is covered with `install --remote`,
  through mcp-remote, which keeps the sign-in itself.
- **Four more clients:** Gemini CLI, GitHub Copilot CLI, Antigravity, and
  Devin Desktop (what Windsurf became) plus the older Windsurf path. Every path
  and variable syntax was checked against the vendor's own documentation.
- **Read-only policies** for fetch, Brave Search, Exa, Tavily and the AWS
  documentation server. Each server was started and its tool list read first.

### Added: ask less, tell the person

- **A desktop notification when a call is held**, on macOS and Linux. It names
  the server and the tool, never the arguments. `synartesis notify --test`
  checks it reaches you; `SYNARTESIS_NOTIFY=0` turns it off.
- **`synartesis allow <server.tool>`.** `--for 1h` stops holding that tool until
  the time runs out, with no restart. `--always` edits the policy in place,
  keeping its comments, and a tool that cannot be undone stays marked that way
  (you type its name to confirm). `--stop` holds it again. `A` in `watch` and
  the console, and a button on the desktop card, approve the call in front of
  you and allow the tool for an hour.
- **A person's no reaches the agent.** A retry of a denied call is told who
  said no, when and why, instead of opening a fresh hold. `approve` on the
  denied call takes the denial back. Denials live in their own table, so a
  spent approval, which is also stored as denied, is never reported as a refusal.
- **Why a call is held.** A tool with no rule says so, rather than "this action
  cannot be undone".

### Changed

- **The agent is never handed the command to approve its own call.** It used
  to be in the refusal text and in the instructions every agent receives, and
  an agent with a shell could run it, recorded under your name. `approve` and
  `allow` now need a person at a terminal unless given `--unattended`, which is
  recorded. This stops an agent following instructions or making a mistake. It
  does not stop a process working to defeat it while running as you, which can
  write the journal directly.
- **`show` and `undo` speak the same words as everything else.** No more
  `reversible applied` or `result rolled_back` at the end of a dry run that
  wrote nothing. A read-heavy session's reads fold into one line.
- **`install --print` starts nothing.** It promised to write nothing and then
  started every server, which meant a download for each npx server and a
  browser window for each sign-in. `install` also says which server it is
  starting, instead of going quiet until the last one answers.
- `check` offers `pin` only once the policy has been used. The desktop window
  points at `install`, not bare `init`. The `--http` server answers an ended
  session with 404, as the MCP specification asks.
- A policy using `{{args.id}}` (loaded, then sent as those characters) or
  `${args.id}` (failed with no line number) is refused with the line and the
  spelling that works.

### Docs

- The user guide's only complete policy example did not parse. It does now,
  and a test loads every policy shown in the README, the guide and the install
  page. The manual setup snippets give each server its own entry with
  `--server`, and the Claude Code command has its `--`.

## 0.8.8 — 2026-09-22

### Fixed

- **The GitHub Models preset added in 0.8.7 could never have worked.** GitHub
  retired its inference API on 30 July 2026, three weeks before that entry was
  written. The host is still there and still answers -- `200 OK`, with
  `content-type: text/plain` and a body of `OK`, whatever path you ask for --
  which is exactly the shape of thing that looks alive until you try to use
  it. The entry was built from blog posts and community threads, every one of
  them written before the retirement, while the vendor's own documentation
  said in plain words that the API was gone.

  Removed, and replaced with **OpenRouter**: one key, many models, and
  nineteen of the free ones currently advertise tool support, which is the
  constraint that actually decides whether a model can drive this window at
  all. Its catalogue is public, so which nineteen can be checked rather than
  guessed.

  Groq, added in the same release, was checked the same way and is fine.

  The note now at the head of the preset list is the part worth keeping: send
  a request to the host before adding one. A preset that does not work is
  worse than no preset, because the person who picks it concludes this window
  is broken rather than that the service is.

## 0.8.7 — 2026-09-22

### Added

- **Two presets for people with no GPU.** The window has run free models since
  it had a model picker -- Ollama, LM Studio and vLLM all need no key and
  nothing leaves the machine -- but every one of those is free only if you own
  the hardware to run it. **Groq** and **GitHub Models** are hosted, both have
  a free tier, and neither wants a card: a GitHub token you already have is
  enough for the second. Both speak `/v1/chat/completions`, so they are
  presets rather than code, which is what the note at the head of that list
  has always said any endpoint can be.

  The note beside each says what it actually costs -- rate limited, and meant
  for trying things rather than for a day's work -- because the failure worth
  preventing here is somebody picking a free option and reading its quota
  refusal as this window being broken. The same reason the local entries say
  to pick a model that can call tools: the window is an MCP client, and a
  model that cannot emit a tool call cannot drive it at all.

## 0.8.6 — 2026-09-22

A test I added in 0.8.5 failed the release build. The published package was
never affected -- tests do not ship -- but the tag produced no GitHub release
and no installers, so this is 0.8.5 with that test written properly.

### Fixed

- **The new screen budget asserted milliseconds, and milliseconds are a
  property of the machine.** `tests/screen-budget.test.ts` held a console
  frame and a watch frame under a stated number of milliseconds. That passed
  on the machine it was written on and failed on a CI runner twenty minutes
  later, which is several times slower and shared -- the gate in `release.yml`
  went red and 0.8.5 never got its installers.

  It asserts two machine-independent things now. A ratio, measured back to
  back on whatever is running: answering from the indexes against answering
  by reading every action in every run, which is about 36x here and has to
  clear 4, because going back to reading the rows scores 1. And a query plan,
  which is a fact rather than a duration -- the watch screen's newest-first
  read has to name the index, and must not say `USE TEMP B-TREE FOR ORDER BY`,
  which is exactly what it said before 0.8.5 added `actions_recent`.

  It also seeds its four thousand actions once for the file rather than once
  per test, which was most of the runtime and bought nothing: all three
  questions are read-only.

  The correctness half is new and is the part worth keeping. The two ways of
  counting -- from the indexes and from the rows -- must agree, because a
  frame that is fast and wrong is worse than the slow one it replaced.

## 0.8.5 — 2026-09-22

Three states you could get into and not get out of, two screens that read the
whole journal to draw one frame, and a gate that let two statements through.
Found by auditing rather than by using it, which is the difference between
this release and the last one.

### Fixed

- **An undo killed halfway can now be resumed.** An action whose inverse was
  being sent is marked `rolling_back`, and until now nothing could ever
  reclaim one: no flag, no command, no amount of waiting. The claim was right
  to refuse -- sending a second inverse is harmless for a restore and a second
  real change to the world for a compensation -- but it was refusing because
  it could not tell a process still working from one that had died, and there
  was nothing to ask. One Ctrl-C during an undo put an action permanently
  beyond the command whose whole job is getting back.

  There is a lease now, in a `leases` table, holding the host and process id
  that took each claim. A claim is reclaimed only on evidence, and only when
  both questions have answers: the drift check has already proved the inverse
  never landed (a `rolling_back` row that gets that far has a verified
  pre-read, or it halts earlier), and the operating system says the process
  that held it is gone. Anything less certain -- a lease from another machine,
  a lease taken by a build from before the table existed, no lease at all --
  still halts, and now says who held it and since when. There is no timeout to
  tune, so there is no window in which an undo that is merely slow is mistaken
  for one that died.

  No schema version bump. `CREATE TABLE IF NOT EXISTS` changes no row and no
  meaning, runs on every open, and an older build opening the same journal
  neither notices nor cares -- the same argument the indexes have carried
  since 0.6. A bump would refuse to open every journal already out there,
  because there is still no migration path.

- **A call whose outcome was never established no longer blocks a whole run
  for ever.** `pending` means the call went out and nobody can say whether it
  landed, and undo stops at one rather than produce a state that is neither
  the before nor the after. That was right and permanent: nothing in the CLI
  could settle such a row, so one interrupted call blocked the undo of
  everything older than it, and the only way past was `--to` above it, which
  abandons the rest.

  `synartesis resolve <action> --applied|--failed` records what a person
  found, and who they were. It claims nothing else: an action resolved as
  applied has no inverse, because none was ever resolved, so undo reports it
  as something it cannot put back and carries on with the rest of the run.
  Unblocking a run and undoing an action are different things and only the
  first is on offer. A proxy that comes back and records what it actually saw
  wins over a person's judgement, because it was there.

- **Ctrl-C during an undo stops between actions instead of wherever it lands.**
  There was no signal handling in the CLI at all, so an interrupt was node's
  default: die immediately, including with an inverse in flight, which is the
  single best way to produce the state the first item above describes. The
  first Ctrl-C now asks the rollback to stop before it claims the next action
  and says so; the second is the operating system's. Deliberately not wired to
  the abort signal that cancels a request in flight -- what is already in the
  air is allowed to finish and be recorded.

- **A client disconnecting no longer erases that a session was undone.** The
  proxy ends its run when its client goes away, which says nothing about
  whether anything was put back -- and it was an unguarded write, so it
  stamped `complete` straight over the `rolled_back` an undo had just
  recorded. A session somebody had reversed came back looking untouched.

- **`undo` no longer defaults to a session an agent is still writing to.** The
  newest run is, by definition, the one a running proxy is using, and `undo`
  with no id pointed straight at it. A preview is always allowed, because it
  writes nothing; doing it for real now needs `--yes`, and the refusal names
  all three ways on. A session whose proxy exited normally is `complete`, so
  this fires only where something really is unfinished.

- **Two writes the `on_write` gate read as reads.**
  `WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x` is an ordinary
  PostgreSQL data-modifying CTE, and `EXPLAIN ANALYZE DELETE FROM users` runs
  the statement it claims to be explaining. Both begin with a word on the
  read list, neither contains a semicolon, and both were passed through
  ungated while emptying a table. The heuristic's promise is that anything it
  cannot confidently read as a read is gated; these were read confidently and
  wrongly. The leading word still decides whether a statement could be a read,
  and a second pass over it -- with comments and string literals removed, so a
  keyword cannot hide in either -- decides whether anything in it writes.

  No shipped policy uses `on_write`, so nothing in the box was exposed. The
  documentation invites you to use it for your own SQL server, which is
  exactly who this was a hole for.

### Changed

- **The console drew each frame by reading the entire journal.** `runsView`
  called `getActions` for every session on screen -- every snapshot, result
  and inverse in each of them, each through a schema parse -- to arrive at two
  integers per row, eight times a second. `tallyRuns` was added for precisely
  this and `list` was moved onto it; the console was missed. On a
  hundred-megabyte journal that was 62ms a frame against a 120ms tick, so half
  the event loop went on deciding what to draw and keypresses queued behind
  renders. It is about 2ms now, and what each session still has waiting comes
  from two partial indexes rather than from its rows.

- **`watch` scanned the whole table to show twelve lines.** `recentActions`
  orders by time and there was no index on time alone, so every 120ms it read
  every row in the table -- the ones carrying the snapshots -- and sorted them
  in a temporary b-tree to return twelve. 7.4ms to 0.03ms on the same journal.

- **A large write no longer pays to canonicalise its own arguments for
  nothing.** The three lookups that run on the way in to a call each built a
  canonical form of the arguments before checking whether there was any
  candidate row to compare it against -- and their indexes are partial
  precisely so that there almost never is. 23.5ms of pure waste on a
  ten-megabyte write, gone with an early return.

- **A budget test for both screens.** Every performance test here measured one
  call against a journal a few hundred rows deep, which is the one shape in
  which none of the above exists. `tests/screen-budget.test.ts` seeds four
  thousand actions and holds a console frame and a watch frame to a fraction
  of their tick, so the next regression is caught by CI rather than by
  somebody's fan.

## 0.8.4 — 2026-09-21

Bugs, all of them found by using the thing rather than by a test going red:
the suite was green before this and is green after it.

### Fixed

- **A server that was briefly unreachable no longer turns an ordinary undo
  into one that needs `--force`.** The drift check reads the resource as it is
  now, and when that read failed the action was written back as
  `unrecoverable`. Nothing had been learned about the resource -- the read
  never happened -- but the row now said otherwise, and the next plain
  `undo` refused with "halted here on an earlier attempt" and offered
  `--replan` or `--force`. So a server that was down for ten seconds escalated
  an undo that would have worked into one that writes over whatever anybody
  else had changed since.

  The same write cost a second thing. A row that had already halted on real
  drift carried the diff of what somebody had changed, which is the evidence
  the person deciding is shown; retrying while the server was unreachable
  replaced it with `server fs is not connected`. The halt then offered its
  three-way choice with a transport error where the conflict used to be. The
  read failure is now reported and not recorded, for the reason an unknown
  outcome has never been recorded either: a rollback may not write down as
  fact a thing it did not observe.

- **The way past a drift halt no longer sends you round in a circle.** It
  printed `put it back as the run left it: synartesis undo <id> --replan`,
  which reads as though the flag does the putting back. It does not: it
  rebuilds each inverse from the current manifest, and the drift check then
  runs again on a resource nobody has touched. Somebody who typed what that
  line told them to got the identical halt, offering the identical three
  options, including the one they had just chosen, for as long as they cared
  to keep typing it. The restoring is the reader's half, as `--help` has
  always said, and the line now says so: `put the resource back, then:`.

  While there: the three options were spaced by hand and the middle one sat a
  character left of the other two, which is enough to stop a menu reading as
  a menu. They are padded to a column now, and a test fails if they drift
  apart again.

- **`--to` past the end of a run answers in one line.** The message was
  already exact -- `--to 99 is past the end of this run, which goes up to 1`
  -- and was followed by five lines of unrelated commands. The bound in that
  sentence was read off the journal, which is precisely the case the
  command list was already meant to stay out of.

- **Counts agree with their nouns.** `1 runs and 1 actions removed`,
  `1 actions: 1 gated`. Three places counted the same way and each had its own
  copy of the arithmetic; there is one now, in `style.ts`, beside the other
  decisions about how text is set.

- **The repository's social preview card is the whole card.** Every other
  source in `brand/` states its size at 1x and gets its sharpness from the
  shoot's scale factor; this one was written at 2560x1280 and shot at
  1280x640, so what GitHub served when the repository was pasted into Slack
  or a message was the top-left quarter of itself: three quarters empty
  maroon with the tagline cropped off the bottom edge. It was also the only
  asset here that nothing said how to rebuild, which is how it drifted.
  `brand/README.md` now carries its command with the rest.

- **`og:image` states its dimensions.** LinkedIn and Slack lay a link card out
  before the image arrives and held a grey box of the wrong shape until it
  did.

## 0.8.3 — 2026-09-20

Documentation, brand and repository furniture. No code changed, and the
published package behaves exactly as 0.8.2 did.

0.8.2 was tagged and never published to npm; this goes out in its place rather
than publishing a tarball whose README differs from what its own tag points
at.

### Added

- **Two drawings that move.** The README could say the value is kept before
  the write and could show the result afterwards, and had no way to show the
  sequence in between — which is the whole design. `synartesis-path-loop.svg`
  draws where the proxy sits, which the README had described in prose and
  never drawn at all; `synartesis-undo-loop.svg` is the three phases of an
  undo. Hand-written SVG rather than GIF: two hundred times less weight and no
  fuzziness on a retina screen, at the cost of the brand faces, since a
  browser gives an SVG inside an `<img>` no network and blocks the webfont
  import. Both carry their own ground so they read in either of GitHub's
  themes, and both answer `prefers-reduced-motion` by settling on the end
  state rather than disappearing.

- **A wiki, and a sponsor button.** Four pages that deliberately do not repeat
  the documentation — a policy cookbook whose every example was run through
  the real manifest loader first, troubleshooting organised by the symptom in
  front of you, an FAQ, and a home page saying what lives where. Discussions
  opened with a thread saying what is actually proven. Ko-fi produces the
  button today; `github:` is in `FUNDING.yml` and starts working the moment
  that account is enrolled.

### Changed

- **The README's navigation is buttons rather than blue text.** The top was a
  hand-written contents bar of eleven in-page anchors, most of which
  duplicated GitHub's own table-of-contents button. One row of six now points
  at the places somebody actually leaves for, with the status badges at half
  the size underneath. Two details that had made the row look accidental: the
  Actions badge is a different height from a flat-square row, and shields
  picks text colour by background brightness, which had put white on the one
  button meant to stand out.

## 0.8.2 — 2026-09-20

### Added

- **The git policy's undo is proven, not just plausible.** `check` starts the
  server and confirms every tool the policy names exists, which proves the
  policy loads and proves nothing about recovery: a compensation can resolve to
  a real tool, take the arguments that tool really wants, put nothing back, and
  report `rolled_back`. So `tests/adapter-git.test.ts` stages real changes in a
  real repository, undoes them, and reads the index back with git itself rather
  than through the server being tested.

  It is a narrower claim than the filesystem and memory files make, and that is
  the policy's shape rather than the test's. This server exposes nothing that
  restores content — nearly every read it offers answers in prose written for a
  person, so almost nothing can be inverted from a captured state — which
  leaves exactly one compensation to prove. Proven: staging comes back off the
  index and the working tree is untouched; a commit is held rather than
  approximated; a branch switch goes through and undo reports it as permanent
  instead of claiming to have reversed it.

  **The overreach is pinned too.** This server's `git_reset` unstages
  everything, not only what the call staged, so undoing the agent's `git_add`
  also unstages work a person staged by hand. Nothing is lost — both edits are
  still in the working tree — but it is a compensation and not an undo, and the
  test now fails if the policy is ever changed to imply otherwise. Every guard
  in the file was broken in turn to confirm it bites.

  CI installs `uv`, because mcp-server-git is a Python package. Without it that
  file fails rather than skipping, deliberately: a proof that quietly does not
  run leaves the suite green and the claim unsupported.

### Changed

- The README, the user guide and the site said git was "checked only for tool
  existence". That was true when written and is not now, so all three say what
  is actually proven and what still is not. **github** remains untested.

## 0.8.1 — 2026-09-19

Documentation only. No code changed, and the published package behaves exactly
as 0.8.0 did.

### Changed

- **The README is laid out as a page rather than a document.** Somebody
  arriving from a link wants to know within one screen what this is, that it
  works, and which of the four ways in is theirs. None of that was visible
  without scrolling past four screens of prose. The top is now a centred hero,
  a badge row and a contents bar, then **Choose your path** — four cards, one
  per way in, each carrying the command that starts it — and a short list of
  first results that take the least time.

- **Two things came out of hiding, in the README and on the site.** The
  interactive screen was a footnote inside Install despite being the interface
  most people will use, and there was nothing anywhere about writing a policy
  for a server that does not ship with one — which is the case for every server
  but four, and the contribution most worth asking for. Both are now sections
  of their own: `synartesis.online/install.html#write-a-policy` covers `init`
  drafting fail-closed and `check` refusing a policy that names a tool the
  server no longer has.

- **A contributing section, and the star asked for out loud.** The README
  explained the tool thoroughly and then stopped, with no issue link and
  nothing a reader who agreed with it could do next.

- `SECURITY.md` said the 0.6.x line was the supported one, two minors after it
  stopped being.

## 0.8.0 — 2026-09-16

### Added

- **`expect: absent`, and `move_file` becomes undoable.** A pre-read normally
  captures what a call is about to replace, so a read that finds nothing means
  there is nothing to put back. For a few calls that is exactly backwards:
  moving a file onto a free path is undone by moving it back, and it is finding
  *something* there that puts the call beyond undo, because one inverse cannot
  both move your file back and restore what it landed on.

  Both halves were measured before anything was written. Declared plainly
  `reversible`, the safe move came back `partial` with the file still moved —
  the trivially reversible case was the one that could not be undone — and the
  dangerous one came back `rolled_back` with the overwritten file gone, which
  is the confident wrong undo this exists to prevent. `expect: absent` on the
  snapshot swaps the two: finding nothing is reversible and the inverse runs;
  finding something is held for a person and recorded with **no inverse**, so
  undo says it cannot be undone rather than putting half of it back.

  The shipped filesystem policy uses it, so moving a file to a fresh path is
  now an ordinary undoable action instead of an approval prompt. A policy that
  declares it on a non-`reversible` rule, on a `verify` read, or with an
  inverse reading `$snapshot.` — which can never resolve, since nothing is
  captured — is refused at load.

  Worth recording: this server's own description of `move_file` says "If the
  destination exists, the operation will fail." It does not; it renames over
  the top, because that is what `rename(2)` does. Taking the documentation at
  its word would have made the rule unconditionally reversible and the
  overwrite both unrecoverable and unremarked.

## 0.7.0 — 2026-09-16

A pass over everything, after an audit of the desktop app, the core and the
release. Most of what it found was not broken code but things that stated
something untrue.

### Fixed

- **Every desktop binary since 0.6.12 carried the wrong version.**
  electron-builder reads the version from `app/package.json`, which nothing
  else reads, so it stayed put while the root moved. The nine installers
  attached to v0.6.23 were all named `0.6.12`, byte-identical in name to the
  ones on v0.6.12 — two people on different releases could not tell their
  builds apart. `app-packaging.test.ts` already checked seven agreements
  between the packaging files; the absence of the eighth is why this ran for
  eleven releases.

- **A spent approval read as "refused" in `watch` and the console.** `labelFor`
  was written for exactly this and `list` and `show` were taught to use it;
  `plainly` was not — and `plainly` is what the two live screens render, so a
  person was told their own yes had been a no, seconds after giving it.

- **`undo --dry-run --force` printed no plan.** It showed what forcing would
  write over and returned, so the flag whose whole job is to print the plan
  printed none. A dry run no longer needs `--yes` either: the two-step ask
  protects a write, and a preview writes nothing.

- **A `verify:` read was never validated.** `snapshot` and `inverse` are
  checked against the servers at load; `verify` was not, and it is the one
  whose failure is silent — the proxy turns it into a soft warning and carries
  on, so a typo meant that tool had no drift detection at all while both the
  policy and `check` said it was fine.

- **A failed inverse on the lost-answer path was swallowed whole.** An inverse
  reading `$result.` cannot be rebuilt when the answer is what went missing,
  and undo reported "cannot be undone" without saying why — on the path where
  undo matters most.

- **`--client` with a typo blamed the machine**, reporting "No MCP client
  config was found on this machine". On `uninstall` it said "Nothing was
  covered, so nothing was changed", which reads as reassurance.

- **`undo --to` always exited 1.** A floor makes a run `partial` by
  construction, correctly, and the exit code was read off that — so an undo
  that did exactly what it was told could not be told from one that halted on
  somebody's edit.

- **`status` read "when was this server last used" off the newest five hundred
  actions**, so a server whose last use had scrolled out of that window came
  back as never used: "covered, nothing through it yet". Asked exactly now,
  from a covering index — 75ms to 3.5ms on sixty thousand actions.

### Fixed — the desktop window

- **With no policy the window could not be quit.** The branch that drew the
  no-policy screen returned before the IPC handlers were registered and before
  the quit handlers were attached; on Windows and Linux that left a process
  running with no window. Everything after `whenReady` is now one path in
  `boot.ts`, which imports no Electron — which is also how the key-page
  allowlist became testable.

- **Two spurious errors before the no-policy screen.** The window asked the
  engine two questions the moment it mounted, which with no policy came back as
  "No handler registered" and were drawn as errors. The push is now a pull.

- **`Bridge` was declared twice and neither copy was connected to the
  preload** — the only one that was true. They had already drifted. The shared
  one survives, the exposed object is annotated rather than inferred, and both
  the compiler and a test now catch a future drift.

- **A server that would not start vanished**: no event, no log, nothing in the
  window, and a briefing that went on announcing it as connected. It now
  reaches the transcript with the server's own words, and the model is told not
  to plan around tools that are not there.

### Changed

- `pnpm check` runs build, typecheck, lint and the suite in one command.
- The release workflow runs that gate before building installers, builds the
  desktop app in CI, runs the memory demo, and takes its release notes from
  `CHANGELOG.md` instead of a list of commit subjects.
- `npm publish` runs the whole gate rather than only a build.
- `list --json` and `show --json` both carry `actionCount`, so one name means
  one thing in both. The existing `actions` shape is untouched.
- The site points at `/releases/latest` rather than a pinned version.
- The user guide covers `install`, `uninstall`, `status` and `desktop`, and is
  no longer stamped twenty releases back. `CONTRIBUTING.md` no longer shows a
  manifest syntax that throws on load, or asks for a C toolchain the project
  disables.

## 0.6.23 — 2026-09-16

### Docs

- **What to do with a tool that does two things at once.** A call that both
  writes something recoverable and does something that is not -- saves a file
  and posts to an API, updates a record and sends the email about it -- takes
  the class of its least recoverable part, because a rule matches a tool name
  and gives it one class. The guide now says so, says why the alternative is
  worse (undo puts the file back, reports `rolled_back`, and says nothing about
  the request still out there), points at `move_file` as the shipped example of
  the same shape, and shows the one way out: a `compensable` rule whose inverse
  neutralises the unrecoverable half. Asked often enough to be worth writing
  down rather than answering again.

## 0.6.22 — 2026-09-16

### Added

- **The memory policy's undo is now proven, not just plausible.** It has always
  declared `provenance: live` -- the tools were checked against the real server
  and the shapes read off its own answers -- while the README said its recovery
  guarantees were unproven. Both were true, and the gap between them is where a
  policy can name every tool correctly, take exactly the arguments the server
  wants, and still resolve an inverse that puts nothing back. That failure
  looks like success: the drift check passes and the report says `rolled_back`.

  `tests/adapter-memory.test.ts` makes each change against a real knowledge
  graph, undoes it, and compares the file. What the agent added is gone and
  what was already there is untouched; an entity the agent only *tried* to
  create -- this server ignores a duplicate name -- is left alone rather than
  deleted out from under its owner; a relation drawn or removed goes back; and
  a delete of an entity is held for a person rather than approximated, because
  one inverse cannot put back both the entity and the relations that went with
  it. Every one of those was confirmed by breaking the policy and watching the
  matching test fail.

  Two of the four shipped policies are now round-tripped end to end.
  `synartesis check`, the README and both guides say which, and `git` is still
  named plainly as untested.

- `check` also confirms the memory policy covers every tool that server offers,
  so a server that grows one fails here rather than in front of somebody's
  agent.

## 0.6.21 — 2026-09-16

### Fixed

- **`live` claimed more than it meant, and the docs contradicted each other
  about it.** `provenance: live` says a policy has met its server and that the
  tools take the arguments it passes them. `check` printed that as "checked
  against the real server", which reads as a claim that undo works -- and it is
  not one: a policy can be right about every tool name and still record an
  inverse that restores nothing. Meanwhile the README said memory's recovery
  guarantees were unproven while the user guide listed memory among the
  policies that say `live`, so a reader who saw one came away with the opposite
  of what the other meant. `check` now says "shapes read from the real server"
  and adds, once under the server list, that `live` is not a recovery claim and
  that only filesystem has been round-tripped. README and both guides say the
  same thing.

### Added

- **`check` names the tools no policy covers, instead of describing the rule.**
  An unmatched tool has always been fail-closed -- irreversible, held for a
  person the first time it is called -- and `check` said so as a sentence about
  tools in general while the actual list sat one round trip away. It already
  connects to every server and reads the whole tool list to verify the
  policies, so the answer was in hand and thrown away, and the first anybody
  learned a tool was ungoverned was an agent stopping on it mid-task. Now
  named, per server, with a count. The proxy warns at startup for the same
  reason, and `proxy ready` carries an `ungoverned` count so a policy with no
  gaps and a build that forgot to look do not read alike.

  For what almost everybody runs, the answer is none: the shipped filesystem
  policy covers every tool that server offers, and there is a test that will
  fail if that stops being true.

- The build targeted `node20` while the package requires `>=22`, which is the
  floor better-sqlite3 sets -- on Node 20 it segfaults the moment a database
  opens. Targeting lower was harmless but said the wrong thing about what this
  supports, in the one place a reader could check. Now `node22`.

## 0.6.20 — 2026-09-15

### Fixed

- **The undo preview showed a write nobody confirmed as one that was
  confirmed.** A tool call can land and then fail to say so -- the server
  writes the record and times out, or answers with an error on its way out.
  Synartesis already handled this correctly: it refuses to read `isError` as a
  promise that nothing happened, reads the resource back, and records the
  change so it stays recoverable. What it did not do was say so afterwards.
  The row that came out of that path carried no trace of it at all -- the
  refusal was written to the log, which nobody reads, at the moment it
  happens, which is not the moment it matters -- so `undo --dry-run` printed
  `revert ... state matches; applying inverse`, character for character what a
  confirmed write prints. The row now records how it was established, and the
  preview prints it under the step as `caveat`. Same in the app's
  `preview_undo`, so a model cannot describe an inferred write to somebody as
  a confirmed one.

- **A halt that named the consequence and hid the cause.** Where the transport
  failed and the read-back proved the write had landed, undo correctly stopped
  rather than reverting on an unverified assumption -- but said only "the
  post-state was never captured, so drift could not be ruled out", which reads
  as a missed reading. The reason there was no reading, which the row knew all
  along, is now printed with it.

- An action whose outcome is unknown was told it got that way because "the
  process died mid-call". A timeout, or an error the read-back could not
  settle, arrives in exactly the same state and was told the same wrong story.
  It now says what is actually known, and the row's own error says which of
  them it was.

## 0.6.19 — 2026-09-15

### Fixed

- **Both guides showed output the command no longer produces.** The worked
  examples of `show` were still the pre-0.6.18 single-line row, and the session
  lists were still the pre-0.6.17 table of full uuids -- in the runbook, whose
  pdf had just been rebuilt from that stale text, and in the user guide, whose
  pdf had not been rebuilt at all, so the two shipped documents disagreed with
  each other as well as with the terminal. Regenerated from real runs and both
  pdfs built together.

- **Four tap targets touching on a phone.** A rule added with the last release
  set `gap:0` on the screenshot tabs, overriding the deliberate `gap:8px` set
  with the two columns further up the same stylesheet. The buttons carry their
  own border, so the four of them closed into one block with doubled seams and
  no separation between adjacent targets. Measured at 375px: they abutted
  exactly, at x=22 and x=188 across a width of 166.

- `badgeOf` and `statusOf` took a `pad` that defaulted to true, and the one
  call site of each passes it explicitly -- so the default could never apply,
  and it was the wrong answer for the ordinary case anyway. Required now.

## 0.6.18 — 2026-09-15

A pass over the terminal and the site, most of it drafted by another model and
reviewed here.

### Changed

- **`show` leads each action with the tool that ran.** It used to begin the row
  with sequence, class and status, putting the tool name at column thirty-eight
  where a long server name could push it off. The class and status now sit on
  the line below it, and each action is separated by a blank line rather than
  each action's recovery data being separated from the action.

- **A held call is set in the accent colour**, which the palette reserves for
  the one thing that wants a person. It was set in ink, like an ordinary fact.

- **The site keeps its columns on a phone.** At 375px the interactive example's
  caption left the undo control stranded alone on a second line; it takes its
  own row now, with a tap target that meets the usual minimum. Figures in the
  evidence blocks are set in tabular figures so they hold their columns as the
  numbers change, and the install guide's two opening columns share a top edge.

### Fixed

- **Trailing whitespace on every action in `show`.** The padding that used to
  line up the next column had nothing after it once the tool name moved, so it
  dangled at the end of each line -- inside the escape codes, where trimming
  the finished line cannot reach. Padded now only where a third column follows,
  which is `--live` and usually absent.

### Kept

- **The turning mark in `watch` and the screen stays.** It was read as implying
  an agent was at work on an empty journal. It sits beside "watching" and "no
  journal here yet", which are statements about the command rather than about
  an agent, and it answers the only question a quiet screen raises -- whether
  this is still running. Nothing else in the frame changes to answer it: every
  time shown is a wall clock reading of something that already happened, so
  without the mark a live `watch` on a quiet journal is indistinguishable from
  a crashed one. That is the command meant to be left running. There is now a
  test.

## 0.6.17 — 2026-09-15

### Changed

- **The session list says what each session did.** Three sessions a second
  apart -- one that wrote a file, one that read one, one that did nothing --
  printed as three identical rows distinguished only by a uuid, so the command
  you run to find the session you want told you nothing about which session you
  want. There are two new columns and one fewer:

  ```
  session   started        did                         state                       agent
  331e43de  16:41:21       write_file report.txt       done, can undo              agent
  ac635294  16:41:21       read only                                               agent
  5856e14a  16:41:21       create_directory x          waiting for you             agent
  e52213e6  16:41:20       write_file notes.md         undone                      agent
  ```

  `did` is the last action that changed something, named the way `watch` and
  the screen already name one. `state` is where that leaves it, including the
  two that look identical otherwise: a run that has been undone and one that
  has not.

  Ids are printed at eight characters, widened only if that would not tell the
  runs apart -- any unambiguous prefix has always been accepted, and thirty-six
  characters of hex on every line was the price of a collision that has not
  happened. The `status` column is gone: `complete` is true of nearly every
  line and pushed the column that varies off the edge. `active` is not true of
  nearly every line, so it survives as "still open" -- it means a proxy still
  working or one that was killed, and it is the whole reason `close` exists.

  `--json` is untouched: full ids, same fields. That is what scripts read.

## 0.6.16 — 2026-09-15

### Fixed

- **A run stopped by drift said it had already been undone.** Undo halts on a
  conflict and prints three ways on, one of them `undo <id> --force`. Running
  that answered "Nothing in it is still applied; it has already been undone"
  -- about a change still sitting in the file -- and refused the very command
  it had just recommended. A halted action is `unrecoverable`, keeps its
  inverse, and is exactly what `--force` and `--replan` exist for; the check
  counted only `applied` and read that as nothing left to do. Found by walking
  the drift case end to end rather than by reading the code.

## 0.6.15 — 2026-09-15

One gap, named by a stranger on Reddit and real.

### Security

- **A retry of a call whose outcome nobody could establish is now held for a
  person.** The tri-state was already there -- a write that times out is not
  called `failed`, the resource is re-read to see which way it went, and what
  cannot be settled is left `pending`, which undo refuses to step over. What
  was missing was the other half: nothing stopped the agent from simply making
  the call again.

  The idempotency key cannot close this. It is `runId:seq`, so a retry is a new
  row under a different key and no upstream can tell the two attempts were one
  intention -- checked against the real proxy, which records `seq=1 key=…:1`
  and `seq=2 key=…:2`. A comment beside the forward call claimed otherwise and
  has been corrected.

  So the person who can go and look is asked before a second side effect
  exists. It reuses the gate rather than inventing a second mechanism: the call
  appears in `synartesis gates` with a reason that says what happened, rather
  than the generic policy text.

  Three things it deliberately does not do. It never holds a **read** -- a read
  that timed out is left `pending` like anything else, but reading twice
  changes nothing, and an agent may always look freely. It holds only the
  **identical** call, matched on server, tool and arguments: the uncertainty is
  about one call, not about the tool. And approving the retry **does not
  resolve the first attempt** -- that row stays `pending` and undo still stops
  on it, because saying yes to going forward is not a claim about what already
  happened.

### Performance

- `findPending` runs on the way in to every write, and left to choose sqlite
  walked every action in the run -- rows that carry the snapshots -- to find
  the handful that are pending. A partial index over exactly those rows, named
  explicitly, on a single run of twenty thousand actions with two-kilobyte
  snapshots: **24ms a call to 0.004ms**.

## 0.6.14 — 2026-09-15 (tagged, never published)

The terminal now says what to do next, and the argument parser stopped
disagreeing with itself.

### Added

- **Most commands end by naming the one thing worth doing next**, with the
  session id already filled in:

  ```
  fs.create_directory is held, and the agent is waiting on you:  synartesis approve f0c9935d
  ```

  It is worked out from the journal rather than from what was typed, so it
  changes as the state does. A call held for approval outranks everything else
  -- that is an agent stopped mid-task waiting on a person who may not know it
  is waiting. Below that: the session that changed something, what is not
  pinned, and `watch`. There is at most one, there is none when nothing
  applies, and `--json` never carries it. `SYNARTESIS_NO_HINTS` turns it off.

  The session it names is not simply the newest one. A client that connects
  and reads opens a session like any other, so "the last thing that happened"
  is regularly a session in which nothing happened; a session that only read,
  or was already undone, or was held and never ran, is never offered for undo.

- **A mistyped command gets the word that was meant.** `synartesis lst` used to
  answer with forty lines of help, thirty-nine of them about something the
  person was not doing. It now says `did you mean list?` and lists five
  commands. Flags too: `--jounral`, `--dryrun`, `--forse` all resolve.

- **A flag that belongs to `proxy` is named as such.** `--http`, `--token`,
  `--server` and `--log-level` are in the help page, and answering one of them
  with "unknown flag" sent people hunting through that page for a flag already
  in it.

### Fixed

- **A wrapped server's own flags were read as ours.** `synartesis init db --
  some-server --manifest audit.yaml` handed `--manifest` to the server
  correctly and *also* took it, writing the policy to a path nobody asked for
  -- on a machine where that path is real, one they already had. `positional`
  and the unknown-flag check had always stopped at the bare `--`; the flag
  reader had not.

- **The value of a flag was read as a flag.** `deny --reason "-see ticket 42"`
  answered `unknown flag -see ticket 42`, and `prune --older-than -5` answered
  `unknown flag -5` instead of the message that knows what `--older-than` is
  for. Three separate lists had to agree about which flags take a value and
  did not; there is one now, and a test holds it against the help page.

- **`undo --to 0` announced the session before refusing.** It printed "no
  session named, so the most recent: a42bf93a" and only then rejected the
  flag, which reads as though that session had been acted on.

- **A hint that could not be pasted.** `list --journal ./bench.db` named a
  session, and the `show` it offered read the *default* journal and answered
  "no run matches". Hints now carry `--journal` and `--manifest` when those
  were not the obvious ones, and `undo --replan --dry-run` offers a command
  that still replans.

- **Guessing at a typo was too eager.** A ceiling of half the word answered
  `--server` with `--live` and `--token` with `--to`, neither of which anybody
  meant. Two edits at most now, never for a word under three characters, and a
  swapped pair counts as the one mistake it feels like -- which is what keeps
  `shwo`, `pruen` and `--jounral` reachable at that ceiling.

- **Colour was decided for both streams from stdout**, so `synartesis nonsense
  2> errors.log` in a terminal wrote escape sequences into the file.

### Performance

- **`newestUndoable` runs on every `list`** and could only be answered by
  reading the action rows, which carry the snapshots -- so the cost of one
  screen of sessions grew with the size of the data rather than the number of
  sessions. A partial index over exactly the rows it wants fixes that, but only
  when named: left to choose, sqlite takes `actions_gated` and reads the rows
  anyway. Measured on a 246MB journal: **56ms to 0.01ms**.

## 0.6.13 — 2026-09-14

Four things, all of them from one comment by a stranger on Reddit who had
clearly built something like this before. Every one was real, and none of them
would have announced itself.

### Security

- **A server that would not start said nothing useful about why, and could
  hang the proxy outright.** Two faults in the same few lines, found by hitting
  the first one in real use.

  What it printed was `code: 'MODULE_NOT_FOUND', requireStack: [], },
  Node.js v22.16.0` -- the last four lines of node's output, which are the four
  least informative. `Error: Cannot find module '/path/to/thing'` sits in the
  middle and was thrown away, so the message named neither the file nor
  anything to act on. A line that states a fault now leads, stack frames are
  dropped, and the tail is only the fallback when nothing states one.

  The second was worse and was found while testing the first: nothing read the
  server's stderr until after the connection failed. A pipe nobody reads fills
  at around 64kB and blocks the writer, so a server that said more than that
  before dying never exited, the connect never rejected, and `check` sat there
  for ever with no output at all. Measured against a server writing 2.4MB to
  stderr: **killed at 30 seconds, against 0.8 seconds and the right error**.
  Stderr is now read as it arrives, capped so a logging loop cannot make the
  proxy the thing that runs out of memory.

- **The one remaining advisory is gone.** `esbuild` reached `pnpm audit`
  through vite, in the renderer build only -- never in anything published, and
  `--prod` was already clean. Pinned anyway, the same way as 0.6.12's three:
  a low advisory nobody can reach is still a line of output that trains you to
  ignore the tool.

- **A server upgrade could silently invalidate the policy written for it.** A
  policy is a claim about what a tool does, anchored to the tool's name -- and
  a name is a weak anchor. A server can keep `write_file` and change what it
  takes. The policy still says reversible, the snapshot still reads a field
  that has moved, and the before-image captured no longer matches the write.
  Nothing failed. The undo was produced later, on request, confidently, and was
  wrong, which is worse than having no undo because somebody acted on it.

  Startup already checked that the tools a policy names exist. It did not check
  that they still have the shape the policy was written for.

  A manifest may now pin that shape:

  ```yaml
  pins:
    fs:
      write_file: "sha256:ce17c85e8a58835..."
  ```

  `synartesis pin` prints the block for the servers you actually have. With it
  in place, a tool whose shape has moved stops the proxy at startup and names
  both fingerprints, instead of being quietly trusted.

  It prints rather than rewriting the manifest: pinning is a person vouching
  for what a tool does today, and a command that edited the policy for them
  would let that happen with nobody reading it.

  Pinning is per server and all-or-nothing. No pins means no checking, so every
  manifest written before this keeps working. Any pins means that server is
  checked in full -- a half-pinned server is the worst of both, because it
  reads as protected and is not. Tools no policy matches need no pin; they are
  already fail-closed as irreversible and gated.

### Fixed

- **Forward calls carried no idempotency key.** The key was minted for every
  action and stored, and it was presented on the inverse -- but not on the
  call going out. So a write that timed out in flight left the agent free to
  retry, with nothing telling the server that the retry was the same intention.
  Two side effects would sit behind one journal row, and undo would reverse one
  of them and report success.

  The key now rides out with the forward call as well, merged into `_meta`
  rather than replacing it, so a client's own `progressToken` survives. It
  remains advisory -- a server that ignores it gives no protection, which is
  why the journal's state transitions are still the real guard.

- **A compensable action could be undone over somebody's work, silently.** An
  action whose undo is a compensating call -- a create offset by a delete --
  has no before-image, because the thing did not exist before the call. So
  there was nothing for undo to compare against: it compensated regardless and
  marked the step `[unverified]`.

  A policy may now declare a `verify` read, resolved *after* the call so it can
  name a resource the call itself created:

  ```yaml
  verify:
    tool: "memory.open_nodes"
    args: { names: "$result.entities[].name" }
  ```

  Undo then halts on drift the way it does everywhere else. Measured against
  the real `@modelcontextprotocol/server-memory`: an agent creates an entity, a
  person adds an observation to it by hand, and undo is asked for. Before, it
  deleted the entity, took the hand-written observation with it, and reported
  `rolled_back`. Now it halts, prints the added line, and writes nothing.

  It is consulted only where no read exists already, so it can never displace a
  working pre-read with a differently shaped one -- which would leave the
  post-state and the snapshot describing different things and make every later
  comparison meaningless.

  `memory.create_entities` gets one. Deleting an entity takes its observations
  and relations with it, which is exactly the case worth refusing.

- **Nothing said which policies had actually been run against a real server.**
  Three of the four that ship were written against the live server; `github`
  never has been, and its own header has said so in plain words since it was
  written. Nothing in the code read that header. `check` did not mention it,
  `install` adopted the policy without a word, and a held GitHub call looked
  exactly as confident as a held filesystem one.

  A server may now state it, and the four that ship do:

  ```yaml
  servers:
    gh:
      command: github-mcp-server
      provenance: documented   # or: live
  ```

  Surfaced by `check`, by the proxy at every start -- before it connects, since
  the untried adapter is the one whose server is least likely to be installed
  -- and by `install` at the moment the policy is adopted. `init` writes the
  claim into the manifest it generates, or the warning would go quiet exactly
  when the policy starts being used.

  Absent means no claim either way, which is right for a policy somebody wrote
  themselves. All three states are printed: if silence meant "fine", an
  ungraded policy and a known-untested one would look identical from here.

- **A call somebody approved was reported as one they had refused.** When an
  agent retries a held call, the approval moves onto the row that actually
  runs and the original is retired -- stored as `denied`, with an error saying
  where its approval went. `labelFor` existed to keep that out of the UI, and
  three readers did not use it. `show` printed "denied by <name>" beside a call
  that person had just approved and which had gone through; its footer counted
  the row as a refusal; and `show --live` called it "never applied (denied)".
  All three now go through `labelFor`, and the live view says what actually
  happened: "its approval moved to the call that ran".

- **Arguments are summarised for a terminal again.** A value with a newline in
  it was printed verbatim, so writing two lines to a file broke the timeline
  and left the second at column zero. A value over 48 characters was reduced to
  a byte count -- which for a path is the one summary that answers nothing, so
  every row of a filesystem session read `path 120 B` and named no file.
  Values are flattened to one line, a long path keeps its end, and long prose
  keeps its size, because the tail of a file tells you nothing.

  The undo plan used raw truncated json for the same job and cut off mid-path;
  it uses the same summary now, so a step reads
  `would call fs.write_file path …/work/ledger.csv  content north,412800`.

- **`synartesis close` treated a tidy journal as a usage error.** Nothing left
  open is the ordinary state and the thing somebody runs the command to check.
  It answered with exit 2 and forty lines of unrelated help. It now says
  "nothing is open" and succeeds.

  Separately, "there is no run to act on" and "no run matches <id>" stopped
  reciting every command. They are facts about the journal rather than about
  what was typed, and the command list buried the one sentence that mattered.
  A mistyped command still gets the full list.

- **`-v`, `version` and `help` answer.** `--version` worked and `synartesis
  version` said "unknown command", which is a riddle rather than an answer.

- **Listing sessions read every action of every run.** It needs a count and
  three status tallies per run, and it was getting them by materialising every
  row -- snapshots, results and inverses included, which is the bulk of the
  table. So the cost of listing sessions grew with the size of the data those
  sessions had touched rather than with how many there were. It is one grouped
  query now, over a covering index. Measured on forty runs of five hundred
  actions with two-kilobyte snapshots, a hundred-megabyte journal: **76ms to
  2ms**.

  The index is added the same way as the two in 0.6.12 and for the same reason:
  no row changes, no meaning changes, and an older build opening the same file
  neither notices nor cares.

- `synartesis check` now says whether anything is pinned, either way. Silence
  when nothing was would have left the safer state and the unchecked one
  looking identical.

## 0.6.12 — 2026-09-13

### Security

- **Nine advisories, none of them ours, all of them shipped anyway.** Four
  high and five moderate arrived through one dependency's dependencies --
  `fast-uri`, `qs` and `hono`, by way of the MCP SDK. Nothing in the published
  npm package contained them: that bundle imports the SDK rather than inlining
  it, so a fresh install resolves patched versions on its own. The desktop
  application is the opposite -- it bundles everything, so it was carrying
  `fast-uri` 3.1.5 and its four high advisories into every installer. Pinned to
  patched versions; `pnpm audit --prod` now reports nothing.

### Fixed

- **Two lookups that ran while somebody was waiting were full table scans.**
  Finding a standing approval happens twice on every call that needs one, and
  listing what is held backs both `synartesis gates` and the console. Neither
  had an index, so both read every row in the journal -- including the
  snapshots, which are the largest column there. At fifty thousand actions with
  two-kilobyte snapshots, measured: 61ms and 56ms, on every irreversible call,
  growing with the journal.

  Both are now indexed: **61ms to 0.01ms, and 56ms to nothing.**

  Deliberately without a schema version bump. This build refuses to open a
  journal written by a different schema, so bumping would have told everybody
  with history to abandon it in exchange for an index. Adding an index changes
  no row and no meaning, the statement is idempotent, and it runs on every
  open -- so an existing journal gains both the next time it is opened, and an
  older build opening the same file afterwards neither notices nor cares.

## 0.6.11 — 2026-09-13

### Fixed

- **A conversation with Gemini died on the round after its first tool call.**
  Gemini 3 signs the reasoning behind every function call it makes, and
  refuses the next request outright if that signature does not come back on
  the part it arrived on: `Function call is missing a thought_signature in
  functionCall parts`. Nothing here was keeping it. The signature is now
  carried through the loop and handed back untouched -- opaque, unread, and
  never shown to anybody.
- **The same failure was waiting in the Claude adapter.** Passing thinking
  blocks back is required when tools are in play, and the adapter was
  rebuilding each assistant turn out of its text and its tool calls alone --
  so the first tool call would have worked and the round after it would have
  been a 400. The thinking blocks are kept in the order they were produced,
  signature intact, and go back at the front of the turn they belong to.
- The loop between the two is what actually lost them, and now has a test of
  its own: the adapters were each correct in isolation.

Nothing changes for OpenAI-compatible endpoints -- Mistral, Ollama, LM Studio,
vLLM, OpenAI itself. That protocol asks for nothing back, and inventing
something to send would be worse than sending nothing.

## 0.6.10 — 2026-09-13

### Added

- **Every model is told where it is before anybody says anything.** A model
  arrives knowing how to call tools and nothing about why these particular
  ones behave the way they do -- so a held call reads as a malfunction and it
  goes looking for a way around it. That is the one behaviour this product
  cannot tolerate, and it was not the model's fault: nobody had told it. Now
  it is told, in the same terms for Claude, Gemini, and anything on an
  OpenAI-compatible endpoint, local models included. What Synartesis is, what
  the recording is for, what the four classes mean, and the one rule -- never
  reach for a different tool that does the same thing without being held.
- **Each tool carries its own class, in its own description.** `write_file`
  now says it is reversible and that what it replaces is copied first;
  `move_file` says it cannot be undone and will be held for approval; a tool
  the policy does not describe says it is treated as the worst case. On the
  tool rather than in the prompt, because that is where a model looks when it
  is choosing between two tools that do nearly the same thing -- a note at the
  top of a conversation is read once, this is read every time the list is.
- **The briefing is particular, not general.** It names the servers actually
  connected, the session this conversation is recorded as, today's date, and
  the calls that will stop and wait -- by name. "Some calls are held" cannot
  be planned around; "fs.move_file is held" can.

## 0.6.9 — 2026-09-13

### Added

- **A rate limit is waited out rather than handed over.** Every hosted
  provider refuses when requests arrive too fast, and every one of them says
  how long to wait. A turn that fails on that has not gone wrong, it has
  arrived early, and reading a paragraph of JSON and pressing send again is
  the application failing to do something it knows exactly how to do. It now
  waits the stated time and tries again, at most twice, and says so on its own
  line while it waits -- a window that silently stalls for a minute is
  indistinguishable from one that has hung. It will not retry after the model
  has started speaking: a retry replays the request from the beginning, and
  words already on screen would be said twice.

### Changed

- **A quota of zero is not a rate limit, and the difference is the whole
  point.** A free Google key asking for a Pro model is told `limit: 0` and
  "please retry in 23s" in the same breath. Both are true and only one is
  useful: there is no allowance to come back to, so that retry succeeds on no
  schedule at all. The window now separates them -- a spent quota says how
  long to wait, a quota that was never there says to turn on billing or pick
  another model, and nothing waits for it.
- **The presets start on models a new key can actually use.** Gemini pointed
  at a Pro preview and Mistral at `mistral-large-latest`; a free Gemini key is
  allowed none of the former and an entry Mistral key is refused the latter
  outright. A preset is a first impression, and greeting somebody with a quota
  refusal on their first message is a poor one. Gemini starts at
  `gemini-3.8-flash` and Mistral at `mistral-small-latest`, with a note saying
  what billing buys. Anyone already set up keeps what they chose.
- **Refusals name the model, not the adapter.** They read
  "gemini-3.1-pro-preview", not "gemini:gemini-3.1-pro-preview".

### Fixed

- The Gemini adapter's fallback model was `gemini-3-pro-preview`, which Google
  retired. A default nobody set has to be one that answers.

## 0.6.8 — 2026-09-13

### Added

- **The model name can be changed in the window.** Every provider retires
  models on its own schedule, and when one goes the request fails with a 404
  naming its replacement. Until now the only way out was editing a JSON file
  with the application closed, to keep using a service already paid for. The
  sheet -- **Models and keys** now, since it does two jobs -- shows the name
  each model points at and lets it be retyped. The key stays: it belongs to
  the account, not to the model name.

### Changed

- **A provider's refusal arrives as a sentence.** Each of them says no in its
  own dialect wrapped in its own JSON, and the window showed the wrapper. The
  three that happen in practice now read plainly: a retired model says what
  replaced it, a model the plan does not include says it is the plan, and a
  refused key points at where keys are kept. The original text is kept
  underneath, because a guess dressed as an explanation is worse than both.

  Anything unrecognised is passed through exactly as it arrived.

- **Gemini's default is `gemini-3.1-pro-preview`**, which is what Google
  replaced `gemini-3-pro-preview` with.

## 0.6.7 — 2026-09-13

### Fixed

- **A card no longer says a refused call cannot be undone.** A call that was
  denied, or is still waiting for a person, changed nothing -- and the card
  said "no way back recorded" about it, which reads as damage nobody can put
  back. It now says nothing was applied, and why: refused before it reached
  the system, or held and waiting for a decision. On this product, of all
  products, that sentence has to be right.

- **The site could render blank where nothing is looking at it.** Sections
  arrive as they are scrolled to, which an IntersectionObserver decides -- and
  an observer only fires while the page is actually being rendered. A tab
  loaded in the background is not: the browser suspends the lifecycle, the
  callback never runs, and every hidden state stays hidden. Harmless when
  somebody switches to the tab, and not harmless for anything that renders a
  page without showing it. Three seconds with nothing arrived now shows the
  page whole, finishing the states rather than starting them, since a
  suspended tab freezes a transition where it stands.

### Changed

- **The logo in the empty room is the pale one**, so it sits on the page
  rather than on a dark tile stuck to it. Same artwork, same generator.

- **A thousand lines of generated coordinates are gone.** Nothing had drawn
  the mark from them since the logo became a file; the window, the icon and
  the cards all show the picture now.

## 0.6.6 — 2026-09-13

### Changed

- **The logo is a file now, and every surface shows that file.** 0.6.5 made
  the drawings agree; this stops there being drawings. `brand/synartesis-mark-1080.png`
  is the logo -- the framed mark with its fringe, on its ground -- and the
  window, the site masthead, the favicon, the touch icon and the cards all
  display it rather than rendering their own version at their own weight.

  The window's mark stops spinning while a turn runs and breathes instead: a
  frame going round and round reads as a fault rather than as work.

## 0.6.5 — 2026-09-13

### Changed

- **One logo, everywhere.** The mark is generated -- one set of numbers behind
  the window, the application icon, the site and the cards on the README --
  but three surfaces had been drawing their own version of it instead: the
  rail beside the wordmark, the site masthead and favicon, and the brand PNGs
  each had a hand-drawn circle with an arrow that resembled the mark without
  being it.

  They now all show the generated one. Where the fan of five hundred
  hairlines cannot survive -- a favicon, a 22px rail -- the generator emits
  the identical geometry filled rather than combed, so it is the same glyph at
  a different weight rather than a different drawing. `brand/mark.html` draws
  nothing of its own any more; it displays `synartesis-logo.svg`, which the
  generator writes.

## 0.6.4 — 2026-09-13

### Changed

- **The API keys sheet gives the key a line of its own.** Somebody opens that
  sheet to do exactly one thing, and the field for it was squeezed into a
  column beside a paragraph of prose, sharing a row with the model's name and
  its note -- while a key is sixty characters or more. The row now explains
  itself on top and the field runs the full width underneath, with a Cancel
  that did not exist before, Escape to leave, a wider sheet and room between
  the rows.

### Added

- **A test for the half the other key tests did not cover.** They prove a key
  never reaches disk, a log, or the window -- all of which would still be true
  of a key quietly dropped on the way to the provider. This one follows it in
  through the sheet, through the keychain seam, and back out as the value the
  request is built with.

### Fixed

- **A transient API error no longer sinks a release.** Nine installers built
  and none were published, because the single call that creates the release
  answered 500 once. Creating and uploading are retried.

## 0.6.3 — 2026-09-13

### Fixed

- **The packaged desktop application could not start.** It opened and died on
  its first import with `Cannot find package '@modelcontextprotocol/sdk'`.
  The bundler keeps a package.json's `dependencies` out of the bundle, which
  is right for a library -- whoever installs it gets them -- and wrong for an
  application that ships as one file plus one native binding. The MCP SDK,
  `yaml` and `zod` were left as bare imports and nothing supplied them. Every
  0.6.2 installer has this; this release is the fix.

  The packaging script now refuses to pack a bundle whose top-level imports
  are not shipped with it. Electron, the native binding and node builtins are
  supplied; anything else has to be inside. Only top-level imports are
  checked, deliberately: bundled libraries carry guarded `require`s for
  optional native accelerators, and those are allowed to be absent.

## 0.6.2 — 2026-09-12

### Fixed

- **The application could not be built on Windows or Linux at all**, which the
  first release build found out the hard way. On Windows, pnpm compiles
  better-sqlite3 from source -- ignoring the `gypfile: false` that tells npm
  not to bother -- and a runner whose Visual Studio is newer than node-gyp
  knows about simply fails. It never needed compiling: the package ships a
  prebuilt binary for every platform it supports, and its loader prefers one
  over anything built locally, so what node-gyp produced here was never
  loaded. On Linux, dpkg refuses to build a `.deb` without a maintainer, and
  nothing named one.

- **The release workflow can be rehearsed.** Run with the tag box empty, it
  builds the branch on all three platforms and publishes nothing. Finding out
  whether a build works should not cost a version number each time.

## 0.6.1 — 2026-09-12

### Added

- **A `release` workflow** builds the application on macOS, Windows and Linux --
  each on its own machine, since an installer cannot honestly be built anywhere
  else -- and attaches the `.dmg`, `.exe`, AppImage and `.deb` to the release
  for a `v*` tag. It signs and notarises where the secrets exist and produces
  unsigned builds where they do not, so a fork of this repository can still
  build it.

### Fixed

- **The packaging script could not have run on Windows.** It started
  electron-builder through the shim in `node_modules/.bin`, which is a `.cmd`
  there and something node will not spawn without a shell. It runs the
  builder's own entry file instead -- the same file on every platform -- and
  the check that refuses a stale bundle now knows where Windows and Linux keep
  the archive as well as where macOS does.

- **An empty secret is not a certificate.** A CI job passes every secret it was
  told about whether the repository holds one or not, so a build with no
  signing certificate was handed `CSC_LINK=""`. electron-builder reads
  "defined" as "use it": it took the empty string for the path to a
  certificate, resolved it against the project directory, and stopped with
  "`<repo>/app not a file`" -- a message with no visible relationship to its
  cause. Blank credentials are dropped before the builder starts, so a build
  without a certificate is simply unsigned.

- **A `.DS_Store` could make a current bundle look stale.** Finder leaves one in
  any directory somebody has looked at, and the staleness check was counting it
  as input to the bundle even though nothing packs it.

## 0.6.0 — 2026-09-12

### Added

- **A desktop window.** You talk to a model; every tool it calls goes through
  the same proxy the CLI installs, so what it did is journalled and reversible
  without the window implementing any of that itself. Each call gets a card
  naming the server, the tool, the class it was given and whether the state it
  replaced was captured; a call that cannot be undone stops and waits for a
  person rather than happening behind one; and "put it back" is the CLI's own
  two steps — the real plan, then the confirmation. Claude, Gemini, Mistral,
  OpenAI, and anything speaking `/v1/chat/completions`, which includes Ollama,
  LM Studio and vLLM on the same machine. Keys are pasted by you and kept in the
  OS keychain; they are never written to the journal or a log.

  It is a separate download rather than part of this package: a browser engine
  inside a CLI would put 200 MB into every install of a command that is a few
  hundred kilobytes. Both share one journal, so either can undo what the other
  did.

- **`synartesis desktop`** opens that window if it is installed, and says where
  to get it if it is not.

### Fixed

- **Opening the window no longer leaves an empty session behind.** A run is
  begun whether or not anybody says anything, and closing one is a chain of
  waits — each server is asked to stop, and a child process takes its time
  going. Quitting the application ended the process partway through, so the
  empty row survived: thirteen of them in one afternoon of testing, thirteen
  lines of `synartesis list` between somebody and the run they were looking for.
  The tidy-up now happens before the servers are waited on — nothing can be
  recorded once the model's client is shut, so the count is already final — and
  quit is held until the engine has put itself away.

- **A held call explains itself in words.** An MCP server returns its errors as
  a content envelope, and the most common reason of all — the file does not
  exist yet, so there is nothing to keep — was reaching the screen as a wall of
  `{"content":[{"type":"text"...` with the sentence that mattered inside it.

## 0.5.2 — 2026-09-10

### Changed

- **The README is a third of its former length** — 714 lines to 210. It had
  grown a full walkthrough and a manifest-authoring guide, both of which already
  exist in the user guide, so it was three documents pretending to be one and
  the first screen was a long way from `npm install`. What is left is the
  argument, the two real terminal shots, install, the four classes, the commands,
  and the limits; the walkthrough and manifest authoring are one link away.

  It also documents what has shipped since it was last written: `show --live`,
  `show --full`, `undo --force [--yes]`, `undo --replan`, the `l` key and the
  rest of the screen's keys, `SYNARTESIS_SYNC`, and which policies are actually
  proven against a real server rather than merely checked for tool existence.

  No code changed. npm cannot refresh a package page without a version, and this
  also carries 0.5.1's latency fix to anyone installing from npm.

## 0.5.1 — 2026-09-10

### Changed

- **The journal is back to `synchronous = NORMAL`, reverting 0.5.0.** The
  argument for FULL was right and the measurement behind it was taken on the
  wrong machine.

  This proxy commits three times per tool call — the pending row, the snapshot,
  and the outcome — and under FULL each commit is an fsync that has to reach the
  platter. On the NVMe it was benchmarked on, that is microseconds, and the
  change looked free: 0.0246 ms per write against 0.0594. On a CI runner, a
  container, or anything with networked storage an fsync is tens of
  milliseconds, and three of them put the proxy's p95 overhead at **132 ms
  against a 10 ms budget**. CI caught it on the release that shipped it, having
  been green on every commit before.

  The three commits cannot be collapsed into one: the snapshot has to be durable
  *before* the call goes out, which is the entire point of taking it. So the
  cost is structural, and the default returns to the setting whose cost is
  predictable. `SYNARTESIS_SYNC=full` asks for the fsync where it is cheap or
  where the tail of the log matters more than latency.

  What is given up is stated plainly: under NORMAL, a crash of the process or of
  the CLI mid-undo still loses nothing, but the machine losing power can cost
  the tail of the write-ahead log — and what is at that tail is the record of
  calls that really happened.

  The performance thresholds that caught this were left exactly where they were.
  A 10 ms budget that fails at 132 ms is a budget doing its job.

## 0.5.0 — 2026-09-10

A safety release. Two more races of the same family as 0.4.2's, one structural
change so that family cannot be written again, the first proof that a shipped
policy actually restores anything, and durability by default.

Minor rather than patch: two behaviours change in ways you will notice.

### Changed

- **The journal is durable by default.** It ran with `synchronous = NORMAL`, on
  the reasoning that the tail of the write-ahead log holds the record of a call
  and never the call itself. True, and the wrong way round: the call reached the
  server or it did not regardless of this file, so losing the record means the
  world changed and the journal does not know. Undo cannot reverse what it has
  no record of, and `show --live` would report that nothing was recorded — the
  reassuring answer, on no evidence.

  Measured here on 2,000 inserts of a 2 kB payload: NORMAL 0.0246 ms per write,
  FULL 0.0594. Durability costs **0.035 ms per action**, about eight per cent of
  the proxy's own 0.43 ms overhead. `SYNARTESIS_SYNC=normal` restores the old
  behaviour.

- **An interrupted inverse no longer resumes itself.** An action in
  `rolling_back` was let through without a claim, on the reasoning that it must
  be a crash. It is also what a live undo looks like between claiming an action
  and finishing its inverse, and nothing here can tell those apart, so a second
  undo starting in that window sent the same inverse again. It now halts and
  names the evidence to look at. Finishing such an inverse needs a lease that
  distinguishes a live owner from an abandoned attempt, which needs a schema
  and a migration path this build does not have; that limit is now stated
  rather than silently crossed.

### Added

- **Adapter contract tests for the shipped filesystem policy**, run against the
  real server. Policies were checked only for tool *existence* — that
  `fs.read_text_file` is a real tool — and never for whether the declared
  inverse puts the file back. That is the failure mode that looks fine: a real
  tool, a clean resolution, a report saying `rolled_back`, and the file still
  wrong. Drift detection cannot catch it, because nothing is wrong with the
  drift.

  The tests make the mutation, undo it and compare bytes: exact restoration
  including trailing whitespace and non-ascii, repeated writes to one file, a
  colleague's edit refused, absence told apart from a read that failed, and
  inspection distinguishing a touched file from an untouched one. Changing the
  inverse to restore `$.content` instead of `$snapshot.content` fails them.

  The tested server version is named in the file. **memory, git and github ship
  policies with no such proof**; those servers are not installed in this
  repository and their guarantees remain assumed.

### Fixed

- **Every status change now goes through one door.** Three of thirteen
  transitions were conditional; the other ten wrote whatever they were told and
  were safe only by convention. The convention failed three times in two days.
  There are now two ways to change a status and no third: one reports whether it
  won the race, the other names the statuses the caller must be holding and
  throws when the row is not in one of them. Turning it on found three states
  nothing can produce, all of them in tests that had been setting end states
  directly.

- **A second place one approval could authorise two calls.** The
  missing-prior-state branch ignored the result of spending the approval.

## 0.4.3 — 2026-09-10

A correctness release. Seven reproduced defects in how effects are accounted
for and how recovery is planned. Each is pinned by a test that fails against
0.4.2 on real state and inverse-call counts, not on messages.

The theme is one mistake made in seven places: treating absence of evidence as
evidence. An error was read as proof nothing happened, a missing post-state as
permission to write anyway, a stripped rule as proof of absence, and an
unreadable resource as one with nothing left applied.

### Fixed

- **A timeout after the write was recorded as never applied.** The uncertainty
  check knew only "Connection closed" and a downstream abort, so an upstream
  that mutates a record and then times out fell through to `failed` — and
  rollback steps over a failed action without looking at it. The change was
  invisible to recovery.

- **`isError` was treated as proof of a refusal.** The protocol gives the flag
  no transactional meaning: it covers business-logic failures that happen after
  a write as readily as a refusal before one.

  Both now ask instead of assuming. Where a pre-read was declared, that same
  read says what is true now, and comparing it against what was there before
  turns a guess into evidence: unchanged is recorded as never applied, changed
  is recorded as applied so it can be undone, and a read that cannot answer
  leaves the outcome unknown. Only evidence of no dispatch — no transport, or a
  JSON-RPC rejection of the envelope — is now recorded as definitely not
  applied. Where there is no pre-read to ask, an adapter can state the
  guarantee itself with `refusal: clean` on a tool policy; the default is
  `uncertain`.

- **Undo overwrote human edits when the post-state was missing.** A reversible
  action promises evidence. Where the post-read failed at capture, rollback
  reverted anyway, labelled it unverified and reported success — writing the
  old value over whatever was there, with no `--force` required. It now halts
  and says which half of the evidence is missing. `--force` is how a person
  decides to proceed; the step stays unverified in the report. Compensable
  actions, whose policies declare no pre-read at all, are deliberately not
  caught by this.

- **`absentWhen` was stripped on the way back in.** Rollback and inspection
  each parsed a stored verify read through a schema naming only server, tool
  and args, so the absence rules were dropped and every read failure became
  "the resource is gone". A "permission denied" was reported as a definite
  change and could send an inverse. There is now one shared schema for a stored
  read.

- **`--replan` could not recover a resolved conflict.** Taking the halt's own
  advice — put the resource back, then replan — passed every check and then
  failed to claim the row, reporting that another undo held it, which was never
  true. Unresolved drift still halts.

- **Preview invented drift it would never meet.** Undo puts intervening states
  back as it walks down; a preview sends nothing, so an older write to a
  twice-written record was compared against the newest value and called drift.
  The preview now carries the state each planned inverse would leave, and only
  where that is knowable — a compensation stops the chain rather than guessing.

- **Inspection claimed nothing was left applied about resources it could not
  read.** The summary counted only changed and unchanged, so an unreadable
  resource fell through to the most reassuring sentence available. Unknowns are
  now said first and never absorbed into a clean answer; `tally()` exposes the
  counts. A failed post-read is also no longer reported as "no pre-read was
  declared".

- **A second place where one approval could authorise two calls.** The
  missing-prior-state branch ignored the boolean from `adoptApproval`, so a
  caller that lost the claim proceeded anyway. It now asks, like the gate path.

## 0.4.2 — 2026-09-09

Three bugs, found by auditing the paths the last pass did not touch. Each is
pinned by a test that fails against 0.4.1.

### Fixed

- **One approval could authorise two irreversible calls.** Spending a standing
  approval was an announcement rather than a claim: `markInFlight` and
  `adoptApproval` both wrote unconditionally, so two proxies — which share one
  journal, the reason `close` is never automatic — could read the same approved
  row before either had used it, and both proceed. One person's yes, two emails
  sent, which is the single thing this is here to prevent.

  Both are now conditional on the row still being `approved` and report whether
  they won it. `adoptApproval` spends first and only carries the approval across
  if it did. The proxy treats losing the race as never having had an approval:
  it asks. The guard already existed for inverses, and its comment describes
  this exact failure; the approval path never got one.

- **`prune` deleted sessions still waiting on a person.** `--help` and the
  README both promise that nothing waiting on a person is ever pruned. The query
  enforced it for `pending`, `gated` and `rolling_back`, and not for the two
  other statuses that mean the same thing: `approved`, somebody's yes the agent
  has not spent, and `unrecoverable`, an undo that stopped because somebody had
  changed the resource and is waiting for them to choose. Pruning the first threw
  away a human decision; the second threw away both the conflict and the undo
  they were deciding about.

- **Forcing an undo walked around the double-apply guard.** `markRollingBack`
  claims an action by moving it out of `applied`, so two rollbacks cannot both
  send one inverse. `undo --force`, added in 0.4.1, acts on rows an earlier
  refusal left `unrecoverable` — which the claim did not know about, so it never
  claimed them and never reported that it had not. Two concurrent forced undos
  both sent the inverse: harmless for an idempotent write, a second real change
  to the world for a compensable one.

## 0.4.1 — 2026-09-09

### Added

- **`synartesis show <session> --live`**, and `l` in the screen. Synartesis
  records what an agent does, not what happens to a file — nothing you do by
  hand goes through the proxy. That is what makes the drift check work, and it
  meant the commonest question about this tool had no answer: has somebody
  edited that file since? You found out by attempting an undo and having it
  refuse.

  `--live` reads every resource the session touched as it is now and says
  which of them still match what the run left. Nothing is written, no
  reversing call is sent, and no row changes status. Unlike `undo --dry-run`
  it does not stop at the first conflict: a session with five writes reports
  on all five.

  An earlier write to a resource is reported as superseded rather than
  changed. Undo walks backwards, so each older write is checked against a
  state the one above it restores; measuring them all against the world as it
  is now would call every write but the last one changed.

### Fixed

- **Undo acted on a session nobody was looking at.** One cursor serves four
  views, and in the held-calls and connections lists its number counts
  something else entirely — but `u`, `p` and `l` read it against the sessions
  regardless. `g`, `j`, `u`, `y`, four keys pressed while looking at the list
  of held calls, undid a session that was never on screen. That is the failure
  this tool exists to prevent, committed by the tool. Those keys now do
  nothing outside the session views and say why.

- **`--force` showed one conflict and overwrote several.** The ask ran a
  dry-run rollback, and a rollback halts at the first drift — so with two
  people's edits underneath it, one diff was printed, `--force --yes` was
  typed, and both were written over. It now reads every conflict and prints
  each one.

- **One broken server stopped you undoing anything at all.** `install` covers
  every AI on the machine with one policy, so a manifest routinely names
  servers that have nothing to do with the session in hand — and undo started
  all of them. An entry whose command is not there made every session
  unreadable and unundoable. Undo and `--live` now start only the servers the
  session actually went to, and skip with a reported reason any that still
  will not start. `--replan` still starts everything, since it re-resolves
  inverses from the current policy.

- **`--force` ignored `--to`.** A change below the floor — an action the undo
  would not touch — refused the whole command.

- The overwrite warning in the screen now expires with the diff that
  justified it, so the second `u` cannot be answered after the evidence has
  scrolled away. `--yes` without `--force` says it is being ignored rather
  than being silently dropped, and `--live` no longer starts every server to
  inspect a session that recorded nothing.

## 0.4.0 — 2026-09-08

### Added

- **`synartesis install`.** One command wraps every server your MCP client
  already lists. It knows Claude Code, Claude Desktop, Cursor and Codex, finds
  their config files, writes a policy covering everything it finds — adopting
  the bundled policies where they fit — and points each entry at the proxy.
  `uninstall` puts the configs back; `status` says what is covered.

  Setting a single server up used to mean reading your client's JSON, retyping
  the command into `init`, hand-editing the policy, then editing the JSON back.
  Two hand edits across two files, per server, which is most of the reason
  anyone gave up before seeing an undo work.

  Your config is copied aside first, the write lands by rename rather than in
  place, a file that does not parse is refused rather than repaired, and every
  key we do not recognise is carried through. Codex's TOML is edited by line so
  its comments, ordering and env subtables survive.

- **A connections screen**, on `c` in `synartesis`. Every AI on the machine,
  whether its config points here, and when anything last actually came through
  it — read from the journal, which records the server on every action, rather
  than guessed from processes. `enter` connects one, `a` connects everything
  uncovered, `r` rescans. Nothing is written without a keypress.

- **`--server <name>` on the proxy**, so one policy can back several client
  entries. A proxy carrying two servers has to qualify tool names to tell them
  apart, which renames every tool the agent already knows; one entry per server
  keeps the names.

- **`synartesis show <session> --full`**, and `f` in the screen: every argument,
  the captured snapshot and the inverse, pretty-printed with nothing elided.

### Fixed

- **A tool a client would not call at all.** The official filesystem server
  declares its `outputSchema` as JSON Schema draft-07, and a client whose
  validator only knows 2020-12 refuses to call the tool — nothing reaches the
  proxy, and there is nothing in the journal to explain the silence. The
  dialect is now dropped from advertised output schemas. `inputSchema` is
  untouched, so the tool list is byte-identical wherever a server declares no
  output schema.

- **Times are shown where you are standing.** The journal stores UTC, which is
  right, and every view printed that UTC string unchanged — so somebody in
  Kolkata watching an agent work saw 10:05 while their own clock said 15:35.

### Changed

- **Actions read as sentences.** `10:36:56 reversible rolled_back
  sim.edit_file`, twelve times over, is a class and a status and never once
  which file. Rows now say the server, the tool, what it acted on and what it
  means: `15:36:56 sim edit_file loadtest.mjs undone`. Arguments are summarised
  rather than truncated JSON; `--full` shows everything.

- **`synchronous = NORMAL` under WAL.** Measured on the journal alone: writes
  0.188 → 0.125 ms per action, rollback marks 0.079 → 0.039 ms. A crash of the
  process still loses nothing; only the machine going down can cost the tail of
  the WAL, and what is there is the record of a call, never the call.

- Headings and names are a softer ink. Bold near-white smears at terminal
  sizes, and the palette only works if one thing is bright.

- **A halt says what it refused, not only that it stopped.** `halted: halted
  here on an earlier attempt` explains nothing; the sentence worth reading is
  the one saying somebody edited the resource since. And a dry run now re-reads
  the world rather than quoting the message from the last attempt — that halt
  exists so a retry cannot silently repeat what a person stopped, and a dry run
  writes nothing, so it is not a retry.

- **Undo says which session, before acting on it.** Without an id it takes the
  most recent, which is not necessarily the one on your screen — somebody undid
  a session they were not looking at and read the result as the tool acting on
  its own. It now names its pick first, and where that session is empty it says
  so and names the one that did something.

### Fixed (undo, from using it)

- **`u` in the screen appeared to do nothing.** A client that connects and calls
  nothing still opens a session, so the newest one is regularly empty while the
  one you mean is a line below it. Pressing undo on it confirmed, reverted zero
  and said nothing about why. `u` and `p` now count what could actually be put
  back first, and answer with the reason and the id of the session that has
  something.

- **The screen prints the command for what `u` would do**, for the session under
  the cursor: `synartesis undo <id>`. A screen that only answers keystrokes
  gives you nothing to carry to another window and nothing to check when a key
  seems to have done nothing.

### Added (drift)

- **`undo --force`**, for a resource somebody changed after the run. Asked for
  twice: on its own it reads the world, prints the lines it would write over,
  and writes nothing; `--force --yes` goes ahead. Two flags rather than a
  prompt, so it reads the same in a terminal and in a script.

  A refusal with no way past it is half an answer. The halt now carries what
  undoing would overwrite — not only what changed since the run, which is
  history, but which of *your* lines would go — and prints the three ways on as
  three commands: leave it, put the resource back and `--replan`, or `--force`.

  In the screen, a conflicted session says so and names the command. `u` shows
  the overwrite diff, and only a second `u` will offer to do it, with `y` still
  required after that.

## 0.3.4 — 2026-09-03

### Changed

- **The README shows what the tool does.** It opened with a heading and five
  badges, and nothing above the fold showed a single line of output — for a
  tool whose whole argument is what its output looks like. It now carries a
  header lockup and two terminal shots of real output from
  `demo/filesystem-demo.sh`: a clean rollback, and an undo halting on drift
  rather than overwriting a colleague's edit.

  This is the only reason for the release. npm cannot refresh a package page
  without a version, so 0.3.3 kept serving the old README while the repository
  served the new one. **No code changed**: every file under `dist/` and
  `manifests/` is byte-identical to 0.3.3, verified by unpacking the published
  tarball and diffing it against this one.

## 0.3.3 — 2026-09-03

### Changed

- **Source maps no longer ship.** They were 385 kB of a 603 kB install and
  nothing ever read them: no `--enable-source-maps` in the shebang, nothing
  calling `setSourceMapsEnabled`, nothing in `package.json`, so Node never
  consulted them. Verified they are not load-bearing by deleting them and
  running the CLI, the error paths and the proxy, with and without
  `--enable-source-maps`: no warning, no error, identical output. The package
  goes from 17 files to 13, 164 kB to 61 kB packed, 603 kB to 219 kB
  unpacked. They are still generated for local development.

### Fixed

- **The documented snapshot ceiling was wrong.** The README and the site both
  said a resource over roughly three megabytes cannot be captured and the
  write is refused. Measured against the bundled filesystem policy: a 4 MB
  file was captured whole and restored byte for byte, and 8 MB and above was
  refused with the file untouched. The number was wrong in the user's favour,
  which is still wrong on the one page whose job is to be exact about limits.
  Where the ceiling falls depends on the server and its transport, so the
  text now says a few megabytes and carries the measured figures. The
  behaviour was never in doubt: when the pre-read cannot complete, the write
  does not happen.

## 0.3.2 — 2026-08-30

### Fixed

- **A drift halt shows what changed, not both documents.** Halting on drift
  printed the expected and actual contents of the resource in full. On a
  200-line file that is two screens of escaped JSON with the one line that
  matters buried inside, which is the same as not saying. It now trims the head
  and tail the two sides agree on and prints only the region that differs,
  capped at eight lines a side:

  ```
  drift at sequence 4: the resource is not in the state this run left it in.
    at line 123:
    + // A HUMAN FIXED THIS BY HAND.
    0 removed, 1 added.
  ```

  Both values are still on the row, and `synartesis show` prints them.
- **And it no longer crashes on a snapshot it cannot walk.** Finding the text
  to diff, and the fallback for when there is none, both recursed — so a
  snapshot nested a few thousand levels deep turned a drift halt into a stack
  trace, at exactly the moment a person needs to be told their work is at risk.
  Walked with an explicit stack now, with a node cap, and the fallback catches.

## 0.3.1 — 2026-08-30

### Fixed

- **`--older-than` no longer crashes on a number too large to be a date.**
  `Number.isFinite` is true for 1e9, but a cutoff that many days back sits
  before the earliest date a `Date` can hold, so `toISOString` threw and
  `synartesis prune --older-than 999999999` answered `Invalid time value` and
  exited 1. That names neither the flag nor the problem, and exit 1 means
  "halted or refused" — so it read as a prune that had failed partway through
  rather than a mistyped argument. Bounded to 0–36500 days, with the range in
  the message and exit 2 where it belongs.
- **A journal that cannot be read is reported as unknown, not as `1 kB`.**
  `sizeOf` could never throw, because the function it called already swallowed
  the error and returned zero, so the "unknown" branch was unreachable and a
  missing file was reported at a confident wrong size.

### Documentation

- `synartesis prune` is on the landing page, which listed eleven commands and
  not the twelfth.
- The doc comment promising that a failed journal write is never swallowed sits
  on the method that does that again, rather than on `prunableRuns`, which is a
  read and promises no such thing.

## 0.3.0 — 2026-08-29

### Security

- **The journal is no longer world-readable.** To put a file back, what was in
  it has to be kept — so the journal holds the previous contents of everything
  an agent wrote, the arguments of every call, and every reply. SQLite created
  it at whatever the umask allowed, which is `0644` on an ordinary machine: a
  key that happened to be in a file your agent touched was readable by every
  other account. It is now created `0600`, in a directory Synartesis makes
  `0700`, and `0600` is re-applied on every open so a journal written by an
  older version is closed the first time a newer one touches it.

  A directory that already exists is deliberately left alone: a journal can sit
  beside a policy inside a project, and quietly making your project directory
  `0700` would be the worse surprise. If your `~/.synartesis` predates this
  release, `chmod 700 ~/.synartesis` is worth doing once.

### Added

- **`synartesis prune`.** Every write stores the resource as it was, as it
  became, and the call between them, so a journal grows at about four times
  what an agent writes and never shrinks — thirty edits of one 200 kB file came
  to 24 MB, with nothing in the tool or the docs saying so. `prune` deletes
  runs finished more than 30 days ago (`--older-than <days>`, `--dry-run`) and
  then `VACUUM`s, because deleting rows alone leaves a SQLite file exactly as
  large as it was. That 24 MB journal came back to 32 kB.

  It never touches a run that is still active, or one holding a call that is
  waiting on a person or whose outcome is unknown: age is not an answer to a
  question nobody answered. It names the journal it is about to act on, since
  a journal is found by walking up from where you are standing. Nothing prunes
  on a timer.
- **`synartesis --version`**, which until now answered `unknown flag
  --version` and exited 2. Also `-V`.
- **`SECURITY.md`**, with a private reporting route and a plain account of what
  the journal contains.

### Documentation

- The README says what the journal holds, what it is chmodded to, how fast it
  grows and how to keep it in hand. None of that was written down anywhere.

## 0.2.4 — 2026-08-25

### Changed

- **The toy CRM and the demo agent no longer ship.** They exist to make this
  repo's walkthrough work, and that walkthrough is run from a clone — so
  installing put a fixture server, a demo harness and a policy pointing at a
  binary that is not there onto everyone's disk. `manifests/toy-crm.yaml` goes
  with them for the same reason. 21 files down to 16, 162 kB to 152 kB.
  Nothing a user runs is affected: `synartesis`, `synartesis proxy`, the four
  real policies and the HTTP mode are all untouched.

## 0.2.3 — 2026-08-22

### Fixed

- **A first run reads as empty rather than as an error.** The screen and `watch`
  have always said "one appears the first time an agent calls a tool through the
  proxy"; `list`, `show` and `gates` aborted with "there is no journal at
  <path>", which is true and leads nowhere. They exit 0 and say the same
  sentence now, without creating a journal for having looked. `undo` still fails
  — there is nothing to undo — but names `synartesis proxy`, and a missing
  policy names `synartesis init`.
- **`absent_when` on every bundled policy.** It was declared for files and
  nowhere else, so GitHub's three snapshots still read a permissions change or a
  rate limit as "there is nothing here" and offered the write for approval as a
  creation. A test now requires it of every snapshot that ships.
- **Idle HTTP sessions are swept.** A session was removed only on a clean close,
  so a client that dropped left its proxy and upstream handles held for the life
  of the process. Half an hour by default, `--http-idle` to change.

### Added

- `--http-idle <seconds>` on the proxy.
- README: `absent_when`, `synartesis close`, and the snapshot size limit — a
  resource over roughly three megabytes cannot be read back through stdio, so
  writes to it are refused rather than risked.

## 0.2.2 — 2026-08-22

### Fixed

- **Several agents sharing one journal no longer lose calls.** Eight proxies
  writing at once lost two of their tool calls to `database is locked`, and
  sharing a journal is the arrangement this tool recommends. Two causes: SQLite
  was never told to wait for a contended write, and the transaction that
  records an action reads the highest sequence number before inserting — a
  lock SQLite will not upgrade while another writer has committed in between,
  which `busy_timeout` does not cover. It takes the write lock up front now.
  Sixteen at once, four rounds: every call recorded, nothing locked out.
- **A pre-read that fails twice on a fresh connection says the reply may be too
  large.** It said "Connection closed", which points at nothing. A file of more
  than a few megabytes cannot be snapshotted, and a write that cannot be
  snapshotted is refused rather than risked — but you had no way to know that
  was the reason.

## 0.2.1 — 2026-08-22

### Fixed

- **The CLI refuses a flag it does not know.** `synartesis undo --jounral
  other.db` read the *default* journal and reversed whatever was in it, exit
  zero and no warning: you would be looking at one run and undoing another. The
  proxy has always rejected an unknown flag; the CLI quietly dropped it.
  Everything past a bare `--` is still left alone, since that belongs to the
  server `init` is starting.

  This landed half an hour after 0.2.0 was published, so 0.2.0 does not have
  it.

## 0.2.0 — 2026-08-22

### Added

- **Serving over HTTP**, for clients that will not start a process.
  `synartesis proxy --http <port> --token <secret>` exposes `/mcp` behind a
  bearer token. ChatGPT's connectors are the reason it exists: they take a
  remote HTTPS endpoint and nothing else. It refuses to start without a token
  of at least 16 characters, compares it in constant time, and binds to
  loopback unless `--http-host` says otherwise. Reaching it from the internet
  means putting a tunnel in front of it, which stays a decision you make rather
  than a flag.
- **`absent_when` on a snapshot**, so a policy can say what its server says when
  a thing is not there. Without it every failed pre-read had to be read as
  absence, and a file that existed but could not be read was offered for
  approval as a creation. The bundled filesystem policy declares it, so a
  missing file is held for approval while an unreadable one is refused outright.
- **`undo --dry-run` lists what `--to` excludes.** Choosing where to stop is the
  whole point of the flag, and the plan showed every part of that decision
  except the part you were making.

### Changed

- `--gate-timeout` now warns that it does nothing. It was parsed, validated,
  threaded through and read by nothing: the proxy refuses a held call
  immediately rather than holding the connection open, so there is no wait to
  cut short. Still accepted, because two released versions took it.

## 0.1.1 — 2026-08-22

### Added

- **`init` uses the finished policy when it recognises the server.** Writing a
  snapshot and an inverse for every write is the whole barrier to getting
  anything out of this, and four finished policies already shipped in the
  package unused. The filesystem server goes from four gated TODOs to working
  undo on the first command. Every rule is checked against what the server
  actually advertises first; if one names a tool the server does not have, the
  whole policy is dropped and the TODOs come back. An unrecognised server is
  untouched.

## 0.1.0 — 2026-08-22

First release.

- An MCP proxy that records every tool call with the state it replaced, and can
  put that state back. Four classifications — `readonly`, `reversible`,
  `compensable`, `irreversible` — written down in a manifest. A tool the
  manifest does not mention is treated as irreversible and held for approval.
- `synartesis` opens a full-screen view of everything an agent has done.
  `undo`, `show`, `list`, `gates`, `approve`, `deny`, `watch`, `check`, `close`.
- Undo re-reads each resource before reverting it and stops rather than
  clobbering a change something else made since.
