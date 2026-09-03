## What this changes

<!-- One or two sentences. What is different afterwards. -->

## Why

<!-- The problem. If it fixes an issue, link it. -->

## How it was checked

<!-- Delete what does not apply. -->

- [ ] `pnpm test` passes
- [ ] `pnpm lint` and `pnpm typecheck` pass
- [ ] A bug fix comes with a test that fails without the fix
- [ ] `./demo/filesystem-demo.sh` still works
- [ ] For a new or changed policy: which server and version it was tested
      against, and one real `synartesis undo` pasted below

## If this touches the write path

Synartesis exists so an agent's mistake is recoverable. A write that reaches
an upstream server **without a captured snapshot** is silently irreversible,
which is the one outcome the project exists to prevent.

- [ ] No path here lets a write through when its snapshot failed
- [ ] Or: this does not touch the write path
