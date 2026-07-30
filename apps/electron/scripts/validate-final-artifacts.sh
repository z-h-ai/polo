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
HOST_BUN="$(command -v bun || true)"
CURRENT_ARTIFACT=""
CURRENT_VERSION=""
PREVIOUS_VERSION=""
VALIDATED_VERSION=""
MOCK_PID=""

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
mkdir -p "$TEMP_ROOT/clean-cwd"
MOUNT_POINTS=()
APP_ROOTS=()
CURRENT_RESOURCE_ROOTS=()
cleanup() {
  local mount_point
  if [ -n "$MOCK_PID" ]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  for mount_point in "${MOUNT_POINTS[@]:-}"; do
    [ -n "$mount_point" ] && hdiutil detach "$mount_point" -quiet 2>/dev/null || true
  done
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

validate_app_bundle() {
  local label="$1"
  local resources_root="$2"
  local require_run_helpers="${3:-true}"
  local run_cli_smoke="${4:-true}"
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
  if [ "$require_run_helpers" = "true" ]; then
    for required in \
      "$app_root/resources/pi-agent-server/index.js" \
      "$app_root/resources/session-mcp-server/index.js"; do
      if [ ! -e "$required" ]; then
        echo "$label is missing required run helper: $required" >&2
        return 1
      fi
    done
  fi

  (
    cd "$TEMP_ROOT/clean-cwd"
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
  )

  local expected_version
  expected_version="$(
    cd "$TEMP_ROOT/clean-cwd"
    "$bun" -e \
      'process.stdout.write(JSON.parse(await Bun.file(process.argv[1]).text()).version)' \
      "$cli_package"
  )"
  if [ "$run_cli_smoke" = "true" ]; then
    local version_output
    version_output="$(cd "$TEMP_ROOT/clean-cwd" && "$wrapper" --version)"
    if [ "$version_output" != "$expected_version" ]; then
      echo "$label CLI version mismatch: $version_output vs $expected_version" >&2
      return 1
    fi
    (cd "$TEMP_ROOT/clean-cwd" && "$wrapper" --help) \
      | grep -F "Usage: polo " >/dev/null
    echo "✓ $label final-container CLI smoke passed ($expected_version)"
  fi
  VALIDATED_VERSION="$expected_version"
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
  local run_cli_smoke=true
  [ "$MODE" = "full" ] && run_cli_smoke=false
  validate_app_bundle \
    "DMG" "$mount_point/Polo AI.app/Contents/Resources" true "$run_cli_smoke"
  CURRENT_RESOURCE_ROOTS+=("$mount_point/Polo AI.app/Contents/Resources")
  APP_ROOTS+=("$mount_point/Polo AI.app")

  local zip_root="$TEMP_ROOT/zip"
  mkdir -p "$zip_root"
  ditto -x -k "$zip" "$zip_root"
  validate_app_bundle \
    "ZIP" "$zip_root/Polo AI.app/Contents/Resources" true "$run_cli_smoke"
  CURRENT_RESOURCE_ROOTS+=("$zip_root/Polo AI.app/Contents/Resources")
  APP_ROOTS+=("$zip_root/Polo AI.app")
  CURRENT_ARTIFACT="$zip"
  CURRENT_VERSION="$VALIDATED_VERSION"
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
  local run_cli_smoke=true
  [ "$MODE" = "full" ] && run_cli_smoke=false
  validate_app_bundle \
    "AppImage" "$extract_root/squashfs-root/resources" true "$run_cli_smoke"
  CURRENT_RESOURCE_ROOTS+=("$extract_root/squashfs-root/resources")
  APP_ROOTS+=("$extract_root/squashfs-root")
  CURRENT_ARTIFACT="$appimage"
  CURRENT_VERSION="$VALIDATED_VERSION"
}

