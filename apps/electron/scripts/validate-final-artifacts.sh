#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$ELECTRON_DIR/release"
ARCH="$(uname -m)"
MODE="${POLO_AI_ARTIFACT_VALIDATION_MODE:-smoke}"
PREVIOUS_ARTIFACT="${POLO_AI_PREVIOUS_ARTIFACT:-}"
INSTALL_SCRIPT="${POLO_AI_INSTALL_SCRIPT:-$ELECTRON_DIR/../../scripts/install-app.sh}"
UNINSTALL_SCRIPT="${POLO_AI_UNINSTALL_SCRIPT:-$ELECTRON_DIR/../../scripts/uninstall-app.sh}"

case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-dir) RELEASE_DIR="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --previous-artifact) PREVIOUS_ARTIFACT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$MODE" != "smoke" ] && [ "$MODE" != "full" ]; then
  echo "Mode must be smoke or full" >&2
  exit 2
fi
if [ "$MODE" = "full" ]; then
  if [ -z "$PREVIOUS_ARTIFACT" ] || [ ! -f "$PREVIOUS_ARTIFACT" ]; then
    echo "Full validation requires --previous-artifact or POLO_AI_PREVIOUS_ARTIFACT" >&2
    exit 1
  fi
  for lifecycle_script in "$INSTALL_SCRIPT" "$UNINSTALL_SCRIPT"; do
    if [ ! -f "$lifecycle_script" ]; then
      echo "Full validation requires lifecycle script: $lifecycle_script" >&2
      exit 1
    fi
  done
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

read_installed_version() {
  local resources_root="$1"
  "$resources_root/vendor/bun/bun" -e \
    'process.stdout.write(JSON.parse(await Bun.file(process.argv[1]).text()).version)' \
    "$resources_root/app/dist/cli/package.json"
}

wait_for_discovery() {
  local runtime_file="$1"
  local deadline=$((SECONDS + 90))
  while [ ! -s "$runtime_file" ] && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 1
  done
  if [ ! -s "$runtime_file" ]; then
    echo "Full artifact E2E timed out waiting for Electron discovery: $runtime_file" >&2
    return 1
  fi
}

