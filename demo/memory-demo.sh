#!/usr/bin/env bash
# A demo against a real third-party MCP server, on a real file.
#
# The memory server is the knowledge graph an agent keeps about you between
# sessions. Nothing here is a fixture: it is the published server, run the way
# a client runs it, writing the file it really writes.
#
# Run from the repo root after `pnpm install && pnpm build`:
#   ./demo/memory-demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="${TMPDIR:-/tmp}"
DEMO="${DEMO%/}/synartesis-demo-memory"
GRAPH="$DEMO/memory.json"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
pause() { sleep "${DEMO_PAUSE:-1.2}"; }
graph() { node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
for (const line of lines) {
  const item = JSON.parse(line);
  console.log(item.type === "entity" ? `  entity    ${item.name}` : `  relation  ${item.from} -> ${item.to}`);
}' "$GRAPH"; }

rm -rf "$DEMO"; mkdir -p "$DEMO"
sed 's#\${MEMORY_FILE_PATH}#'"$GRAPH"'#' "$ROOT/manifests/memory.yaml" > "$DEMO/synartesis.yaml"

server() { MEMORY_FILE_PATH="$GRAPH" npx -y @modelcontextprotocol/server-memory; }

# Frames for one session, fed to whichever command is given.
session() {
  local id=2 calls=""
  for spec in "$@"; do
    calls="$calls"$'\n''{"jsonrpc":"2.0","id":'"$id"',"method":"tools/call","params":'"$spec"'}'
    id=$((id + 1))
  done
  printf '%s%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent","version":"0"}}}'$'\n''{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    "$calls"
}

seed() { session "$@" | server >/dev/null 2>&1 || true; }
# A real client, one call at a time. See demo/agent.mjs for why that matters
# here in particular.
agent() {
  MEMORY_FILE_PATH="$GRAPH" node "$ROOT/dist/demo-agent.js" \
    "$DEMO/journal.db" "$DEMO/synartesis.yaml" "$@"
}

cli() { node "$ROOT/dist/cli.js" "$@" --journal "$DEMO/journal.db"; }
latest() { cli list --json | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b)[0].id))'; }

say "1. What the agent already remembered, before this run"
seed '{"name":"create_entities","arguments":{"entities":[{"name":"Grace","entityType":"person","observations":["prefers email"]}]}}'
graph; pause

say "2. One agent session: it adds to the graph, and tries to delete from it"
agent 'create_entities {"entities":[{"name":"Ada","entityType":"person","observations":["runs the pilot"]},{"name":"Grace","entityType":"person","observations":["ignored: already exists"]}]}' \
      'create_relations {"relations":[{"from":"Ada","to":"Grace","relationType":"reports_to"}]}' \
      'delete_entities {"entityNames":["Grace"]}'
pause

say "3. The graph now. Note Grace is still here: the delete was held."
graph
cli gates; pause

say "4. What Synartesis recorded"
RUN="$(latest)"; cli show "$RUN"; pause

say "5. One command puts the graph back"
cli undo "$RUN" --manifest "$DEMO/synartesis.yaml"

say "6. Ada is gone. Grace, who was there first, is untouched."
graph