preflight_previous_artifact() {
  local system_name="$1"
  local previous_root="$TEMP_ROOT/previous-container"
  mkdir -p "$previous_root"

  if [ "$system_name" = "Darwin" ]; then
    case "$PREVIOUS_ARTIFACT" in
      *.zip) ;;
      *) echo "macOS full validation requires a previous ZIP artifact" >&2; return 1 ;;
    esac
    ditto -x -k "$PREVIOUS_ARTIFACT" "$previous_root"
    validate_app_bundle \
      "previous ZIP preflight" \
      "$previous_root/Polo AI.app/Contents/Resources" \
      false \
      false
  else
    case "$PREVIOUS_ARTIFACT" in
      *.AppImage) ;;
      *) echo "Linux full validation requires a previous AppImage artifact" >&2; return 1 ;;
    esac
    local previous_copy="$previous_root/previous.AppImage"
    cp "$PREVIOUS_ARTIFACT" "$previous_copy"
    chmod +x "$previous_copy"
    (
      cd "$previous_root"
      "$previous_copy" --appimage-extract >/dev/null
    )
    validate_app_bundle \
      "previous AppImage preflight" \
      "$previous_root/squashfs-root/resources" \
      false \
      false
  fi

  PREVIOUS_VERSION="$VALIDATED_VERSION"
  assert_versions_differ "$PREVIOUS_VERSION" "$CURRENT_VERSION"
  echo "✓ read-only lifecycle preflight passed ($PREVIOUS_VERSION -> $CURRENT_VERSION)"
}

run_current_container_smoke() {
  local index=0
  local label
  local resources_root
  for resources_root in "${CURRENT_RESOURCE_ROOTS[@]}"; do
    index=$((index + 1))
    label="current container $index"
    validate_app_bundle "$label" "$resources_root" true true
  done
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
    DISPLAY="${DISPLAY:-}" \
    XAUTHORITY="${XAUTHORITY:-}" \
    WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" \
    XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" \
    DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
    POLO_AI_E2E_EXPECTED_DISPLAY="${POLO_AI_E2E_EXPECTED_DISPLAY:-}" \
    "$shell_path" -lic "cd \"\$HOME\" && $command"
}

assert_versions_differ() {
  local previous_version="$1"
  local current_version="$2"
  if [ "$previous_version" = "$current_version" ]; then
    echo "Previous artifact version must differ from current artifact ($current_version)" >&2
    return 1
  fi
}