stop_discovered_app() {
  local runtime_file="$1"
  local app_pid
  app_pid=$(sed -n 's/.*"pid":[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$runtime_file" | head -1)
  if [ -n "$app_pid" ]; then
    kill "$app_pid" 2>/dev/null || true
    local deadline=$((SECONDS + 15))
    while kill -0 "$app_pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do
      sleep 1
    done
    kill -9 "$app_pid" 2>/dev/null || true
  fi
}

run_fresh_shell() {
  local shell_path="$1"
  local test_home="$2"
  local command="$3"
  env -i \
    HOME="$test_home" \
    SHELL="$shell_path" \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    TMPDIR="$TEMP_ROOT/tmp" \
    "$shell_path" -lic "$command"
}

assert_versions_differ() {
  local previous_version="$1"
  local current_version="$2"
  if [ "$previous_version" = "$current_version" ]; then
    echo "Previous artifact version must differ from current artifact ($current_version)" >&2
    return 1
  fi
}

test_macos_command_conflict() {
  local installed_app="$1"
  local conflict_home="$TEMP_ROOT/conflict 用户"
  local conflict_launcher="$conflict_home/.local/bin/polo"
  mkdir -p "$(dirname "$conflict_launcher")"
  printf '#!/bin/sh\necho user-owned\n' > "$conflict_launcher"
  chmod +x "$conflict_launcher"

  local output
  output=$(HOME="$conflict_home" \
    SHELL=/bin/zsh \
    POLO_AI_TERMINAL_HOME="$conflict_home" \
    "$installed_app/Contents/MacOS/Polo AI" \
      --polo-terminal-integration install)
  printf '%s' "$output" | grep -F '"statusCode":"launcher_conflict"' >/dev/null
  grep -F 'echo user-owned' "$conflict_launcher" >/dev/null
}

run_macos_full_e2e() {
  case "$PREVIOUS_ARTIFACT" in
    *.zip) ;;
    *) echo "macOS full validation requires a previous ZIP artifact" >&2; return 1 ;;
  esac

  local test_home="$TEMP_ROOT/用户 home"
  local install_root="$TEMP_ROOT/Applications with spaces"
  local installed_app="$install_root/Polo AI.app"
  local executable="$installed_app/Contents/MacOS/Polo AI"
  local resources_root="$installed_app/Contents/Resources"
  local launcher="$test_home/.local/bin/polo"
  local runtime_file="$test_home/.polo-ai/runtime/electron.json"
  mkdir -p "$test_home" "$install_root" "$TEMP_ROOT/tmp"

  HOME="$test_home" SHELL=/bin/zsh \
    POLO_AI_INSTALL_ARTIFACT="$PREVIOUS_ARTIFACT" \
    POLO_AI_INSTALL_DIR="$install_root" \
    bash "$INSTALL_SCRIPT"
  local previous_version
  previous_version=$(read_installed_version "$resources_root")

  HOME="$test_home" SHELL=/bin/zsh POLO_AI_TERMINAL_HOME="$test_home" \
    "$executable" --polo-terminal-integration install >/dev/null
  run_fresh_shell /bin/zsh "$test_home" \
    "test \"\$(command -v polo)\" = '$launcher' && test \"\$(polo --version)\" = '$previous_version' && polo --help | grep -F 'Usage: polo ' >/dev/null"
  run_fresh_shell /bin/zsh "$test_home" \
    "POLO_AI_E2E_RUN_PROBE=1 polo run 'packaged headless probe' | grep -F 'Run probe connected via temporary' >/dev/null"

  HOME="$test_home" SHELL=/bin/zsh \
    POLO_AI_INSTALL_ARTIFACT="$RELEASE_DIR/Polo-AI-${ARCH}.zip" \
    POLO_AI_INSTALL_DIR="$install_root" \
    bash "$INSTALL_SCRIPT"
  local current_version
  current_version=$(read_installed_version "$resources_root")
  assert_versions_differ "$previous_version" "$current_version"

  HOME="$test_home" SHELL=/bin/zsh POLO_AI_TERMINAL_HOME="$test_home" \
    "$executable" --polo-terminal-integration repair >/dev/null
  test "$(readlink "$launcher")" = \
    "$resources_root/app/resources/bin/polo"
  run_fresh_shell /bin/zsh "$test_home" \
    "test \"\$(polo --version)\" = '$current_version' && polo --help | grep -F 'Usage: polo ' >/dev/null"
  test_macos_command_conflict "$installed_app"

  run_fresh_shell /bin/zsh "$test_home" \
    "POLO_AI_E2E_DIRECT_APP=1 POLO_AI_RUNTIME_DISCOVERY_FILE='$runtime_file' polo app"
  wait_for_discovery "$runtime_file"
  run_fresh_shell /bin/zsh "$test_home" \
    "POLO_AI_RUNTIME_DISCOVERY_FILE='$runtime_file' polo sessions >/dev/null"
  stop_discovered_app "$runtime_file"

  HOME="$test_home" SHELL=/bin/zsh POLO_AI_TERMINAL_HOME="$test_home" \
    "$executable" --polo-terminal-integration uninstall >/dev/null
  rm -rf "$installed_app"
  if [ -e "$launcher" ] \
    || grep -R -F '# >>> Polo CLI >>>' \
      "$test_home/.zprofile" "$test_home/.bash_profile" \
      "$test_home/.config/fish/conf.d/polo.fish" 2>/dev/null; then
    echo "macOS full E2E left managed terminal state behind" >&2
    return 1
  fi
  echo "✓ macOS real install/settings/discovery/cross-version upgrade/uninstall E2E passed"
}

