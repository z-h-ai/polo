#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$ELECTRON_DIR/release"
ARCH="$(uname -m)"
MODE="${POLO_AI_ARTIFACT_VALIDATION_MODE:-smoke}"

case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-dir) RELEASE_DIR="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$MODE" != "smoke" ] && [ "$MODE" != "full" ]; then
  echo "Mode must be smoke or full" >&2
  exit 2
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/polo-final-artifact.XXXXXX")"
MOUNT_POINTS=()
APP_ROOTS=()
cleanup() {
  local mount_point
  for mount_point in "${MOUNT_POINTS[@]:-}"; do
    [ -n "$mount_point" ] && hdiutil detach "$mount_point" -quiet 2>/dev/null || true
  done
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

validate_app_bundle() {
  local label="$1"
  local resources_root="$2"
  local app_root="$resources_root/app"
  local bun="$resources_root/vendor/bun/bun"
  local wrapper="$app_root/resources/bin/polo"
  local manifest="$app_root/dist/cli/artifact-manifest.json"
  local cli_package="$app_root/dist/cli/package.json"

  for required in \
    "$bun" \
    "$wrapper" \
    "$app_root/dist/cli/polo-cli.js" \
    "$app_root/dist/server/polo-server.js" \
    "$manifest" \
    "$cli_package"; do
    if [ ! -e "$required" ]; then
      echo "$label is missing required terminal artifact: $required" >&2
      return 1
    fi
  done

  "$bun" -e '
    import { createHash } from "node:crypto";
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    const appRoot = process.argv[1];
    const manifest = JSON.parse(readFileSync(join(appRoot, "dist/cli/artifact-manifest.json"), "utf8"));
    const metadata = JSON.parse(readFileSync(join(appRoot, "dist/cli/package.json"), "utf8"));
    const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");
    const expected = {
      cli: "dist/cli/polo-cli.js",
      cliPackage: "dist/cli/package.json",
      server: "dist/server/polo-server.js",
    };
    for (const [name, relativePath] of Object.entries(expected)) {
      if (manifest.artifacts?.[name]?.path !== relativePath) throw new Error(`Unexpected ${name} path`);
      if (manifest.artifacts[name].sha256 !== sha256(join(appRoot, relativePath))) {
        throw new Error(`${name} checksum mismatch`);
      }
    }
    const keys = Object.keys(metadata).sort().join(",");
    if (
      keys !== "bin,license,main,name,type,version"
      || metadata.name !== "@polo-ai/cli"
      || metadata.version !== manifest.version
      || metadata.type !== "module"
      || metadata.main !== "./polo-cli.js"
      || metadata.bin?.polo !== "./polo-cli.js"
      || metadata.bin?.["polo-ai"] !== "./polo-cli.js"
      || metadata.license !== "Apache-2.0"
    ) throw new Error("Sanitized CLI package metadata mismatch");
  ' "$app_root"

  local expected_version
  expected_version="$("$bun" -e 'process.stdout.write(JSON.parse(await Bun.file(process.argv[1]).text()).version)' "$cli_package")"
  local version_output
  version_output="$("$wrapper" --version)"
  if [ "$version_output" != "$expected_version" ]; then
    echo "$label CLI version mismatch: $version_output vs $expected_version" >&2
    return 1
  fi
  "$wrapper" --help | grep -F "Usage: polo " >/dev/null
  echo "✓ $label final-container CLI smoke passed ($expected_version)"
}

validate_macos() {
  local dmg="$RELEASE_DIR/Polo-AI-${ARCH}.dmg"
  local zip="$RELEASE_DIR/Polo-AI-${ARCH}.zip"
  if [ ! -f "$dmg" ] || [ ! -f "$zip" ]; then
    echo "Final macOS validation requires both $dmg and $zip" >&2
    exit 1
  fi

  local mount_point="$TEMP_ROOT/dmg"
  mkdir -p "$mount_point"
  hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$mount_point" -quiet
  MOUNT_POINTS+=("$mount_point")
  validate_app_bundle "DMG" "$mount_point/Polo AI.app/Contents/Resources"
  APP_ROOTS+=("$mount_point/Polo AI.app")

  local zip_root="$TEMP_ROOT/zip"
  mkdir -p "$zip_root"
  ditto -x -k "$zip" "$zip_root"
  validate_app_bundle "ZIP" "$zip_root/Polo AI.app/Contents/Resources"
  APP_ROOTS+=("$zip_root/Polo AI.app")
}

validate_linux() {
  local appimage="$RELEASE_DIR/Polo-AI-${ARCH}.AppImage"
  if [ ! -f "$appimage" ]; then
    if [ "$ARCH" = "x64" ]; then
      appimage="$RELEASE_DIR/Polo-AI-x86_64.AppImage"
    else
      appimage="$RELEASE_DIR/Polo-AI-aarch64.AppImage"
    fi
  fi
  if [ ! -f "$appimage" ]; then
    echo "Final Linux validation requires $appimage" >&2
    exit 1
  fi
  chmod +x "$appimage"
  local extract_root="$TEMP_ROOT/appimage"
  mkdir -p "$extract_root"
  (
    cd "$extract_root"
    "$appimage" --appimage-extract >/dev/null
  )
  validate_app_bundle "AppImage" "$extract_root/squashfs-root/resources"
  APP_ROOTS+=("$extract_root/squashfs-root")
}

run_full_e2e() {
  local source_app="${APP_ROOTS[${#APP_ROOTS[@]}-1]}"
  local test_home="$TEMP_ROOT/用户 home"
  local install_root="$TEMP_ROOT/Applications"
  local installed_app="$install_root/Polo AI.app"
  local runtime_file="$test_home/.polo-ai/runtime/electron.json"
  local launcher="$test_home/.local/bin/polo"
  mkdir -p "$install_root" "$(dirname "$launcher")"

  if [ "$(uname -s)" = "Darwin" ]; then
    ditto "$source_app" "$installed_app"
    ln -s "$installed_app/Contents/Resources/app/resources/bin/polo" "$launcher"
    HOME="$test_home" POLO_AI_RUNTIME_DISCOVERY_FILE="$runtime_file" \
      "$installed_app/Contents/MacOS/Polo AI" >/dev/null 2>&1 &
  else
    cp -a "$source_app" "$installed_app"
    ln -s "$installed_app/resources/app/resources/bin/polo" "$launcher"
    HOME="$test_home" POLO_AI_RUNTIME_DISCOVERY_FILE="$runtime_file" \
      "$installed_app/AppRun" >/dev/null 2>&1 &
  fi
  local app_pid=$!

  local deadline=$((SECONDS + 60))
  while [ ! -s "$runtime_file" ] && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 1
  done
  if [ ! -s "$runtime_file" ]; then
    kill "$app_pid" 2>/dev/null || true
    echo "Full artifact E2E timed out waiting for Electron discovery" >&2
    return 1
  fi

  HOME="$test_home" POLO_AI_RUNTIME_DISCOVERY_FILE="$runtime_file" "$launcher" sessions >/dev/null
  kill "$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true

  rm -rf "$installed_app"
  if [ "$(uname -s)" = "Darwin" ]; then
    ditto "${APP_ROOTS[0]}" "$installed_app"
  else
    cp -a "${APP_ROOTS[0]}" "$installed_app"
  fi
  HOME="$test_home" "$launcher" --version >/dev/null

  rm -f "$launcher"
  rm -rf "$installed_app"
  if [ -e "$launcher" ] || [ -e "$installed_app" ]; then
    echo "Full artifact E2E uninstall cleanup failed" >&2
    return 1
  fi
  echo "✓ Full install/discovery/upgrade-path/uninstall artifact E2E passed"
}

case "$(uname -s)" in
  Darwin) validate_macos ;;
  Linux) validate_linux ;;
  *) echo "Use validate-final-artifacts.ps1 on Windows" >&2; exit 2 ;;
esac

if [ "$MODE" = "full" ]; then
  run_full_e2e
fi
