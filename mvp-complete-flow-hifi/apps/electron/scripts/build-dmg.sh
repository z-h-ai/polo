#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ARCH="${1:-arm64}"

if [ "$ARCH" = "-h" ] || [ "$ARCH" = "--help" ]; then
  echo "Usage: build-dmg.sh [arm64|x64]"
  echo "Delegates to the target-aware Electron release entry."
  exit 0
fi
if [ "$ARCH" != "arm64" ] && [ "$ARCH" != "x64" ]; then
  echo "Unsupported macOS architecture: $ARCH" >&2
  exit 2
fi
if [ "$#" -gt 1 ]; then
  echo "Legacy upload flags are no longer accepted; package first, then run the release upload workflow." >&2
  exit 2
fi

exec bun run "$ROOT_DIR/scripts/electron-dist.ts" \
  --platform=darwin \
  --arch="$ARCH"