run_packaged_headless_lifecycle() {
  local shell_path="$1"
  local test_home="$2"
  local workspace="$TEMP_ROOT/workspace with 空格"
  local fixture_root="$TEMP_ROOT/mock-provider"
  local state_file="$fixture_root/state.json"
  local request_log="$fixture_root/requests.jsonl"
  local provider_log="$fixture_root/provider.log"
  local run_output="$fixture_root/run-output.log"
  local mock_token="polo-artifact-e2e-token-$$-fixed"
  local mock_fixture="$ELECTRON_DIR/scripts/fixtures/mock-openai-provider.ts"
  mkdir -p "$workspace" "$fixture_root"

  if [ -z "$HOST_BUN" ] || [ ! -x "$HOST_BUN" ]; then
    echo "Full artifact E2E requires Bun to run its loopback provider fixture" >&2
    return 1
  fi
  POLO_AI_ARTIFACT_E2E_FIXTURE=1 \
    POLO_AI_ARTIFACT_E2E_ROOT="$fixture_root" \
    POLO_AI_E2E_MOCK_STATE="$state_file" \
    POLO_AI_E2E_MOCK_LOG="$request_log" \
    POLO_AI_E2E_MOCK_TOKEN="$mock_token" \
    "$HOST_BUN" run "$mock_fixture" >"$provider_log" 2>&1 &
  MOCK_PID=$!

  local deadline=$((SECONDS + 15))
  while [ ! -s "$state_file" ] && kill -0 "$MOCK_PID" 2>/dev/null \
    && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.2
  done
  if [ ! -s "$state_file" ]; then
    echo "Mock provider failed to start: $(tail -c 4096 "$provider_log" 2>/dev/null)" >&2
    return 1
  fi

  local base_url
  base_url=$("$HOST_BUN" -e \
    'process.stdout.write(JSON.parse(await Bun.file(process.argv[1]).text()).baseUrl)' \
    "$state_file")
  run_fresh_shell "$shell_path" "$test_home" \
    "polo run --provider openai --model gpt-4o --api-key '$mock_token' --base-url '$base_url' --workspace-dir '$workspace' --timeout 60000 --send-timeout 60000 'hello' >'$run_output' 2>&1 && cat '$run_output'"

  grep -F '"sawHello":true' "$request_log" >/dev/null
  grep -F 'artifact run completed' "$run_output" >/dev/null
  grep -F 'Workspace registered:' "$run_output" >/dev/null
  grep -F 'Server ready: ws://127.0.0.1:' "$run_output" >/dev/null
  grep -R -F "$workspace" "$test_home/.polo-ai" >/dev/null
  local temporary_port
  temporary_port=$(sed -n \
    's/.*Server ready: ws:\\/\\/127\\.0\\.0\\.1:\\([0-9][0-9]*\\).*/\\1/p' \
    "$run_output" | head -1)
  if [ -z "$temporary_port" ]; then
    echo "polo run did not report its temporary loopback port" >&2
    return 1
  fi
  if find "$TEMP_ROOT/tmp" -maxdepth 1 -type d -name 'polo-run-server-*' \
    -print -quit | grep -q .; then
    echo "polo run left its temporary server runtime behind" >&2
    return 1
  fi
  if find "$test_home/.polo-ai/workspaces" -type d -path '*/sessions/*' \
    -print -quit 2>/dev/null | grep -q .; then
    echo "polo run left its temporary session behind" >&2
    return 1
  fi
  if "$HOST_BUN" -e \
    'try { await fetch(`http://127.0.0.1:${process.argv[1]}`); process.exit(1) } catch { process.exit(0) }' \
    "$temporary_port"; then
    :
  else
    echo "polo run left its temporary loopback port open: $temporary_port" >&2
    return 1
  fi

  kill "$MOCK_PID"
  wait "$MOCK_PID" || true
  MOCK_PID=""
  echo "✓ packaged polo run completed workspace/provider/session lifecycle and cleanup"
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
  local test_home="$TEMP_ROOT/用户 home"
  local install_root="$TEMP_ROOT/Applications with spaces"
  local installed_app="$install_root/Polo AI.app"
  local executable="$installed_app/Contents/MacOS/Polo AI"
  local resources_root="$installed_app/Contents/Resources"
  local launcher="$test_home/.local/bin/polo"
  local runtime_file="$test_home/.polo-ai/runtime/electron.json"
  local previous_install="$TEMP_ROOT/install-previous.zip"
  local current_install="$TEMP_ROOT/install-current.zip"
  mkdir -p "$test_home" "$install_root" "$TEMP_ROOT/tmp"
  cp "$PREVIOUS_ARTIFACT" "$previous_install"
  cp "$CURRENT_ARTIFACT" "$current_install"

  HOME="$test_home" SHELL=/bin/zsh \
    POLO_AI_INSTALL_ARTIFACT="$previous_install" \
    POLO_AI_INSTALL_DIR="$install_root" \
    bash "$INSTALL_SCRIPT"
  local previous_version
  previous_version=$(read_installed_version "$resources_root")
  test "$previous_version" = "$PREVIOUS_VERSION"

  HOME="$test_home" SHELL=/bin/zsh POLO_AI_TERMINAL_HOME="$test_home" \
    "$executable" --polo-terminal-integration install >/dev/null
  run_fresh_shell /bin/zsh "$test_home" \
    "test \"\$(command -v polo)\" = '$launcher' && test \"\$(polo --version)\" = '$previous_version' && polo --help | grep -F 'Usage: polo ' >/dev/null"
  HOME="$test_home" SHELL=/bin/zsh \
    POLO_AI_INSTALL_ARTIFACT="$current_install" \
    POLO_AI_INSTALL_DIR="$install_root" \
    bash "$INSTALL_SCRIPT"
  local current_version
  current_version=$(read_installed_version "$resources_root")
  assert_versions_differ "$previous_version" "$current_version"
  test "$current_version" = "$CURRENT_VERSION"

  HOME="$test_home" SHELL=/bin/zsh POLO_AI_TERMINAL_HOME="$test_home" \
    "$executable" --polo-terminal-integration repair >/dev/null
  test "$(readlink "$launcher")" = \
    "$resources_root/app/resources/bin/polo"
  run_fresh_shell /bin/zsh "$test_home" \
    "test \"\$(polo --version)\" = '$current_version' && polo --help | grep -F 'Usage: polo ' >/dev/null"
  run_packaged_headless_lifecycle /bin/zsh "$test_home"
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
  local conflict_artifact="$TEMP_ROOT/conflict-current.AppImage"
  mkdir -p "$(dirname "$conflict_launcher")"
  cp "$current_artifact" "$conflict_artifact"
  printf '#!/bin/sh\necho user-owned\n' > "$conflict_launcher"
  chmod +x "$conflict_launcher"

  if HOME="$conflict_home" SHELL=/bin/bash \
    PATH="$conflict_home/.local/bin:/usr/bin:/bin" \
    POLO_AI_INSTALL_ARTIFACT="$conflict_artifact" \
    bash "$INSTALL_SCRIPT" >/dev/null 2>&1; then
    echo "Linux installer overwrote or accepted a user-owned polo command" >&2
    return 1
  fi
  grep -F 'echo user-owned' "$conflict_launcher" >/dev/null
}

