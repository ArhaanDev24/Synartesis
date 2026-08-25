# Changelog

What changed, and why it mattered. Dates are release dates.

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
