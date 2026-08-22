# Changelog

What changed, and why it mattered. Dates are release dates.

## Unreleased

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
