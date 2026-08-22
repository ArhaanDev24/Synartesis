# Testing Synartesis on a real system

Not the fixture, not a temp directory the script made and deleted. Your files,
your agent, your terminal. Every command below was run end to end before it was
written down.

You will need Node 22 or newer. `node -v` to check.

---

## 1. Build and install it

```bash
cd ~/Synartesis
git pull
pnpm install
pnpm build
./install.sh
```

`install.sh` links `synartesis` and `synartesis-proxy` into the first writable
directory already on your PATH. Confirm:

```bash
synartesis --help
```

If that prints the banner, the rest of this document works verbatim. If it says
command not found, add `~/.local/bin` to your PATH and open a new terminal.

## 2. Choose a real directory

Somewhere with real files you would mind losing, but that is also backed up or
in git. A project you are working on is ideal. In these commands it is `$WORK`:

```bash
export WORK=~/some/real/project
ls "$WORK"
```

Everything the agent does is confined to this directory. The filesystem server
refuses paths outside it, and Synartesis records what happens inside it.

## 3. Write the policy for it

The shipped policy for the filesystem server points at the current directory.
Copy it and aim it at yours:

```bash
mkdir -p ~/synartesis-live && cd ~/synartesis-live
FS=~/Synartesis/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js
sed 's#"node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "."#"'"$(cd ~/Synartesis && pwd)"'/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "'"$WORK"'"#' \
  ~/Synartesis/manifests/filesystem.yaml > synartesis.yaml
```

Read the file you just made. The `servers:` block should name your directory.
The `tools:` block is the whole product: it is what says `write_file` can be
taken back and `create_directory` cannot.

## 4. Check the policy before anything uses it

```bash
synartesis check
```

This starts the real server and verifies that every tool the policy mentions
actually exists on it. It should report ten readonly, three reversible and one
irreversible. If it reports a problem, the policy is wrong and no agent should
be pointed at it yet.

## 5. Point your agent at it instead of at the server

In the project you will run Claude Code from, create `.mcp.json`:

```json
{
  "mcpServers": {
    "files": {
      "command": "synartesis-proxy",
      "args": [
        "--manifest", "/Users/you/synartesis-live/synartesis.yaml",
        "--journal", "/Users/you/synartesis-live/journal.db"
      ]
    }
  }
}
```

Use absolute paths. The agent sees the same fourteen tools it would have seen
talking to the server directly, plus an instruction explaining what happens
when a call is held.

## 6. Watch it, in a second terminal

```bash
cd ~/synartesis-live
synartesis watch
```

Leave it running. It redraws as the agent works.

## 7. Give the agent something real to do

Start Claude Code in the project with `.mcp.json` and ask for something that
writes. For example:

> Using the `mcp__files__*` tools, rewrite the header of every markdown file in
> this directory to include today's date.

**The one thing to be careful about.** Synartesis can only record what goes
through it, and an agent with its own tools for the job will use those instead.
Claude Code has built-in file editing and built-in memory, so a request phrased
in ordinary words gets answered in ordinary ways and the proxy never sees it.

Name the tools. Every server wired in through `.mcp.json` is exposed to Claude
Code as `mcp__<server>__<tool>`, so for the config above that is `mcp__files__`
and you ask for `mcp__files__write_file` by name.

`synartesis watch` is how you tell. It shows the run count and the action count
separately, and the pair is the diagnostic:

    watching  1 runs, 1 live  ·  0 recent actions

One live run means your agent did connect to the proxy. Zero actions next to it
means everything it then did, it did somewhere else.

## 8. Read what it did

```bash
synartesis show
```

One line per call, in order, with the class, the status, and for anything
reversible the exact call that would undo it. That undo was resolved when the
action happened, not now.

## 9. Put it back

Look before you leap:

```bash
synartesis undo --dry-run
```

That reads the current state of every file and prints exactly what it would
call, and changes nothing. Then:

```bash
synartesis undo
```

Check your files. They are as they were.

---

## The two things worth testing on purpose

Undo working is the easy half. These are the halves that matter.

### The gate: something that cannot be undone

Ask the agent to create a directory. The filesystem server has no way to remove
one, so the policy classes it irreversible and Synartesis refuses to pass the
call on:

> Using `mcp__files__create_directory`, create a directory called `archive` here.

The agent will report that the call was held and give you a command. In your
other terminal:

```bash
synartesis gates
synartesis approve --all --by "$USER"
```

Then tell the agent to try again. It goes through this time, and `synartesis
show` records who approved it and when. If you would rather it did not happen,
`synartesis deny --all --by "$USER" --reason "not this one"` and it never will.

Nothing is ever approved by silence. An unanswered request stays unanswered.

### Drift: someone changed the file after the agent did

This is the one that proves it is not just replaying a log.

1. Have the agent edit a file through the tools.
2. Before undoing, edit that same file yourself, by hand, and save it.
3. Run `synartesis undo`.

It refuses. It read the file, found it is not in the state the run left it in,
printed what it expected against what it found, and stopped rather than writing
over your edit. That is the correct answer: it cannot know whether your change
mattered, so it does not guess.

---

## Other real systems

The same five steps work for any of these; only the manifest changes.

```bash
synartesis check --manifest ~/Synartesis/manifests/memory.yaml   # your agent's own memory
synartesis check --manifest ~/Synartesis/manifests/git.yaml      # a real repository
```

`memory.yaml` is worth running even if you never use it.

Do not expect it to be un-bypassable, though. Claude Code has its own
file-based memory, so "remember that I am Arhaan" is a sentence it can answer
without touching the MCP server at all, and it will. Name the tools:

> Use the `mcp__memory__*` tools to create entities for me and my project.

Each manifest states in its own comments exactly where it runs out, and those
limits are properties of the servers rather than of Synartesis. The git server
cannot un-commit; the filesystem server cannot delete; the memory server cannot
put a deleted entity's relations back. In every one of those cases the policy
holds the call for a person instead of pretending.
