#!/usr/bin/env bash
# Verify build + unit tests + live functional probes, stamp HEAD, and push.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node scripts/verify-live.mjs "$@"

if [ "$(id -u)" -eq 0 ] || [ -f "${HOME}/.git-credentials" ]; then
  GIT_TERMINAL_PROMPT=0 git -C "$ROOT" push origin main
else
  sudo GIT_TERMINAL_PROMPT=0 git -C "$ROOT" push origin main
  sudo chown -R dev:dev "$ROOT/.git" "$ROOT/build"
fi
