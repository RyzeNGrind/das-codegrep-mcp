#!/usr/bin/env bash
# agenix-secret-env-wrapper.sh
# ─────────────────────────────────────────────────────────────────────────────
# Generates a KEY=value env file from the raw agenix secret, suitable for
# systemd EnvironmentFile=. Run once after agenix decrypt or on boot via a
# systemd oneshot.
#
# Usage (in NixOS config or manually):
#   bash nix/modules/agenix-secret-env-wrapper.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SECRET_FILE="${1:-/run/agenix/github-pat}"
OUT_FILE="${2:-/run/agenix/github-pat-env}"

if [[ ! -f "$SECRET_FILE" ]]; then
  echo "[agenix-wrapper] ERROR: secret file not found: $SECRET_FILE" >&2
  exit 1
fi

# Validate it looks like a GitHub PAT
PAT=$(< "$SECRET_FILE")
if [[ ! "$PAT" =~ ^ghp_[A-Za-z0-9]{36,}$ ]] && [[ ! "$PAT" =~ ^github_pat_[A-Za-z0-9_]{80,}$ ]]; then
  echo "[agenix-wrapper] WARNING: secret does not match GitHub PAT pattern — proceeding anyway" >&2
fi

printf 'DAS_GH_TOKEN=%s\n' "$PAT" > "$OUT_FILE"
chmod 0400 "$OUT_FILE"
echo "[agenix-wrapper] Wrote env file: $OUT_FILE"