test_linux_command_conflict() {
  local current_artifact="$1"
  local conflict_home="$TEMP_ROOT/conflict 用户"
  local conflict_launcher="$conflict_home/.local/bin/polo"
  mkdir -p "$(dirname "$conflict_launcher")"
  printf '#!/bin/sh\necho user-owned\n' > "$conflict_launcher"
  chmod +x "$conflict_launcher"

  if HOME="$conflict_home" SHELL=/bin/bash \
    PATH="$conflict_home/.local/bin:/usr/bin:/bin" \
    POLO_AI_INSTALL_ARTIFACT="$current_artifact" \
    bash "$INSTALL_SCRIPT" >/dev/null 2>&1; then
    echo "Linux installer overwrote or accepted a user-owned polo command" >&2
    return 1
  fi
  grep -F 'echo user-owned' "$conflict_launcher" >/dev/null
}

run_linux_full_e2e() {
  case "$PREVIOUS_ARTIFACT" in
    *.AppImage) ;;
    *) echo "Linux full validation requires a previous AppImage artifact" >&2; return 1 ;;
  esac

  local current_artifact="$RELEASE_DIR/Polo-AI-${ARCH}.AppImage"
  local test_home="$TEMP_ROOT/用户 home"
  local launcher="$test_home/.local/bin/polo"
  local installed_app="$test_home/.polo-ai/app/Polo-AI-x64.AppImage"
  local runtime_file="$test_home/.polo-ai/runtime/electron.json"
  mkdir -p "$test_home" "$TEMP_ROOT/tmp"

  HOME="$test_home" SHELL=/bin/bash \
    POLO_AI_INSTALL_ARTIFACT="$PREVIOUS_ARTIFACT" \
    bash "$INSTALL_SCRIPT"
  local previous_version
  previous_version=$(HOME="$test_home" "$launcher" --version)
  run_fresh_shell /bin/bash "$test_home" \
    "test \"\$(command -v polo)\" = '$launcher' && test \"\$(polo --version)\" = '$previous_version' && polo --help | grep -F 'Usage: polo ' >/dev/null"
  run_fresh_shell /bin/bash "$test_home" \
    "POLO_AI_E2E_RUN_PROBE=1 polo run 'packaged headless probe' | grep -F 'Run probe connected via temporary' >/dev/null"

  HOME="$test_home" SHELL=/bin/bash \
    POLO_AI_INSTALL_ARTIFACT="$current_artifact" \
    bash "$INSTALL_SCRIPT"
  local current_version
  current_version=$(HOME="$test_home" "$launcher" --version)
  assert_versions_differ "$previous_version" "$current_version"
  run_fresh_shell /bin/bash "$test_home" \
    "test \"\$(polo --version)\" = '$current_version' && polo --help | grep -F 'Usage: polo ' >/dev/null"
  test_linux_command_conflict "$current_artifact"

  run_fresh_shell /bin/bash "$test_home" \
    "POLO_AI_RUNTIME_DISCOVERY_FILE='$runtime_file' nohup polo app >/dev/null 2>&1 &"
  wait_for_discovery "$runtime_file"
  run_fresh_shell /bin/bash "$test_home" \
    "POLO_AI_RUNTIME_DISCOVERY_FILE='$runtime_file' polo sessions >/dev/null"
  stop_discovered_app "$runtime_file"

  HOME="$test_home" SHELL=/bin/bash bash "$UNINSTALL_SCRIPT"
  if [ -e "$launcher" ] || [ -e "$installed_app" ] \
    || grep -R -F '# >>> Polo CLI >>>' \
      "$test_home/.profile" "$test_home/.bash_profile" \
      "$test_home/.config/fish/conf.d/polo.fish" 2>/dev/null; then
    echo "Linux full E2E left managed install or terminal state behind" >&2
    return 1
  fi
  echo "✓ Linux real install/AppImage/discovery/cross-version upgrade/uninstall E2E passed"
}

case "$(uname -s)" in
  Darwin) validate_macos ;;
  Linux) validate_linux ;;
  *) echo "Use validate-final-artifacts.ps1 on Windows" >&2; exit 2 ;;
esac

if [ "$MODE" = "full" ]; then
  case "$(uname -s)" in
    Darwin) run_macos_full_e2e ;;
    Linux) run_linux_full_e2e ;;
  esac
fi
