<!-- Absolute URLs, not relative paths: this README is also the npm package
     page, and npm does not resolve relative image paths against the repo. -->
[![Synartesis — an undo layer for AI agents](https://raw.githubusercontent.com/ArhaanDev24/Synartesis/main/brand/synartesis-banner.png)](https://synartesis.online)

[![check](https://github.com/ArhaanDev24/Synartesis/actions/workflows/check.yml/badge.svg)](https://github.com/ArhaanDev24/Synartesis/actions/workflows/check.yml)
[![npm](https://img.shields.io/npm/v/synartesis?color=5e1420&label=npm)](https://www.npmjs.com/package/synartesis)
[![downloads](https://img.shields.io/npm/dm/synartesis?color=5e1420&label=downloads)](https://www.npmjs.com/package/synartesis)
[![node](https://img.shields.io/node/v/synartesis?color=5e1420)](https://nodejs.org)
[![MIT](https://img.shields.io/badge/licence-MIT-5e1420.svg)](LICENSE)

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

## What it looks like

Both shots are real output from [`./demo/filesystem-demo.sh`](demo/filesystem-demo.sh),
pasted rather than typeset. An agent overwrote a file and tried to move another.
One command puts the first back and reports that the second never happened:

![synartesis undo, reverting a write and skipping a gated move](https://raw.githubusercontent.com/ArhaanDev24/Synartesis/main/brand/synartesis-undo.png)

`skip` is the interesting row. `move_file` is irreversible on that server, so it
was never applied in the first place — there is nothing to undo.

Now the same damage, except a colleague edited the file before you got to the
undo. Writing the old contents back would destroy their work, so it does not:

![synartesis undo halting on drift, showing the human's line](https://raw.githubusercontent.com/ArhaanDev24/Synartesis/main/brand/synartesis-drift.png)

It stops at the record that moved and exits non-zero. Anything already put back
stays put back, and it prints the three ways on: leave it, restore the resource
and `--replan`, or `--force` to overwrite deliberately.

## Install

```bash
npm install -g synartesis
```

Then, from anywhere:

```bash
synartesis install
```

That finds what Claude Code, Claude Desktop, Cursor or Codex already list,
writes one policy covering all of it, and points each entry at the proxy.
Servers it recognises get the policy that ships for them and work immediately;
the rest are drafted with every tool held until you say how to undo it. Your
config is copied aside first, `synartesis uninstall` puts it back, and
`synartesis status` says what is covered.

Each server keeps its own entry and its own proxy, so **no tool is renamed** —
the agent sees exactly the names it saw before. **Your agent needs nothing
installed.**

Needs Node 22 or newer. npm ships a prebuilt SQLite binding, so no toolchain is
required unless you build from a clone.

Then just:

```bash
synartesis
```

One screen: what agents have done, what is held for approval, every AI on the
machine, and undo — all on the arrow keys.

## The desktop window

The same engine, with a conversation in front of it. You talk to a model — any
model — and every tool it calls goes through the proxy on its way out, so the
undo is not a feature the window implements. It is one it can already offer.

![The Synartesis desktop window: a turn that wrote a file, with the tool card showing it was captured and can be put back](https://raw.githubusercontent.com/ArhaanDev24/Synartesis/main/brand/synartesis-desktop.png)

Every call gets a card: which server, which tool, the class Synartesis gave it,
and whether the state it replaced was captured. The ledger at the top counts the
same thing for the whole conversation. Nothing there is a promise about what
should have happened — it is read back out of the journal after the fact.

A call that cannot be undone does not happen behind your back. It stops, and
waits for you, with the reason it cannot be reversed written out:

![A held call in the desktop window, asking whether to allow a write whose prior state could not be captured](https://raw.githubusercontent.com/ArhaanDev24/Synartesis/main/brand/synartesis-desktop-approval.png)

And putting it back is the same two steps the CLI takes: the real plan first,
built from the journal, then the confirmation.

![The undo plan in the desktop window, showing one call skipped and one reverted](https://raw.githubusercontent.com/ArhaanDev24/Synartesis/main/brand/synartesis-desktop-undo.png)

It talks to Claude, Gemini, Mistral, OpenAI, or anything speaking
`/v1/chat/completions` — including Ollama, LM Studio and vLLM on your own
machine, which cost nothing and send nothing anywhere. Keys are pasted by you,
kept in the OS keychain through Electron's `safeStorage`, and never written to
the journal or a log. There is a parchment and a dark setting:

![The desktop window in its dark setting](https://raw.githubusercontent.com/ArhaanDev24/Synartesis/main/brand/synartesis-desktop-dark.png)

**Getting it.** `synartesis desktop` opens it, and says where to get it if it is
not installed. It is a separate download on purpose: shipping a browser engine
inside a CLI would put 200 MB into every install of a command that is a few
hundred kilobytes.

On macOS it installs the way anything does — open the `.dmg`, drag Synartesis to
Applications — and on Windows the `.exe` installer puts it where the Start menu
can find it. After that, either the icon or `synartesis desktop` opens it; the
command looks where each platform actually installs things rather than asking
you to remember a path.

To build it yourself instead:

```bash
pnpm install && pnpm app:dist
```

That writes an installer for the machine it runs on to `app/release` — a `.dmg`
and a `.app` on macOS, an `.exe` on Windows, an AppImage and a `.deb` on Linux.
It is unsigned, so it runs where it was built and Gatekeeper refuses it
anywhere it has been downloaded to: signing and notarisation need an Apple
developer account, and [`app/README.md`](app/README.md) lists exactly what they
want. The `release` workflow builds all three platforms on their own machines
and attaches the installers to the release for a tag. Both the window and the terminal share
one journal, so either can undo what the other did.

## What it can and cannot do

Every tool gets one of four classifications, written down in a manifest:

| Class | Meaning | Example | What happens |
|---|---|---|---|
| `readonly` | Changes nothing | `get_customer` | Recorded, forwarded |
| `reversible` | Prior state can be restored exactly | `update_customer` | State captured before the write; written back on undo |
| `compensable` | Cannot be reversed, but can be offset | `create_charge` | A different call neutralises it |
| `irreversible` | Neither | `send_email` | **Suspended until a human approves it** |

A tool your manifest does not mention is treated as `irreversible`. That is
deliberate: silently forwarding an unknown destructive call is the one failure
worth avoiding most.

## Has anybody touched it since?

Synartesis records what an agent does, not what happens to a file. Nothing you
do by hand goes through the proxy — which is exactly what makes the drift check
work: when undo reads a file and finds bytes it never recorded, it knows
somebody else has been there.

To ask before you find out the hard way:

```bash
synartesis show <session> --live
```

It reads every resource the session touched as it is now and says which still
match. Nothing is written, no reversing call is sent, and unlike
`undo --dry-run` it does not stop at the first conflict — five writes get five
answers. `l` in the screen does the same.

If you decide the recorded value is the one worth keeping, `undo --force` prints
every line it would write over and stops; `--force --yes` goes ahead.

## Commands

`synartesis desktop` opens [the window](#the-desktop-window), and says where to
get it if it is not installed.

| Command | Does |
|---|---|
| `synartesis` | The screen. Everything below can be done from it |
| `install` / `uninstall` / `status` | Cover the clients on this machine, put them back, say what is covered |
| `init <server> -- <cmd>` | Introspect a server and draft a manifest |
| `check` | Load a manifest and verify it against the servers it names |
| `list` | Every recorded session |
| `show <id>` | One session's timeline, with the undo for each step |
| `show <id> --live` | The same, plus what has changed in the world since |
| `show <id> --full` | Every argument, snapshot and inverse, nothing elided |
| `gates` / `approve <id>` / `deny <id>` | What is waiting, and answering it |
| `undo <id>` | Reverse a session, newest action first |
| `undo <id> --dry-run` | Plan it and change nothing |
| `undo <id> --replan` | Rebuild each undo from the current manifest |
| `undo <id> --force [--yes]` | Print what it would write over; `--yes` goes ahead |
| `watch` | Live activity, with approvals answerable in place |
| `prune` | Delete sessions older than 30 days and reclaim the space |
| `close [id]` | End a session a killed proxy left open |

In the screen: `enter` opens, `u` undoes, `p` previews, `l` checks the world
now, `f` expands, `c` shows every AI on the machine, `g` shows what is held.

`--manifest` and `--journal` are found rather than typed, from the current
directory upwards the way a version control tool finds its root, then from
`~/.synartesis`. `SYNARTESIS_HOME` moves that. `--json` works on `list`, `show`
and `gates`. Exit codes: `0` succeeded, `1` halted or refused, `2` bad usage.

**Full walkthrough, writing a manifest, and serving over HTTP for clients that
cannot start a process:** see the [user guide](docs/synartesis-user-guide.md).

## What it does not do

- **It cannot un-send what has been seen.** An email that has been read, a
  posted message, a file deleted with no backup. This is why the gate exists.
- **Compensable actions cannot be checked for drift.** They declare no pre-read,
  so undo compensates them and marks them `[unverified]`.
- **Undo halts on uncertainty, and steps over the merely permanent.** Drift, an
  unknown outcome, or a failed reversing call stop it. An action that simply
  cannot be undone is reported and left in place while everything else is
  reverted. Either way the session is marked `partial`.
- **An error is not proof that nothing happened.** A timeout or a tool-level
  error after a write leaves the outcome *unknown*, not failed, and undo will
  not step past it. Where a pre-read exists it is consulted to settle the
  question instead of guessing.
- **An undo is only as good as the policy that recorded it.** Inverses are
  resolved when the call happens, so a mistake in a manifest is baked into every
  run made under it. `undo --replan` rebuilds them from a corrected one.

The bundled **filesystem** policy is tested against the real server: exact
byte-for-byte restoration, drift refusal, and absence told apart from a read
that failed. The **memory, git and github** policies are checked only for tool
existence — their recovery guarantees are not yet proven.

## Trust

A manifest names commands and Synartesis runs them. Treat one you did not write
the way you would treat a shell script from the same source: read it first.

**The journal is a copy of your data, not a log.** Putting a file back means
having kept what was in it, so the contents of every resource before it was
written are in there in plain text — including any key that was sitting in a
file your agent touched. That is not a leak to be closed; it is the thing that
makes undo work. It is created `0600` in a `0700` directory, and nothing is
encrypted: full-disk encryption answers a stolen laptop, permissions answer
another account on a machine you share.

**It grows at roughly four times the bytes your agent writes** and never shrinks
on its own — thirty edits of one 200 kB file came to 24 MB. `synartesis prune`
deletes whole sessions and `VACUUM`s. It will not touch one still active, or one
holding a call waiting on a person, or one whose undo halted on a conflict. A
pruned session cannot be undone afterwards, which is the whole of the trade.
Nothing prunes on a timer.

**Durability.** The journal runs `synchronous = NORMAL`. A crash of the process
or of the CLI mid-undo loses nothing; only the machine losing power can cost the
tail of the write-ahead log. `SYNARTESIS_SYNC=full` asks for an fsync per commit
instead — worth it where fsync is cheap, and measurably not where it is not.

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
