# Synartesis

An undo layer for AI agents.

[![check](https://github.com/ArhaanDev24/Synartesis/actions/workflows/check.yml/badge.svg)](https://github.com/ArhaanDev24/Synartesis/actions/workflows/check.yml)
[![MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

An agent with write access to a real system runs twenty steps, misreads step
seven, and applies the rest to the wrong records. Today your options are to
reverse it by hand from the transcript, restore a backup and lose every
legitimate change made in the same window, or accept the damage.

Synartesis sits between your MCP client and the servers it talks to. It records
every tool call with the state that call replaced, and it can put that state
back. What cannot be put back, it refuses to let an agent do unsupervised.

It is not a sandbox: the container your agent runs in is disposable, but the
CRM row it updated over the network is not. It is not a tracing tool: a trace
tells you `update_customer` ran forty times, not what the values were before.

## What it can and cannot do

Every tool gets one of four classifications, which you write down in a manifest:

| Class | Meaning | Example | What happens |
|---|---|---|---|
| `readonly` | Changes nothing | `get_customer` | Recorded, forwarded |
| `reversible` | Prior state can be restored exactly | `update_customer` | State captured before the write; written back on undo |
| `compensable` | Cannot be reversed, but can be offset | `create_charge` | A different call neutralises it |
| `irreversible` | Neither | `send_email` | **Suspended until a human approves it** |

A tool your manifest does not mention is treated as `irreversible`. That is
deliberate: silently forwarding an unknown destructive call is the one failure
worth avoiding most.

## Requirements

| Tool | Version | Check with |
|---|---|---|
| Node | 22 or newer | `node --version` |
| pnpm | 9 or newer | `pnpm --version` |
| A C toolchain | any | `cc --version` |

`pnpm` comes with Node via corepack:

```bash
corepack enable pnpm
```

The C toolchain is only needed if you build from source: npm ships a prebuilt
SQLite binding for common platforms and installs without one. To build from a
clone on macOS run `xcode-select --install`; on Debian or Ubuntu,
`apt install build-essential`.

## Install

```bash
npm install -g synartesis
```

That is for you: the screen, `undo`, `watch`, `approve`. **Your agent needs
nothing installed** — the config block below fetches the proxy on demand.

Or the script, which builds from source and links the same two commands:

```bash
curl -fsSL https://raw.githubusercontent.com/ArhaanDev24/Synartesis/main/install.sh | bash
```

Or from a clone, if you would rather read it first:

```bash
git clone https://github.com/ArhaanDev24/Synartesis.git && cd Synartesis && ./install.sh
```

The script checks your Node version, builds, and links `synartesis` and
`synartesis-proxy` into the first writable directory already on your PATH. It
edits no shell profile and needs no sudo. Pass `--no-link` to build only.

```bash
synartesis --help
```

If nothing could be linked, nothing breaks: every command Synartesis prints
spells itself out in whichever form actually runs on your machine.

## Walkthrough

This uses a toy CRM that ships with the repo, so you can see the whole loop
without pointing anything at real data. Run it from a scratch directory.

```bash
mkdir -p /tmp/synartesis-demo && cd /tmp/synartesis-demo
```

### 1. Write a policy

`init` starts a server, asks it what tools it has, and writes a manifest.
Replace `SYNARTESIS` with the path you cloned into.

```bash
node SYNARTESIS/dist/cli.js init crm -- node SYNARTESIS/dist/toy-crm.js --state ./crm.json
```

For the servers most people start with — files, memory, git, github — `init`
recognises the server and uses the finished policy bundled here, after checking
every rule against the tools that server actually advertises. If a rule names a
snapshot or an inverse the server does not have, the whole policy is dropped
and you get the TODOs instead: a policy whose inverses cannot be called is
worse than none, because it looks done.

The toy CRM below is deliberately not one it knows, so this walkthrough shows
the manual path.

`init` prints the path it wrote to. Unless a policy already sits above the
directory you are standing in, that is `~/.synartesis/synartesis.yaml`. Open it:
every tool that isn't a self-declared read starts as `irreversible` with a
`TODO`. **Working through those TODOs is the job.** A finished policy for this
fixture ships in the repo, so copy it into this directory rather than typing it
out — a policy here takes precedence over the one in your home:

```bash
cp SYNARTESIS/manifests/toy-crm.yaml ./synartesis.yaml
```

Then edit the `args` line so it points at your clone and keeps its data in
this directory. The copy ships with `args: ["dist/toy-crm.js"]`; it needs both
the path to your clone and the `--state` file:

```yaml
servers:
  crm:
    command: node
    args: ["SYNARTESIS/dist/toy-crm.js", "--state", "./crm.json"]
```

### 2. Point your agent at the proxy

Wherever your MCP client lists servers, replace the entry for the server you
want covered with the proxy. For Claude Desktop or Claude Code that is a
`mcpServers` block:

```json
{
  "mcpServers": {
    "crm": {
      "command": "node",
      "args": ["SYNARTESIS/dist/proxy.js", "--manifest", "/tmp/synartesis-demo/synartesis.yaml"]
    }
  }
}
```

That spells out the clone, because this walkthrough runs from one. Outside it,
there is nothing to install first and nothing to point at:

```json
{
  "mcpServers": {
    "synartesis": {
      "command": "npx",
      "args": ["-y", "synartesis", "proxy", "--manifest", "/Users/you/.synartesis/synartesis.yaml"]
    }
  }
}
```

The agent sees the same tools with the same names and the same results. That is
the point: nothing about your agent changes.

For this walkthrough you do not need a real agent. This does the same thing:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo-agent","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"update_customer","arguments":{"id":"c_001","plan":"free","notes":"wrong edit"}}}' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"delete_customer","arguments":{"id":"c_002"}}}' | node SYNARTESIS/dist/proxy.js --manifest ./synartesis.yaml --journal ./journal.db > /dev/null
```

Look at the damage:

```bash
cat crm.json
```

Ada is on the wrong plan with the wrong notes, and Grace is gone.

### 3. See what it did

```bash
node SYNARTESIS/dist/cli.js list --journal ./journal.db
```

```bash
node SYNARTESIS/dist/cli.js show RUN_ID --journal ./journal.db
```

`show` prints each call with its class, its status, and the exact call that
would undo it, already resolved to literal values.

### 4. Undo it

Look before you leap:

```bash
node SYNARTESIS/dist/cli.js undo RUN_ID --dry-run --journal ./journal.db
```

Then do it:

```bash
node SYNARTESIS/dist/cli.js undo RUN_ID --journal ./journal.db
```

```bash
cat crm.json
```

Grace is back and Ada is on her original plan, with her original notes.

### 5. Watch it refuse

Undo is not a blunt instrument. If something else changed a record after the
agent touched it, writing the old value back would destroy that work, so
Synartesis stops and shows you both values.

Run the damage command from step 2 again. That creates a second run, so take
the run id from the top of `list`, which is ordered most recent first. Then
edit the record by hand:

```bash
node -e 'const f="./crm.json",s=JSON.parse(require("fs").readFileSync(f));s.customers.c_001.notes="a human wrote this";require("fs").writeFileSync(f,JSON.stringify(s,null,2))'
```

```bash
node SYNARTESIS/dist/cli.js undo RUN_ID --journal ./journal.db
```

It halts at the record that moved, prints the expected and actual state, and
exits non-zero. It is not all-or-nothing: undo works newest first, so anything
it had already put back before reaching the drifted record stays put back —
here `delete_customer` is reversed and `c_002` comes back, and then it stops.
`show` afterwards tells you which actions are still outstanding. Once you have
resolved the conflict yourself, `undo --replan` rebuilds the plan against the
world as it now is and carries on.

## Approving what cannot be undone

`send_email` is classified `irreversible`, so the agent cannot send one on its
own. The call is **refused immediately** with an action id and the command that
would approve it. The agent tells you, you decide, and it tries again.

It does not hold the call open while waiting. That was the first design and it
does not survive contact with a real client: every useful window for a person
to notice, open a terminal and decide is longer than a client will wait for a
tool, so the two cannot be reconciled by picking a better timeout.

Approval also does not happen on the terminal the agent is using: the proxy
talks MCP over stdin and stdout, so there is nothing there to prompt on, and a
desktop client has no terminal at all. The request goes to the journal, and you
answer it from anywhere:

```bash
node SYNARTESIS/dist/cli.js gates --journal ./journal.db
```

```bash
node SYNARTESIS/dist/cli.js approve ACTION_ID --by your-name --journal ./journal.db
```

```bash
node SYNARTESIS/dist/cli.js deny ACTION_ID --by your-name --reason "not this one" --journal ./journal.db
```

An approval is **single use** and expires after an hour, so it covers the retry
it was granted for and cannot quietly authorise the same call tomorrow. It is
not tied to one session, because people restart their client and an approval
stranded in a dead session would be no approval at all.

Nothing is ever approved by silence. An unanswered request simply stays
unanswered, visible in `synartesis gates` until someone decides.

The agent is told all of this when it connects, so it can explain itself rather
than reporting an opaque failure.

## Real servers

If you would rather follow steps than read about it, there is a
[guide to running this against your own files](TESTING-ON-A-REAL-SYSTEM.md),
with the gate and the drift check as the two things worth testing on purpose.

Synartesis has nothing to do with email in particular. It sits on the MCP
protocol, so its subject is whatever the servers you have connected can do:
your files, your repositories, your database, your tickets, your agent's own
memory. What it can undo depends entirely on what those servers expose, and
each manifest below says plainly where that runs out.

| Manifest | Server | State it governs |
| --- | --- | --- |
| [`filesystem.yaml`](manifests/filesystem.yaml) | `@modelcontextprotocol/server-filesystem` | real files on disk |
| [`memory.yaml`](manifests/memory.yaml) | `@modelcontextprotocol/server-memory` | the knowledge graph an agent keeps about you |
| [`git.yaml`](manifests/git.yaml) | `mcp-server-git` | a real repository's index and history |
| [`github.yaml`](manifests/github.yaml) | `github/github-mcp-server` | issues, pull requests, file contents |
| [`toy-crm.yaml`](manifests/toy-crm.yaml) | the fixture in this repo | the worked example of every class |

Every one of those but `github.yaml` was checked against the server actually
running. Two demos run the whole loop for real:

```bash
./demo/filesystem-demo.sh
./demo/memory-demo.sh
```

The filesystem demo overwrites a file and moves another, restores both, then
shows undo refusing when a human edited the file in between, and the gate
refusing to create a directory this server has no way to remove.

The memory demo is the sharper one. The agent adds two people to the graph, one
of whom was already there, and the server quietly ignores the duplicate. Undo
therefore has to remove exactly one of them: the inverse is built from what the
server said it created, not from what the agent asked for, so the person who
was there first survives being undone. The same session then tries to delete an
entity and is held, because deleting an entity also deletes every relation
touching it and one inverse call cannot put back both.

### Where each one runs out

The limits are the interesting part, and they are properties of the servers
rather than of Synartesis.

- **filesystem**: `move_file` is reversible from its arguments alone, so no
  pre-read is declared and drift cannot be checked for it. `create_directory`
  is `irreversible` not because directories are precious but because this
  server exposes no way to remove one.
- **memory**: `add_observations` and `delete_observations` are exact opposites
  that disagree about what to call the same field. A path can read a field and
  cannot rename one, so that inverse cannot be written at all and the call is
  gated instead.
- **git**: nearly every read this server offers answers in prose meant for a
  person, so almost nothing can be inverted from a captured state however
  reversible the underlying git operation is. Commits are gated because this
  server exposes no reset, no revert, and no way to move a branch.

Two things worth knowing if you write your own, both found by running these
against live servers rather than by reading documentation:

`$result` is the structured block, and it need not match the text one. The
memory server answers `create_entities` with a bare list in its text block and
`{"entities": [...]}` in `structuredContent`. Synartesis walks the structured
one, because that is the machine-readable contract.

And `synartesis check` proves a tool exists, not that a path resolves. It
cannot: no call has been made, so there is no result to walk. Run the thing
once and read `synartesis show` before you rely on an inverse.

## Writing a manifest

The manifest is the whole product. It should take fifteen minutes for an API
you know.

```yaml
version: 1

servers:
  crm:
    command: node
    args: ["./crm-server.js"]

tools:
  - match: "crm.get_customer"
    class: readonly

  # Read the record before overwriting it, then write that record back.
  - match: "crm.update_customer"
    class: reversible
    snapshot:
      tool: "crm.get_customer"
      args:
        id: "$.id"
    inverse:
      tool: "crm.update_customer"
      args:
        id: "$.id"
        name: "$snapshot.name"
        plan: "$snapshot.plan"

  # Nothing to read beforehand; the id only exists once the call returns.
  - match: "crm.create_customer"
    class: compensable
    inverse:
      tool: "crm.delete_customer"
      args:
        id: "$result.id"

  - match: "crm.send_*"
    class: irreversible
    gate: always
```

There are exactly three things a value can refer to:

| Prefix | Refers to | Available in |
|---|---|---|
| `$.` | the arguments the agent sent | `snapshot` and `inverse` |
| `$snapshot.` | what the pre-read captured | `inverse` |
| `$result.` | what the forward call returned | `inverse` |

Anything else is a literal. A reference can stand alone, in which case the
value keeps its type, or sit inside a sentence, in which case it is substituted
as text:

```yaml
sha: "$result.content.sha"                 # the value itself
message: "Revert agent change to $.path"   # text with the path substituted
```

Write `$$` for a literal dollar sign. There are no expressions, conditionals or
functions, and there will not be: the moment this becomes a language it stops
being something you can write in fifteen minutes.

Paths can index a list with `[0]` and read one field from every element with
`[]`:

```yaml
labels: "$snapshot.labels[].name"   # [{name: "bug"}, ...] becomes ["bug", ...]
```

That covers the common case where an API hands a field back richer than it
takes it, which is what GitHub does with issue labels. `[]` reads the same key
from each element and nothing else: it is still a path, not a transform. A
reference copies values, it cannot compute them, so an API needing a genuinely
different shape is one the inverse should leave that field out of, and say so.

Other things to know:

- `match` supports `*`, which matches within one segment: `crm.send_*` matches
  `crm.send_email` but not `crm.a.b`. The most specific pattern wins regardless
  of the order rules are written in.
- The inverse of a patch should restore **every** field, not re-apply a patch.
  If the same record is edited twice in one run, a partial inverse leaves the
  fields the second edit touched behind.
- `gate: on_write` is a heuristic for tools like a raw SQL runner, where
  destructiveness cannot be read from the tool name. Anything it cannot
  confidently read as a single read statement is gated. Use `gate: always`
  wherever certainty matters.
- A malformed manifest stops the proxy from starting, with the file and line to
  fix. It will never run with a policy it could not understand.

## Commands

| Command | Does |
|---|---|
| `init <server> -- <cmd>` | Introspect a server and draft a manifest |
| `list` | Every recorded run |
| `show <runId>` | One run's timeline, with the undo for each step |
| `gates` | What is waiting for a decision |
| `approve <actionId>` | Allow a suspended call |
| `deny <actionId>` | Refuse one |
| `undo <runId>` | Reverse a run, newest action first |
| `undo <runId> --replan` | Same, but rebuild each undo from the current manifest |
| `check` | Load a manifest and verify it against the servers it names |

`--manifest` and `--journal` are found rather than typed. Both are looked for
from the current directory upwards, the way a version control tool finds its
root, so inside a project that has a `synartesis.yaml` every command works with
no flags at all. When there is nothing above you either, both come from
`~/.synartesis` — most of what anyone guards is not part of a project, and
should not need a directory of its own. `SYNARTESIS_HOME` moves that. A journal
that does not exist yet is placed beside the policy, so the proxy that creates
it and the CLI that reads it agree without either being told.

Other flags: `--dry-run`, `--to <seq>` and `--replan` on `undo`, `--all` on
`approve` and `deny`, `--json` on `list`, `show` and `gates`.

Exit codes: `0` succeeded, `1` halted or refused, `2` bad usage or
configuration.

### Serving over HTTP

Most clients start the proxy themselves over stdio. ChatGPT's connectors do
not: they take a remote HTTPS endpoint and will not run a process on your
machine. For those, serve it:

```bash
synartesis proxy --manifest ~/.synartesis/synartesis.yaml --http 9123 --token "$SYNARTESIS_TOKEN"
```

The endpoint is `/mcp` and every request needs `Authorization: Bearer <token>`.
A token of at least 16 characters is **required** — it refuses to start without
one — and it binds to `127.0.0.1` unless `--http-host` says otherwise, which
warns when it is not loopback.

Reaching it from the internet means putting a tunnel in front of it. That is
deliberately your decision and not a flag: what is on the other end can write
through every server in your policy, so treat the token like a password and
prefer a tunnel that does its own authentication.

The proxy takes `--manifest`, `--journal` and `--log-level`. It also still
accepts `--gate-timeout <seconds>`, which does nothing: a held call is refused
immediately rather than holding the connection open, so there is no wait to cut
short. Passing it logs a warning saying as much. It logs structured JSON to stderr; stdout is reserved for
protocol traffic.

## What it does not do

- **It cannot un-send what has been seen.** An email that has been read, a
  posted message, a file deleted with no backup. This is why the gate exists.
- **Compensable actions cannot be checked for drift.** They declare no pre-read,
  so undo compensates them and marks them `[unverified]` in its report.
- **Undo halts on uncertainty, and steps over the merely permanent.** Drift, an
  unknown outcome, or a failed reversing call stop it, because continuing past
  those could destroy something. An action that simply cannot be undone, like a
  sent email, is reported and left in place while everything else is reverted:
  no amount of stopping un-sends it, and stopping would only leave the rest
  wrong too. Either way the run is marked `partial`.
- **A call interrupted mid-flight is recorded as unknown**, not as failed. Undo
  refuses to walk past it, because whether it applied cannot be determined.
- **An undo is only as good as the policy that recorded it.** Inverses are
  resolved when the call happens, not when you undo, so a mistake in a manifest
  is baked into every run made under it. `undo --replan` rebuilds them from a
  corrected manifest using the state already captured, which is the way out.

## Watching it work

Synartesis is not a daemon and cannot be one. An MCP client spawns a stdio
server itself and owns its lifetime, so nothing long-running could sit in
between and see those calls. What a person wants from a daemon is usually the
reassurance that it is there and doing something, and that needs somewhere to
look rather than a background process:

```bash
synartesis watch
```

It redraws as the agent works: what has been called, what class each call was,
and anything waiting on a decision, with the command to approve it. Ctrl-C
stops it. Piped rather than run in a terminal, it prints the state once and
exits.

## Trust

A manifest names commands and Synartesis runs them. Treat one you did not write
the way you would treat a shell script from the same source: read it first.
There is no sandbox here, and there is not meant to be.

## Development

```bash
pnpm test
```

```bash
pnpm typecheck && pnpm lint
```

Every push runs those on Linux and macOS across Node 22 and 24, plus the demo
and the installer.

## Licence

MIT. See [LICENSE](LICENSE).
