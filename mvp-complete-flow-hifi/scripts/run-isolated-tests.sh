#!/usr/bin/env bash
set -euo pipefail

while IFS= read -r -d '' test_file; do
  bun test --isolate "$test_file"
done < <(
  find . \
    \( \
      -path './.git' \
      -o -path './.pipeline' \
      -o -path './node_modules' \
      -o -path '*/dist' \
      -o -path '*/generated' \
      -o -path '*/release' \
    \) -prune \
    -o -type f -name '*.isolated.ts' -print0
)

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    windows_test="$PWD/apps/electron/resources/scripts/tests/windows-terminal-integration.test.ps1"
    windows_race_test="$PWD/apps/electron/resources/scripts/tests/windows-terminal-integration-race.test.ps1"
    if command -v cygpath >/dev/null 2>&1; then
      windows_test="$(cygpath -w "$windows_test")"
      windows_race_test="$(cygpath -w "$windows_race_test")"
    fi
    powershell.exe -NoLogo -NoProfile -NonInteractive \
      -ExecutionPolicy Bypass -File "$windows_test"
    powershell.exe -NoLogo -NoProfile -NonInteractive \
      -ExecutionPolicy Bypass -File "$windows_race_test"
    ;;
esac
