# Security

## Reporting

Report privately through GitHub, using **Security → Report a vulnerability** on
[the repository](https://github.com/ArhaanDev24/Synartesis/security/advisories/new).
That opens a draft advisory only you and the maintainer can see.

Please do not open a public issue for a vulnerability first. Anything else — a
crash, a wrong undo, a policy that misclassifies a tool — belongs in the normal
[issue tracker](https://github.com/ArhaanDev24/Synartesis/issues), and is more
useful there.

Include what you did, what happened, and the output of `synartesis --version`.

## Supported versions

The latest published minor. Fixes go out as a new release rather than as
patches to older ones.

| Version | Supported |
|---|---|
| 0.3.x | yes |
| < 0.3 | no |

## What the journal holds, and why it matters

Putting a file back means having kept what was in it. So the journal is not a
log of what happened — it is a copy of the data:

- `snapshot_json` — the contents of every resource before it was written
- `args_json` — the arguments of every call, which for a write is the new
  contents
- `result_json` — what each server sent back

A key that was sitting in a file an agent touched is in the journal in plain
text, and no amount of care elsewhere changes that: it is what makes undo
possible.

Synartesis therefore creates the journal `0600` and the directory it makes for
it `0700`, and re-applies `0600` every time a journal is opened, so one written
by an older version is closed the first time a newer one touches it.

Two things it does **not** do, both deliberate:

- It does not change the mode of a directory that already exists. A journal can
  sit beside a policy inside a project, and quietly making somebody's project
  directory `0700` would be a worse surprise than the one being prevented. If
  your `~/.synartesis` predates 0.3.0, `chmod 700 ~/.synartesis` is the one
  thing worth doing by hand.
- It does not encrypt anything. Full-disk encryption is the answer to a stolen
  laptop; file permissions are the answer to another account on a machine you
  share. Neither is Synartesis's to reinvent.

`synartesis prune` is how history stops accumulating. Nothing is deleted on a
timer — a tool for undoing things has no business discarding the record of what
was done unless asked.

## Scope

Synartesis runs the commands a manifest names, with your permissions, and has
no sandbox. That is the design, and it is why the README says to read a
manifest you did not write the way you would read a shell script from the same
source. A manifest that runs something harmful is not a vulnerability in
Synartesis.

Serving over HTTP requires a token of at least 16 characters and binds to
loopback unless told otherwise. Anything that can reach that port and holds the
token can write through every server in your policy. Putting it on a network is
a decision, not a flag.
