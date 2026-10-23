#!/usr/bin/env bash
set -euo pipefail

# Execute a command inside the updates-static container on the updates server
# over SSH. Replaces the former Zeabur `service exec` transport; exit codes and
# output pass through unchanged. The server-side authorized_keys entry wraps
# every command in a forced `docker exec` against the updates-static container,
# so the key cannot open a host shell.
if [ "$#" -eq 0 ]; then
  echo "usage: updates-server-exec.sh <command> [args...]" >&2
  exit 1
fi
: "${UPDATES_SSH_HOST:?Missing UPDATES_SSH_HOST}"
: "${UPDATES_SSH_KEY:?Missing UPDATES_SSH_KEY}"

key_file="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/updates-server-key.XXXXXX")"
trap 'rm -f "$key_file"' EXIT
printf '%s\n' "$UPDATES_SSH_KEY" >"$key_file"
chmod 600 "$key_file"

# ssh concatenates its command arguments and hands the result to the remote
# shell. The forced-command wrapper runs `sh -c "$SSH_ORIGINAL_COMMAND"` in
# the container, so unescaped metacharacters are eaten by that parse — the
# v0.19.0 production publish lost its draft asset identity this way (the
# identity JSON's quotes/braces were consumed remotely, "JSON Parse error").
# Escape every argument for exactly one remote shell parse.
remote_cmd=""
for arg in "$@"; do
  remote_cmd+=" $(printf '%q' "$arg")"
done

exec ssh -i "$key_file" \
  -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=20 \
  -o ServerAliveInterval=15 \
  -p "${UPDATES_SSH_PORT:-22}" \
  "${UPDATES_SSH_USER:-ubuntu}@${UPDATES_SSH_HOST}" "${remote_cmd# }"
