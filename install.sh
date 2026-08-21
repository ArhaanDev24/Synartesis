#!/usr/bin/env bash
# Builds Synartesis and puts it on your PATH.
#
#   ./install.sh              build, then link into the first writable
#                             directory already on your PATH
#   ./install.sh --no-link    build only
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\nsynartesis: %s\n' "$*" >&2; exit 1; }

step "Checking what is here"
command -v node >/dev/null || fail "node is not installed. Synartesis needs Node 20 or newer."
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || fail "node $(node --version) is too old. Synartesis needs Node 20 or newer."
printf '  node %s\n' "$(node --version)"

if ! command -v pnpm >/dev/null; then
  printf '  pnpm is missing; enabling it through corepack\n'
  corepack enable pnpm >/dev/null 2>&1 || fail "could not enable pnpm. Install it yourself, then run this again."
fi
printf '  pnpm %s\n' "$(pnpm --version)"

step "Building"
pnpm install --silent
pnpm build >/dev/null
printf '  built\n'

if [ "${1:-}" = "--no-link" ]; then
  step "Done"
  printf '  Run it with: node %s/dist/cli.js\n\n' "$here"
  exit 0
fi

step "Putting synartesis on your PATH"
target=""
IFS=: read -r -a dirs <<< "$PATH"
for dir in "${dirs[@]}"; do
  # Somewhere already on PATH and writable without sudo, so no shell profile
  # has to be edited and nothing needs elevating.
  case "$dir" in
    "$here"/*|.|"") continue ;;
  esac
  if [ -d "$dir" ] && [ -w "$dir" ]; then target="$dir"; break; fi
done

if [ -z "$target" ]; then
  printf '  No writable directory on your PATH, so nothing was linked.\n'
  printf '  Run it with: node %s/dist/cli.js\n\n' "$here"
  exit 0
fi

chmod +x dist/cli.js dist/proxy.js
ln -sf "$here/dist/cli.js" "$target/synartesis"
ln -sf "$here/dist/proxy.js" "$target/synartesis-proxy"
printf '  linked into %s\n' "$target"

step "Ready"
printf '  synartesis --help\n\n'
