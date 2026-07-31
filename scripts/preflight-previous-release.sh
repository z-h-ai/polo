#!/bin/bash

set -euo pipefail

platform=""
artifact_name=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform) platform="$2"; shift 2 ;;
    --artifact-name) artifact_name="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) printf "Unknown argument: %s\n" "$1" >&2; exit 64 ;;
  esac
done

fail() {
  printf "::error::%s\n" "$1" >&2
  exit 1
}

is_semver() {
  local value="$1"
  [[ "$value" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.((0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]
}

for name in \
  GITHUB_REPOSITORY \
  PREVIOUS_RELEASE_TAG \
  PREVIOUS_RELEASE_VERSION \
  PREVIOUS_RELEASE_COMMIT_SHA \
  EXPECTED_PREVIOUS_ARTIFACT_SHA256 \
  POLO_AI_PREVIOUS_ARTIFACT; do
  [ -n "${!name:-}" ] || fail "Missing immutable previous-release contract field: $name"
done
[ -n "$platform" ] && [ -n "$artifact_name" ] && [ -n "$output" ] \
  || fail "Platform, artifact name, and output are required."

[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || fail "Invalid repository contract."
[[ "$PREVIOUS_RELEASE_TAG" == v* ]] \
  && is_semver "${PREVIOUS_RELEASE_TAG#v}" \
  || fail "Previous release must be a semantic immutable tag."
is_semver "$PREVIOUS_RELEASE_VERSION" \
  || fail "Invalid previous release version."
case "$PREVIOUS_RELEASE_COMMIT_SHA" in
  *[!0-9a-fA-F]*|"") fail "Invalid previous commit SHA." ;;
esac
[ "${#PREVIOUS_RELEASE_COMMIT_SHA}" -eq 40 ] || fail "Previous commit SHA must contain 40 hex characters."
case "$EXPECTED_PREVIOUS_ARTIFACT_SHA256" in
  *[!0-9a-fA-F]*|"") fail "Invalid previous artifact SHA-256." ;;
esac
[ "${#EXPECTED_PREVIOUS_ARTIFACT_SHA256}" -eq 64 ] || fail "Previous artifact SHA-256 must contain 64 hex characters."
case "$artifact_name" in *[!A-Za-z0-9._-]*|"") fail "Invalid artifact name." ;; esac

if [ "$platform" != "windows" ]; then
  [ -n "${EXPECTED_PREVIOUS_INSTALLER_SHA256:-}" ] \
    || fail "Missing immutable previous-release contract field: EXPECTED_PREVIOUS_INSTALLER_SHA256"
  [ -n "${POLO_AI_PREVIOUS_INSTALL_SCRIPT:-}" ] \
    || fail "Missing immutable previous-release contract field: POLO_AI_PREVIOUS_INSTALL_SCRIPT"
  case "$EXPECTED_PREVIOUS_INSTALLER_SHA256" in
    *[!0-9a-fA-F]*|"") fail "Invalid previous installer SHA-256." ;;
  esac
  [ "${#EXPECTED_PREVIOUS_INSTALLER_SHA256}" -eq 64 ] \
    || fail "Previous installer SHA-256 must contain 64 hex characters."
fi

git fetch --force --no-tags origin \
  "refs/tags/${PREVIOUS_RELEASE_TAG}:refs/tags/${PREVIOUS_RELEASE_TAG}"
resolved_commit="$(git rev-list -n 1 "$PREVIOUS_RELEASE_TAG")"
[ "$resolved_commit" = "$PREVIOUS_RELEASE_COMMIT_SHA" ] \
  || fail "Previous tag commit does not match the pinned commit SHA."

release_tag="$(gh release view "$PREVIOUS_RELEASE_TAG" \
  --repo "$GITHUB_REPOSITORY" --json tagName --jq '.tagName')"
release_url="$(gh release view "$PREVIOUS_RELEASE_TAG" \
  --repo "$GITHUB_REPOSITORY" --json url --jq '.url')"
