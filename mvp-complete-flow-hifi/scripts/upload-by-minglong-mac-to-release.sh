#!/bin/bash
# Upload a Polo AI Electron release to the Zeabur static-update host.
#
# Usage:
#   scripts/upload-release.sh 0.15.2
#   scripts/upload-release.sh 0.15.2 --src ~/Downloads/polo-v0.15.2
#
# Prereq:
#   - SSH public key (~/.ssh/id_rsa.pub or id_ed25519.pub) installed at
#     root@120.25.198.159:~/.ssh/authorized_keys (passwordless ssh works).
#     See the MEMORY.md note for the install one-liner.
#
# Verifies, in order:
#   1. SHA256 of every uploaded file matches the local copy.
#   2. CDN HEAD on https://updates.polo.z-h-ai.com/electron/latest/<file> -> 200.
#   3. (If .dmg present and codesign available) inner .app:
#        codesign --verify --strict --deep,
#        TeamIdentifier == ZH2RDLUUAB,
#        spctl "Notarized Developer ID",
#        xcrun stapler validate.

set -euo pipefail

REMOTE_HOST=root@120.25.198.159
REMOTE_PVC_DIR=/var/lib/rancher/k3s/storage/pvc-15a26fab-5a51-45d5-9610-bf74630e57ce_environment-6a7545fa5f062718bc7b62bb_releases-service-6a755c10e4a69d66638c75df/electron/releases
CDN_BASE=https://updates.polo.z-h-ai.com/electron/latest
EXPECTED_TEAM_ID=ZH2RDLUUAB

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=20)
SCP_OPTS=(-q -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=30)

VERSION=""
SRC_DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --src) SRC_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) [ -z "$VERSION" ] && VERSION="$1" || { echo "Unexpected arg: $1" >&2; exit 64; }; shift ;;
  esac
done

[ -n "$VERSION" ] || { echo "Usage: $0 <version> [--src <dir>]" >&2; exit 64; }
[ -n "$SRC_DIR" ] || SRC_DIR="$HOME/Downloads/polo-v$VERSION"

fail() { echo "ERROR: $*" >&2; exit 1; }

sha256_local() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

[ -d "$SRC_DIR" ] || fail "Source dir not found: $SRC_DIR"
shopt -s nullglob
files=("$SRC_DIR"/*)
[ "${#files[@]}" -gt 0 ] || fail "Source dir is empty: $SRC_DIR"
shopt -u nullglob

# Sanity: make sure passwordless ssh works before we start a large transfer.
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "true" \
  || fail "Passwordless SSH to $REMOTE_HOST failed. Install your pubkey in ~/.ssh/authorized_keys first."

REMOTE_DIR="$REMOTE_PVC_DIR/$VERSION"
echo "==> Target: $REMOTE_HOST:$REMOTE_DIR"
ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"

echo "==> Uploading ${#files[@]} files from $SRC_DIR"
scp "${SCP_OPTS[@]}" "${files[@]}" "$REMOTE_HOST:$REMOTE_DIR/"

echo "==> Verifying SHA256 (local vs remote)"
for f in "${files[@]}"; do
  name=$(basename "$f")
  local_sha=$(sha256_local "$f")
  remote_sha=$(ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "cd '$REMOTE_DIR' && sha256sum -- '$name' | awk '{print \$1}'")
  [ "$local_sha" = "$remote_sha" ] || fail "SHA mismatch: $name (local=$local_sha remote=$remote_sha)"
  printf '  OK  %-30s  %s\n' "$name" "$local_sha"
done

echo "==> Verifying CDN HEAD ($CDN_BASE)"
for f in "${files[@]}"; do
  name=$(basename "$f")
  status=$(curl -sI -o /dev/null -w '%{http_code}' "$CDN_BASE/$name")
  [ "$status" = "200" ] || fail "CDN HEAD $name -> $status"
  printf '  OK  %-30s  HTTP %s\n' "$name" "$status"
done

DMG="$SRC_DIR/Polo-AI-x64.dmg"
if [ -f "$DMG" ] && command -v codesign >/dev/null 2>&1; then
  echo "==> Verifying DMG inner .app signature/notarization"
  MP=$(mktemp -d "${TMPDIR:-/tmp}/polo-dmg.XXXXXX")
  cleanup() {
    hdiutil detach "$MP" -quiet 2>/dev/null || true
    rm -rf "$MP"
  }
  trap cleanup EXIT
  hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$MP" -quiet
  APP=$(find "$MP" -maxdepth 2 -name '*.app' -print -quit)
  [ -n "$APP" ] || fail "No .app found inside DMG"

  codesign --verify --strict --deep "$APP" || fail "codesign --verify failed"
  echo "  OK  codesign --verify --strict --deep"

  team_id=$(codesign -dv --verbose=4 "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p' | tail -1)
  [ "$team_id" = "$EXPECTED_TEAM_ID" ] \
    || fail "TeamIdentifier mismatch: got '$team_id', expected '$EXPECTED_TEAM_ID'"
  echo "  OK  TeamIdentifier=$team_id"

  spctl --assess --type execute --verbose=4 "$APP" 2>&1 \
    | grep -F 'source=Notarized Developer ID' >/dev/null \
    || fail "spctl: not 'Notarized Developer ID'"
  echo "  OK  spctl: Notarized Developer ID"

  xcrun stapler validate "$APP" >/dev/null 2>&1 \
    || fail "xcrun stapler validate failed"
  echo "  OK  xcrun stapler validate"

  cleanup
  trap - EXIT
fi

echo "==> Done. v$VERSION uploaded and verified."
