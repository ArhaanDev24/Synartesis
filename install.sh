#!/usr/bin/env bash
# Installs Synartesis.
#
#   curl -fsSL https://raw.githubusercontent.com/ArhaanDev24/Synartesis/main/install.sh | bash
#   ./install.sh                from inside a checkout
#   ./install.sh --no-link      build, but do not touch PATH
#
# SYNARTESIS_DIR chooses where a fresh copy is cloned. Nothing is written
# outside that directory and whichever bin directory is already on your PATH.
set -euo pipefail

REPO="https://github.com/ArhaanDev24/Synartesis.git"
LINK=1
for arg in "$@"; do
  [ "$arg" = "--no-link" ] && LINK=0
done

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\nsynartesis: %s\n' "$*" >&2; exit 1; }

step "Checking what is here"
command -v node >/dev/null || fail "node is not installed. Synartesis needs Node 22 or newer."
major="$(node -p 'process.versions.node.split(".")[0]')"
# 22, not 20: better-sqlite3 segfaults on 20 rather than failing politely.
[ "$major" -ge 22 ] || fail "node $(node --version) is too old. Synartesis needs Node 22 or newer."
note "node $(node --version)"

if ! command -v pnpm >/dev/null; then
  command -v corepack >/dev/null || fail "neither pnpm nor corepack is available. Install pnpm 9 or newer, then run this again."
  corepack enable pnpm >/dev/null 2>&1 || fail "could not enable pnpm through corepack. Install pnpm yourself, then run this again."
fi
note "pnpm $(pnpm --version)"

# Piped from curl there is no checkout to build, so one is fetched. Run from
# inside a clone, that clone is used and nothing is downloaded.
source_dir=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$candidate/package.json" ] && grep -q '"name": "synartesis"' "$candidate/package.json"; then
    source_dir="$candidate"
  fi
fi

if [ -z "$source_dir" ]; then
  command -v git >/dev/null || fail "git is not installed, and it is needed to fetch Synartesis."
  source_dir="${SYNARTESIS_DIR:-$HOME/.local/share/synartesis}"
  step "Fetching"
  if [ -d "$source_dir/.git" ]; then
    git -C "$source_dir" fetch --quiet origin main
    git -C "$source_dir" reset --quiet --hard origin/main
    note "updated $source_dir"
  else
    mkdir -p "$(dirname "$source_dir")"
    git clone --quiet --depth 1 "$REPO" "$source_dir"
    note "cloned into $source_dir"
  fi
fi

cd "$source_dir"

step "Building"
pnpm install --silent --prod=false
pnpm build >/dev/null
note "built"

if [ "$LINK" -eq 0 ]; then
  step "Done"
  note "Run it with: node $source_dir/dist/cli.js"
  printf '\n'
  exit 0
fi

step "Putting synartesis on your PATH"
target=""
IFS=: read -r -a dirs <<< "$PATH"
for dir in "${dirs[@]}"; do
  # Somewhere already on PATH and writable without sudo, so no shell profile
  # has to be edited and nothing needs elevating.
  case "$dir" in ""|.|"$source_dir"/*) continue ;; esac
  if [ -d "$dir" ] && [ -w "$dir" ]; then target="$dir"; break; fi
done

if [ -z "$target" ]; then
  note "No writable directory on your PATH, so nothing was linked."
  note "Run it with: node $source_dir/dist/cli.js"
  note "Or add a directory you own to PATH and run this again."
  printf '\n'
  exit 0
fi

chmod +x dist/cli.js dist/proxy.js
ln -sf "$source_dir/dist/cli.js" "$target/synartesis"
ln -sf "$source_dir/dist/proxy.js" "$target/synartesis-proxy"
note "linked into $target"

step "Ready"
note "synartesis --help"
printf '\n'
