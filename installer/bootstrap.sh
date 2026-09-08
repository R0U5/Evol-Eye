#!/usr/bin/env bash
# EVOL Eye installer bootstrap - zero-prerequisite launcher for macOS and Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$ROOT/manifest.json"
PORT="$(node -e "const m=require('$MANIFEST');process.stdout.write(String(m.installerPort))" 2>/dev/null || echo 8787)"
RECOMMENDED="$(node -e "const m=require('$MANIFEST');process.stdout.write(String(m.recommendedNodeVersion))" 2>/dev/null || echo 24.14.0)"
MIN="$(node -e "const m=require('$MANIFEST');process.stdout.write(String(m.minNodeVersion))" 2>/dev/null || echo 20.0.0)"

log() { printf '\033[1;36m[runtime]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[runtime]\033[0m %s\n' "$*"; }
die() { printf '\033[0;31m[installer]\033[0m %s\n' "$*" >&2; exit 1; }

version_ok() {
  local actual="$1" min="$2"
  node -e "const x=process.argv[1].split('.').map(Number);const y=process.argv[2].split('.').map(Number);for(let i=0;i<3;i++){if((x[i]||0)>(y[i]||0))process.exit(0);if((x[i]||0)<(y[i]||0))process.exit(1)}process.exit(0)" "$actual" "$min"
}

resolve_node() {
  local bundled="$ROOT/.evol-runtime/node/bin/node"
  if [ -x "$bundled" ]; then
    NODE="$bundled"
    log "Using bundled runtime v$("$NODE" --version | tr -d 'v')"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    local v
    v="$(node --version | tr -d 'v')" || true
    if [ -n "$v" ] && version_ok "$v" "$MIN"; then
      NODE="$(command -v node)"
      log "Using system Node.js v$v"
      return 0
    fi
    [ -n "$v" ] && warn "System Node v$v is older than the minimum (v$MIN); downloading a fresh runtime."
  fi

  local os arch suffix
  os="$(uname -s)"
  case "$os" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) die "Unsupported OS: $os" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7l) arch="armv7l" ;;
    *) die "Unsupported architecture: $(uname -m)" ;;
  esac

  local base="node-v$RECOMMENDED-$os-$arch" url sums
  url="https://nodejs.org/dist/v$RECOMMENDED/$base.tar.gz"
  sums="https://nodejs.org/dist/v$RECOMMENDED/SHASUMS256.txt"
  local tmp
  tmp="$(mktemp -d)"
  log "Downloading Node.js $RECOMMENDED ($os-$arch)..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$tmp/$base.tar.gz" "$url"
    curl -fsSL -o "$tmp/SHASUMS256.txt" "$sums"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$tmp/$base.tar.gz" "$url"
    wget -q -O "$tmp/SHASUMS256.txt" "$sums"
  else
    die "Need curl or wget to download Node.js"
  fi
  local expected actual
  expected="$(awk "\$2 == \"*$base.tar.gz\" || \$2 == \"$base.tar.gz\" {print \$1}" "$tmp/SHASUMS256.txt")"
  if [ -z "$expected" ]; then die "Checksum file did not list $base.tar.gz"; fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$base.tar.gz" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$tmp/$base.tar.gz" | awk '{print $1}')"
  fi
  if [ "$actual" != "$expected" ]; then die "Node.js download failed checksum verification"; fi
  log "Node.js download verified."

  local runtime_dir="$ROOT/.evol-runtime"
  mkdir -p "$runtime_dir"
  tar -xzf "$tmp/$base.tar.gz" -C "$runtime_dir"
  if [ -e "$runtime_dir/node" ]; then rm -rf "$runtime_dir/node"; fi
  mv "$runtime_dir/$base" "$runtime_dir/node"
  rm -rf "$tmp"
  NODE="$runtime_dir/node/bin/node"
  log "Bundled runtime ready at $NODE"
}

resolve_node

export EVOL_BOOTSTRAP_NODE="$NODE"
log "Starting EVOL Eye installer on http://127.0.0.1:$PORT ..."
"$NODE" "$ROOT/server.mjs" &
SERVER_PID=$!

ready=no
for _ in $(seq 1 120); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    ready=yes
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.25
done

if [ "$ready" != yes ]; then
  die "Installer server did not become ready."
fi

case "$(uname -s)" in
  Darwin) open "http://127.0.0.1:$PORT" ;;
  *) if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:$PORT" & disown; fi ;;
esac

wait "$SERVER_PID"
exit 0