release_draft="$(gh release view "$PREVIOUS_RELEASE_TAG" \
  --repo "$GITHUB_REPOSITORY" --json isDraft --jq '.isDraft')"
[ "$release_tag" = "$PREVIOUS_RELEASE_TAG" ] || fail "Resolved release tag differs from the pinned tag."
[ "$release_draft" = "false" ] || fail "Previous release must not be a draft."
case "$release_url" in
  "https://github.com/${GITHUB_REPOSITORY}/releases/tag/${PREVIOUS_RELEASE_TAG}") ;;
  *) fail "Previous release URL provenance does not match the pinned repository and tag." ;;
esac

resolved_version="$(
  git show "${PREVIOUS_RELEASE_TAG}:apps/electron/package.json" \
    | sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -1
)"
current_version="$(
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    apps/electron/package.json | head -1
)"
[ "$resolved_version" = "$PREVIOUS_RELEASE_VERSION" ] \
  || fail "Previous tag package version does not match the pinned version."
[ -n "$current_version" ] && [ "$resolved_version" != "$current_version" ] \
  || fail "Previous release version must differ from current $current_version."

mkdir -p "$(dirname "$POLO_AI_PREVIOUS_ARTIFACT")" "$(dirname "$output")"
download_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/polo-previous.XXXXXX")"
cleanup() {
  rm -rf "$download_dir"
}
trap cleanup EXIT
gh release download "$PREVIOUS_RELEASE_TAG" \
  --repo "$GITHUB_REPOSITORY" \
  --pattern "$artifact_name" \
  --dir "$download_dir"
downloaded_artifact="$download_dir/$artifact_name"
[ -f "$downloaded_artifact" ] || fail "Previous release artifact was not downloaded."

sha256_path() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

artifact_hash="$(sha256_path "$downloaded_artifact")"
[ "$artifact_hash" = "$(printf '%s' "$EXPECTED_PREVIOUS_ARTIFACT_SHA256" | tr 'A-F' 'a-f')" ] \
  || fail "Previous artifact SHA-256 mismatch."
mv "$downloaded_artifact" "$POLO_AI_PREVIOUS_ARTIFACT"

installer_json="null"
if [ "$platform" != "windows" ]; then
  gh api \
    -H "Accept: application/vnd.github.raw+json" \
    "repos/${GITHUB_REPOSITORY}/contents/scripts/install-app.sh?ref=${PREVIOUS_RELEASE_TAG}" \
    > "$download_dir/install-app.sh"
  installer_hash="$(sha256_path "$download_dir/install-app.sh")"
  [ "$installer_hash" = "$(printf '%s' "$EXPECTED_PREVIOUS_INSTALLER_SHA256" | tr 'A-F' 'a-f')" ] \
    || fail "Previous installer SHA-256 mismatch."
  mv "$download_dir/install-app.sh" "$POLO_AI_PREVIOUS_INSTALL_SCRIPT"
  chmod +x "$POLO_AI_PREVIOUS_INSTALL_SCRIPT"
  installer_json="{\"name\":\"install-app.sh\",\"sha256\":\"$installer_hash\"}"
fi

cat > "$output" <<EOF
{"schemaVersion":1,"repository":"$GITHUB_REPOSITORY","tag":"$PREVIOUS_RELEASE_TAG","version":"$resolved_version","commitSha":"$resolved_commit","releaseUrl":"$release_url","artifact":{"name":"$artifact_name","sha256":"$artifact_hash"},"installer":$installer_json}
EOF
chmod 600 "$output"

if [ -n "${GITHUB_ENV:-}" ]; then
  {
    printf 'RESOLVED_PREVIOUS_COMMIT_SHA=%s\n' "$resolved_commit"
    printf 'RESOLVED_PREVIOUS_VERSION=%s\n' "$resolved_version"
    printf 'CURRENT_ELECTRON_VERSION=%s\n' "$current_version"
  } >> "$GITHUB_ENV"
fi

printf "Verified immutable previous release %s (%s) before runtime setup.\n" \
  "$PREVIOUS_RELEASE_TAG" "$resolved_commit"
