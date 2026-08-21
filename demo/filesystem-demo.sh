#!/usr/bin/env bash
# A 90-second demo against a real MCP server operating on real files.
#
# Run from the repo root after `pnpm install && pnpm build`:
#   ./demo/filesystem-demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FS="$ROOT/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js"
# TMPDIR usually ends in a slash on macOS; a doubled one is ugly in every path
# the demo then prints.
DEMO="${TMPDIR:-/tmp}"
DEMO="${DEMO%/}/synartesis-demo-fs"
WORK="$DEMO/work"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
pause() { sleep "${DEMO_PAUSE:-1.2}"; }

rm -rf "$DEMO"; mkdir -p "$WORK"
cat > "$WORK/notes.md" <<'EOF'
# Project notes
Ship date: March 14.
Owner: Grace.
EOF
printf 'item,cost\nservers,4200\n' > "$WORK/budget.csv"

sed "s#\"node_modules/@modelcontextprotocol/server-filesystem/dist/index.js\", \".\"#\"$FS\", \"$WORK\"#" \
  "$ROOT/manifests/filesystem.yaml" > "$DEMO/synartesis.yaml"

agent() {
  local calls=""
  local id=2
  for spec in "$@"; do
    calls="$calls"$'\n''{"jsonrpc":"2.0","id":'"$id"',"method":"tools/call","params":'"$spec"'}'
    id=$((id + 1))
  done
  printf '%s%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"rogue-agent","version":"0"}}}'$'\n''{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    "$calls" \
  | node "$ROOT/dist/proxy.js" --manifest "$DEMO/synartesis.yaml" --journal "$DEMO/journal.db" \
      --gate-timeout "${GATE_TIMEOUT:-3}" 2>/dev/null >/dev/null || true
}

cli() { node "$ROOT/dist/cli.js" "$@" --journal "$DEMO/journal.db"; }
latest() { cli list --json | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b)[0].id))'; }

say "1. Real files, before the agent touches them"
ls "$WORK"; cat "$WORK/notes.md"; pause

say "2. The agent overwrites one file and moves another"
agent '{"name":"write_file","arguments":{"path":"'"$WORK"'/notes.md","content":"OVERWRITTEN BY AGENT\n"}}' \
      '{"name":"move_file","arguments":{"source":"'"$WORK"'/budget.csv","destination":"'"$WORK"'/archive.csv"}}'
ls "$WORK"; cat "$WORK/notes.md"; pause

say "3. Synartesis recorded what each call replaced"
RUN="$(latest)"; cli show "$RUN"; pause

say "4. One command puts it back"
cli undo "$RUN" --manifest "$DEMO/synartesis.yaml"
ls "$WORK"; cat "$WORK/notes.md"; pause

say "5. Now the same damage, but a human edits the file before the undo"
agent '{"name":"write_file","arguments":{"path":"'"$WORK"'/notes.md","content":"AGENT VERSION\n"}}'
printf 'A HUMAN FIXED THIS BY HAND\n' > "$WORK/notes.md"
RUN="$(latest)"
cli undo "$RUN" --manifest "$DEMO/synartesis.yaml" || true
say "The human's edit survived:"; cat "$WORK/notes.md"; pause

say "6. And what cannot be undone is never done unasked"
say "create_directory is gated: this server has no way to remove a directory."
agent '{"name":"create_directory","arguments":{"path":"'"$WORK"'/junk"}}'
test -d "$WORK/junk" && echo "directory exists" || echo "directory was never created"
