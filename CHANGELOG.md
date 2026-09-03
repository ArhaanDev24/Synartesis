# Changelog

What changed, and why it mattered. Dates are release dates.

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
