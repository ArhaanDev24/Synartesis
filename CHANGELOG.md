# Changelog

What changed, and why it mattered. Dates are release dates.

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