run_linux_full_e2e() {
  local current_artifact="$CURRENT_ARTIFACT"
  local test_home="$TEMP_ROOT/用户 home"
  local launcher="$test_home/.local/bin/polo"
  local installed_app="$test_home/.polo-ai/app/Polo-AI-x64.AppImage"
  local runtime_file="$test_home/.polo-ai/runtime/electron.json"
  local previous_install="$TEMP_ROOT/install-previous.AppImage"
  local current_install="$TEMP_ROOT/install-current.AppImage"
  mkdir -p "$test_home" "$TEMP_ROOT/tmp"
  cp "$PREVIOUS_ARTIFACT" "$previous_install"
  cp "$current_artifact" "$current_install"
  if [ -z "${DISPLAY:-}" ]; then
    echo "Linux full E2E requires a runner-provided DISPLAY (use xvfb-run -a)" >&2
    return 1
  fi
  local expected_display="${POLO_AI_E2E_EXPECTED_DISPLAY:-$DISPLAY}"
  if [ "$DISPLAY" != "$expected_display" ]; then
    echo "Linux full E2E did not inherit the dynamic Xvfb display" >&2
    return 1
  fi
  run_fresh_shell /bin/bash "$test_home" \
    "test \"\$DISPLAY\" = '$expected_display'"

  HOME="$test_home" SHELL=/bin/bash \
    POLO_AI_INSTALL_ARTIFACT="$previous_install" \
    bash "$INSTALL_SCRIPT"
  local previous_version
  previous_version=$(HOME="$test_home" "$launcher" --version)
  test "$previous_version" = "$PREVIOUS_VERSION"
  run_fresh_shell /bin/bash "$test_home" \
    "test \"\$(command -v polo)\" = '$launcher' && test \"\$(polo --version)\" = '$previous_version' && polo --help | grep -F 'Usage: polo ' >/dev/null"
  HOME="$test_home" SHELL=/bin/bash \
    POLO_AI_INSTALL_ARTIFACT="$current_install" \
    bash "$INSTALL_SCRIPT"
  local current_version
  current_version=$(HOME="$test_home" "$launcher" --version)
  assert_versions_differ "$previous_version" "$current_version"
  test "$current_version" = "$CURRENT_VERSION"
  run_fresh_shell /bin/bash "$test_home" \
    "test \"\$(polo --version)\" = '$current_version' && polo --help | grep -F 'Usage: polo ' >/dev/null"
  run_packaged_headless_lifecycle /bin/bash "$test_home"
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

SYSTEM_NAME="$(uname -s)"
case "$SYSTEM_NAME" in
  Darwin) validate_macos ;;
  Linux) validate_linux ;;
  *) echo "Use validate-final-artifacts.ps1 on Windows" >&2; exit 2 ;;
esac

if [ "$MODE" = "full" ]; then
  preflight_previous_artifact "$SYSTEM_NAME"
  run_current_container_smoke
  case "$SYSTEM_NAME" in
    Darwin) run_macos_full_e2e ;;
    Linux) run_linux_full_e2e ;;
  esac
fi
