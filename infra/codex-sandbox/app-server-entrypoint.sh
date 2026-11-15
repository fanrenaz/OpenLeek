#!/bin/sh
set -eu

if [ "${OPENLEEK_CODEX_MODE:-run}" = "auth-broker" ]; then
  exec node /usr/local/lib/openleek/auth-broker.mjs
fi

codex_home="${CODEX_HOME:-/var/lib/codex}"
run_root="$(dirname "$codex_home")"
token_file="${OPENLEEK_SANDBOX_APP_SERVER_TOKEN_FILE:-$codex_home/.app-server/capability-token}"
token="${OPENLEEK_SANDBOX_APP_SERVER_TOKEN:-}"

if [ -z "$token" ]; then
  echo "OPENLEEK_SANDBOX_APP_SERVER_TOKEN is required" >&2
  exit 66
fi

# The workspace bind mount is shared only with Agent Execution's Node group.
# Keep generated directories group-writable so the lifecycle owner can remove
# a released run even after Codex creates nested state directories.
umask 007
# Agent Execution pre-creates the per-run bind root as the shared Node group.
# Do not chmod it here: this independent sandbox uid only needs group write
# access, while the Run-owned profile remains writable for restoration.
mkdir -p "$codex_home" "$(dirname "$token_file")"
# Agent Execution materializes the fixed DeepSeek provider and model catalog
# in this Run's CODEX_HOME before the sandbox starts.
[ -s "$codex_home/config.toml" ] || {
  echo "Run CODEX_HOME/config.toml is required" >&2
  exit 66
}
if grep -q '^model_catalog_json' "$codex_home/config.toml"; then
  [ -s "$codex_home/models.json" ] || {
    echo "Run CODEX_HOME/models.json is required by config.toml" >&2
    exit 66
  }
fi
printf '%s' "$token" > "$token_file"
chmod 0600 "$token_file"

node /usr/local/lib/openleek/app-server-health.mjs &
health_pid=$!
cleanup() {
  kill "$health_pid" 2>/dev/null || true
  if [ "${app_server_pid:-}" ]; then
    kill "$app_server_pid" 2>/dev/null || true
    wait "$app_server_pid" 2>/dev/null || true
  fi
  # Codex may create owner-only directories. Restore group traversal before
  # Docker removes this uid so Agent Execution can delete the exact Run root.
  chmod -R g+rwX "$codex_home" "$run_root/workspaces" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

codex app-server \
  -c approval_policy=never \
  -c sandbox_mode=workspace-write \
  --listen ws://0.0.0.0:4500 \
  --ws-auth capability-token \
  --ws-token-file "$token_file" &
app_server_pid=$!
wait "$app_server_pid"
