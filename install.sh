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

# --- look and feel ----------------------------------------------------------
# Oxblood, the same as the cli. Only when a terminal is actually attached and
# NO_COLOR is not set, because piped output goes to something that wants text.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  PLATE=$'\033[48;2;94;20;32m\033[38;2;246;233;229m\033[1m'
  ACCENT=$'\033[38;2;226;134;118m'
  DIM=$'\033[2m'
  BOLD=$'\033[1m'
  OFF=$'\033[0m'
  HIDE=$'\033[?25l'
  SHOW=$'\033[?25h'
else
  PLATE=""; ACCENT=""; DIM=""; BOLD=""; OFF=""; HIDE=""; SHOW=""
fi

# A meander: one line that turns back on itself without ever breaking, which is
# what sunartesis means.
FRET="┗━┓┏━┛┗━┓┏━┛┗━┓┏━┛┗━┓┏━┛"

logo() {
  printf '\n  %s S Y N A R T E S I S %s\n' "$PLATE" "$OFF"
  printf '  %s%s%s\n\n' "$ACCENT" "$FRET" "$OFF"
  printf '  %sΣ Υ Ν Α Ρ Τ Η Σ Ι Σ  ·  a fastening together%s\n' "$DIM" "$OFF"
  printf '  %san undo layer for AI agents%s\n' "$DIM" "$OFF"
}

step()  { printf '\n  %s%s%s\n' "$BOLD" "$*" "$OFF"; }
note()  { printf '    %s%s%s\n' "$DIM" "$*" "$OFF"; }
ok()    { printf '    %s✓%s %s\n' "$ACCENT" "$OFF" "$*"; }
fail()  { printf '\n  %s✗%s %s\n\n' "$ACCENT" "$OFF" "$*" >&2; exit 1; }

# Runs a command while a spinner turns, then reports. The command's own output
# is kept, and shown only if it fails: a build that works has nothing to say,
# and a build that does not should say all of it.
spin() {
  local label="$1"; shift
  local log; log="$(mktemp)"

  if [ ! -t 1 ]; then
    "$@" >"$log" 2>&1 || { cat "$log"; rm -f "$log"; fail "$label failed."; }
    rm -f "$log"; ok "$label"
    return
  fi

  "$@" >"$log" 2>&1 &
  local pid=$!
  # An array, not a string: bash slices strings by byte, and these frames are
  # multibyte, so ${s:i:1} would hand back half a character.
  local frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
  local i=0
  printf '%s' "$HIDE"
  while kill -0 "$pid" 2>/dev/null; do
    i=$(( (i + 1) % ${#frames[@]} ))
    printf '\r    %s%s%s %s' "$ACCENT" "${frames[$i]}" "$OFF" "$label"
    sleep 0.08
  done
  printf '%s' "$SHOW"
  if wait "$pid"; then
    printf '\r    %s✓%s %s\033[K\n' "$ACCENT" "$OFF" "$label"
    rm -f "$log"
  else
    printf '\r\033[K'
    cat "$log"
    rm -f "$log"
    fail "$label failed."
  fi
}


logo
step "Checking what is here"
command -v node >/dev/null || fail "node is not installed. Synartesis needs Node 22 or newer."
major="$(node -p 'process.versions.node.split(".")[0]')"
# 22, not 20: better-sqlite3 segfaults on 20 rather than failing politely.
[ "$major" -ge 22 ] || fail "node $(node --version) is too old. Synartesis needs Node 22 or newer."
ok "node $(node --version)"

if ! command -v pnpm >/dev/null; then
  command -v corepack >/dev/null || fail "neither pnpm nor corepack is available. Install pnpm 9 or newer, then run this again."
  corepack enable pnpm >/dev/null 2>&1 || fail "could not enable pnpm through corepack. Install pnpm yourself, then run this again."
fi
ok "pnpm $(pnpm --version)"

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
    spin "updating" git -C "$source_dir" fetch --quiet origin main
    git -C "$source_dir" reset --quiet --hard origin/main
    ok "updated $source_dir"
  else
    mkdir -p "$(dirname "$source_dir")"
    spin "cloning" git clone --quiet --depth 1 "$REPO" "$source_dir"
    ok "cloned into $source_dir"
  fi
fi

cd "$source_dir"

step "Building"
spin "installing dependencies" pnpm install --silent --prod=false
spin "compiling" pnpm build

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
ok "linked into $target"

step "Ready"
note "Try: synartesis --help"
printf '\n'
