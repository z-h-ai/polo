#!/usr/bin/env bash
set -euo pipefail

# Zeabur CLI 0.21.0 can report GraphQL/Service Exec failures while exiting 0.
# Capture its output so those false-success responses fail closed without
# echoing tokens or signed asset URLs from a failed command.
log_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
log_file="$(mktemp "$log_dir/polo-zeabur-cli.XXXXXX")"
plain_log="$(mktemp "$log_dir/polo-zeabur-cli-plain.XXXXXX")"
trap 'rm -f "$log_file" "$plain_log"' EXIT

set +e
npx zeabur@latest "$@" >"$log_file" 2>&1
status=$?
set -e

# Strip ANSI colour sequences before matching the CLI's textual error marker.
LC_ALL=C sed $'s/\033\\[[0-9;]*[[:alpha:]]//g' "$log_file" >"$plain_log"

if [ "$status" -ne 0 ] || grep -Eq '(^|[[:space:]])ERROR([[:space:]]|$)|execute command failed:|INTERNAL_ERROR|Extensions: map\[code:' "$plain_log"; then
  trace_id="$(grep -Eo 'traceID:[[:alnum:]-]+' "$plain_log" | tail -n 1 || true)"
  if [ -n "$trace_id" ]; then
    echo "::error::Zeabur CLI command failed ($trace_id)"
  else
    echo "::error::Zeabur CLI command failed"
  fi
  exit 1
fi

cat "$log_file"
