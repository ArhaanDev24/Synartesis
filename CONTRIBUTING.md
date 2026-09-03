# Contributing

The most useful thing you can send is **a policy for a server Synartesis does
not know yet**. Four ship today: filesystem, git, github, memory. Every other
server in the world gets a draft where every tool is marked `irreversible` and
held, which is safe and not much fun.

A policy is a YAML file. You do not need to touch the TypeScript to write one.

## Writing a policy

Point `init` at the server and read what it drafts:

```bash
synartesis init myserver -- npx -y @some/mcp-server
open ~/.synartesis/synartesis.yaml
```

Every tool that is not a self-declared read starts as `irreversible` with a
`TODO`. Working through those TODOs is the job. A rule needs three things:

```yaml
tools:
  crm.update_customer:
    class: reversible
    snapshot:
      tool: get_customer
      args: { id: "${args.id}" }
    inverse:
      tool: update_customer
      args:
        id: "${args.id}"
        plan: "${snapshot.plan}"
        notes: "${snapshot.notes}"
```

**`class`** is one of `readonly`, `reversible`, `compensable`, `irreversible`.

**`snapshot`** is the read that captures prior state, before the write goes
out. If this read fails the write does not happen — a reversible action
without a snapshot is only silently irreversible.

**`inverse`** is the call that puts it back, built from what the snapshot
returned.

Then check it:

```bash
synartesis check --manifest ./synartesis.yaml
```

`check` confirms every rule names a tool the server actually advertises. A
policy whose inverses cannot be called is worse than no policy, because it
looks finished.

### Getting a policy shipped

Put it in `manifests/`, then run the suite. `tests/shipped-manifests.test.ts`
asserts things about every bundled policy — notably that each snapshot
declares `absent_when`, so "the resource is gone" is told apart from "the read
failed".

Say in the PR **which server and version you tested against**, and paste one
real undo. A policy nobody has run is a guess.

## Working on the code

```bash
corepack enable pnpm
pnpm install
pnpm test        # 300 tests
pnpm lint
pnpm typecheck
pnpm build
```

Node 22 or newer. `better-sqlite3` compiles native bindings, so you need a C
toolchain: `xcode-select --install` on macOS, `apt install build-essential` on
Debian or Ubuntu.

Two demos double as integration tests and both should keep working:

```bash
./demo/filesystem-demo.sh   # CI runs this on every push
./demo/memory-demo.sh
```

### What the codebase holds itself to

- **Strict TypeScript.** `any`, unchecked assertions and `@ts-` comments are
  lint errors, not preferences.
- **Tests describe behaviour, not implementation.** Look at the existing names
  before adding one.
- **A bug fix comes with a test that fails without it.**
- **Never widen a type to make an error go away.** If the type is fighting you,
  the type is usually right.

### The one rule that matters more than the others

Synartesis exists so that an agent's mistake is recoverable. Any change that
lets a write through **without a captured snapshot** breaks the only promise
the project makes. If a change would do that, it needs to fail loudly instead.

## Reporting a bug

Include `synartesis --version`, your Node version, which MCP server you were
wrapping, and the relevant part of `synartesis show <run> --json`. The journal
knows what happened; a description of what you think happened is a second-hand
account of it.

**Do not paste your journal wholesale.** It holds prior file contents verbatim,
which is how undo works and also means it can contain secrets. See
[SECURITY.md](SECURITY.md).

## Security

Do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) has
the reporting route.
