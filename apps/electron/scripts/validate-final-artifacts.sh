#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$ELECTRON_DIR/release"
ARCH="$(uname -m)"
MODE="${POLO_AI_ARTIFACT_VALIDATION_MODE:-smoke}"
PREVIOUS_ARTIFACT="${POLO_AI_PREVIOUS_ARTIFACT:-}"
PREVIOUS_INSTALL_SCRIPT="${POLO_AI_PREVIOUS_INSTALL_SCRIPT:-}"
INSTALL_SCRIPT="${POLO_AI_INSTALL_SCRIPT:-$ELECTRON_DIR/../../scripts/install-app.sh}"
UNINSTALL_SCRIPT="${POLO_AI_UNINSTALL_SCRIPT:-$ELECTRON_DIR/../../scripts/uninstall-app.sh}"
HOST_BUN="$(command -v bun || true)"
SYSTEM_NAME="$(uname -s)"
CURRENT_ARTIFACT=""
CURRENT_VERSION=""
PREVIOUS_VERSION=""
VALIDATED_VERSION=""
MOCK_PID=""
MAC_LAUNCH_ENV_CONFIGURED=false
MAC_INSTALLED_APP=""
SIGNING_CONTRACT="$ELECTRON_DIR/../../scripts/release-signing-contract.ts"
MACOS_TEAM_ID="${POLO_AI_RELEASE_MACOS_TEAM_ID:-}"
MACOS_APP_REQUIREMENT="${POLO_AI_RELEASE_MACOS_APP_REQUIREMENT:-}"
MACOS_UV_REQUIREMENT="${POLO_AI_RELEASE_MACOS_UV_REQUIREMENT:-}"

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

if [ "$MODE" != "smoke" ] && [ "$MODE" != "full" ] && [ "$MODE" != "bootstrap" ]; then
  echo "Mode must be smoke, bootstrap, or full" >&2
  exit 2
fi
if [ "$MODE" = "full" ] || [ "$MODE" = "bootstrap" ]; then
  for lifecycle_script in "$INSTALL_SCRIPT" "$UNINSTALL_SCRIPT"; do
    if [ ! -f "$lifecycle_script" ]; then
      echo "Release validation requires lifecycle script: $lifecycle_script" >&2
      exit 1
    fi
  done
fi
if [ "$MODE" = "full" ]; then
  if [ -z "$PREVIOUS_ARTIFACT" ] || [ ! -f "$PREVIOUS_ARTIFACT" ]; then
    echo "Full validation requires --previous-artifact or POLO_AI_PREVIOUS_ARTIFACT" >&2
    exit 1
  fi
  if [ -z "$PREVIOUS_INSTALL_SCRIPT" ] || [ ! -f "$PREVIOUS_INSTALL_SCRIPT" ]; then
    echo "Full Unix validation requires POLO_AI_PREVIOUS_INSTALL_SCRIPT from the fixed previous release tag" >&2
    exit 1
  fi
fi
if [ "$MODE" = "full" ] || [ "$MODE" = "bootstrap" ]; then
  if [ "$SYSTEM_NAME" = "Darwin" ]; then
    for release_identity in \
      "$MACOS_TEAM_ID" \
      "$MACOS_APP_REQUIREMENT" \
      "$MACOS_UV_REQUIREMENT"; do
      if [ -z "$release_identity" ]; then
        echo "Full macOS validation requires the release Team ID and App/uv designated requirements" >&2
        exit 1
      fi
    done
    if [ -z "$HOST_BUN" ] || [ ! -x "$HOST_BUN" ] || [ ! -f "$SIGNING_CONTRACT" ]; then
      echo "Full macOS validation requires Bun and the release signing contract validator" >&2
      exit 1
    fi
  fi
fi

SIGNING_AUDIT_FILE="${POLO_AI_RELEASE_SIGNING_AUDIT_FILE:-$RELEASE_DIR/release-signing-audit-${SYSTEM_NAME}.jsonl}"
if { [ "$MODE" = "full" ] || [ "$MODE" = "bootstrap" ]; } && [ "$SYSTEM_NAME" = "Darwin" ]; then
  : > "$SIGNING_AUDIT_FILE"
  echo "release-signing-contract platform=macos mode=full team_id=$MACOS_TEAM_ID audit=$SIGNING_AUDIT_FILE"
elif [ "$MODE" = "full" ] || [ "$MODE" = "bootstrap" ]; then
  echo "release-signing-contract platform=$SYSTEM_NAME mode=full signing=not-applicable"
else
  echo "release-signing-contract platform=$SYSTEM_NAME mode=smoke acceptance=development-only"
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/polo-final-artifact.XXXXXX")"
mkdir -p "$TEMP_ROOT/clean-cwd"
MOUNT_POINTS=()
APP_ROOTS=()
CURRENT_RESOURCE_ROOTS=()
cleanup() {
  local mount_point
  if [ "$MAC_LAUNCH_ENV_CONFIGURED" = "true" ]; then
    launchctl unsetenv POLO_AI_RUNTIME_DISCOVERY_FILE 2>/dev/null || true
  fi
  if [ -n "$MAC_INSTALLED_APP" ]; then
    rm -rf "$MAC_INSTALLED_APP"
  fi
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

macos_team_id() {
  codesign -dv --verbose=4 "$1" 2>&1 \
    | sed -n 's/^TeamIdentifier=//p' \
    | tail -1
}

macos_designated_requirement() {
  codesign -dr - "$1" 2>&1 \
    | sed -n 's/^designated => //p' \
    | tail -1
}

validate_macos_release_identity() {
  local label="$1"
  local app_bundle="$2"
  local uv="$3"
  local app_signature=invalid
  local uv_signature=invalid
  local notarization=rejected
  local stapling=invalid
  local app_team_id
  local uv_team_id
  local app_requirement
  local uv_requirement

  if codesign --verify --strict --deep "$app_bundle"; then app_signature=valid; fi
  if codesign --verify --strict "$uv"; then uv_signature=valid; fi
  app_team_id="$(macos_team_id "$app_bundle")"
  uv_team_id="$(macos_team_id "$uv")"
  app_requirement="$(macos_designated_requirement "$app_bundle")"
  uv_requirement="$(macos_designated_requirement "$uv")"
  if spctl --assess --type execute --verbose=4 "$app_bundle" 2>&1 \
    | grep -F 'source=Notarized Developer ID' >/dev/null; then
    notarization=accepted
  fi
  if xcrun stapler validate "$app_bundle" >/dev/null 2>&1; then
    stapling=valid
  fi

  "$HOST_BUN" run "$SIGNING_CONTRACT" verify-macos \
    --label "$label" \
    --expected-team-id "$MACOS_TEAM_ID" \
    --expected-app-requirement "$MACOS_APP_REQUIREMENT" \
    --expected-uv-requirement "$MACOS_UV_REQUIREMENT" \
    --actual-app-team-id "$app_team_id" \
    --actual-app-requirement "$app_requirement" \
    --actual-uv-team-id "$uv_team_id" \
    --actual-uv-requirement "$uv_requirement" \
    --app-signature "$app_signature" \
    --uv-signature "$uv_signature" \
    --notarization "$notarization" \
    --stapling "$stapling" \
    --output "$SIGNING_AUDIT_FILE"
}

validate_app_bundle() {
  local label="$1"
  local resources_root="$2"
  local require_run_helpers="${3:-true}"
  local run_cli_smoke="${4:-true}"
  local app_root="$resources_root/app"
  local bun="$resources_root/vendor/bun/bun"
  local wrapper="$app_root/resources/bin/polo"
  local wrapper_messages="$app_root/resources/bin/polo-messages.sh"
  local linux_terminal_helper="$app_root/resources/scripts/linux-terminal-integration.sh"
  local atomic_rename_helper="$app_root/resources/scripts/atomic-rename-no-replace.ts"
  local manifest="$app_root/dist/cli/artifact-manifest.json"
  local cli_package="$app_root/dist/cli/package.json"
  local platform_key
  case "$SYSTEM_NAME" in
    Darwin) platform_key="darwin-$ARCH" ;;
    Linux) platform_key="linux-$ARCH" ;;
    *) echo "Unsupported current artifact platform: $SYSTEM_NAME" >&2; return 1 ;;
  esac
  local uv="$app_root/resources/bin/$platform_key/uv"
  local uv_manifest="$app_root/resources/bin/$platform_key/runtime-manifest.json"
  local uv_lock="$ELECTRON_DIR/../../scripts/uv-runtime-lock.json"

  for required in \
    "$bun" \
    "$uv" \
    "$uv_manifest" \
    "$uv_lock" \
    "$wrapper" \
    "$wrapper_messages" \
    "$app_root/dist/cli/polo-cli.js" \
    "$app_root/dist/server/polo-server.js" \
    "$manifest" \
    "$cli_package"; do
    if [ ! -e "$required" ]; then
      echo "$label is missing required terminal artifact: $required" >&2
      return 1
    fi
  done
  if [ "$SYSTEM_NAME" = "Linux" ] \
    && { [ ! -f "$linux_terminal_helper" ] \
      || [ ! -x "$linux_terminal_helper" ] \
      || [ ! -f "$atomic_rename_helper" ] \
      || [ -L "$atomic_rename_helper" ]; }; then
    echo "$label is missing a trusted Linux terminal transaction helper" >&2
    return 1
  fi
  if [ ! -x "$uv" ]; then
    echo "$label uv runtime is not executable: $uv" >&2
    return 1
  fi
  local uv_version
  uv_version="$(cd "$TEMP_ROOT/clean-cwd" && "$uv" --version)"
  local expected_uv_version
  expected_uv_version="$(
    "$bun" -e \
      'process.stdout.write(JSON.parse(await Bun.file(process.argv[1]).text()).version)' \
      "$uv_manifest"
  )"
  if [ "$uv_version" != "uv $expected_uv_version" ] \
    && ! printf '%s\n' "$uv_version" \
      | grep -E "^uv ${expected_uv_version//./\\.} \\([^()]+\\)$" >/dev/null; then
    echo "$label uv runtime version mismatch: $uv_version" >&2
    return 1
  fi
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
    const platformKey = process.argv[2];
    const uvLockPath = process.argv[3];
    const manifest = JSON.parse(readFileSync(join(appRoot, "dist/cli/artifact-manifest.json"), "utf8"));
    const metadata = JSON.parse(readFileSync(join(appRoot, "dist/cli/package.json"), "utf8"));
    const runtimeManifest = JSON.parse(
      readFileSync(join(appRoot, "resources/bin", platformKey, "runtime-manifest.json"), "utf8"),
    );
    const uvLock = JSON.parse(readFileSync(uvLockPath, "utf8"));
    const uvTarget = uvLock.targets?.[platformKey];
    const [platform, arch] = platformKey.split("-");
    const uv = join(appRoot, "resources/bin", platformKey, "uv");
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
    if (
      !uvTarget
      || runtimeManifest.schemaVersion !== 1
      || runtimeManifest.platform !== platform
      || runtimeManifest.arch !== arch
      || runtimeManifest.source !== "astral-sh-release"
      || runtimeManifest.version !== uvLock.version
      || runtimeManifest.binary !== "uv"
      || runtimeManifest.sha256 !== uvTarget.binarySha256
      || (platform !== "darwin" && runtimeManifest.sha256 !== sha256(uv))
      || runtimeManifest.releaseAsset !== uvTarget.asset
      || runtimeManifest.releaseAssetSha256 !== uvTarget.archiveSha256
    ) throw new Error("Pinned uv runtime manifest mismatch");
  ' "$app_root" "$platform_key" "$uv_lock"
  )
  if [ "$SYSTEM_NAME" = "Darwin" ]; then
    local app_bundle
    app_bundle="$(dirname "$(dirname "$resources_root")")"
    if [ "$MODE" != "smoke" ]; then
      validate_macos_release_identity "$label" "$app_bundle" "$uv"
    else
      # Development smoke explicitly permits electron-builder's ad-hoc signing.
      # It is never release acceptance and does not produce a signing audit.
      codesign --verify --strict --deep "$app_bundle"
      codesign --verify --strict "$uv"
      echo "release-signing-result platform=macos label=$label mode=smoke acceptance=development-only"
    fi
  fi

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

validate_legacy_app_bundle() {
  local label="$1"
  local resources_root="$2"
  local app_root="$resources_root/app"
  local package_json="$app_root/package.json"
  local legacy_wrapper="$app_root/resources/bin/polo-ai"

  if [ -z "$HOST_BUN" ] || [ ! -x "$HOST_BUN" ]; then
    echo "Legacy artifact preflight requires the build runner's Bun" >&2
    return 1
  fi
  for required in \
    "$package_json" \
    "$app_root/dist/main.cjs" \
    "$legacy_wrapper"; do
    if [ ! -e "$required" ]; then
      echo "$label is not a supported pre-POO-14 Electron layout: $required" >&2
      return 1
    fi
  done
  if [ -e "$app_root/dist/cli/artifact-manifest.json" ]; then
    echo "$label unexpectedly contains the current POO-14 artifact manifest" >&2
    return 1
  fi
  case "$SYSTEM_NAME" in
    Darwin)
      test -x "$resources_root/../MacOS/Polo AI" || {
        echo "$label does not contain the legacy macOS executable" >&2
        return 1
      }
      ;;
    Linux)
      test -x "$resources_root/../AppRun" || {
        echo "$label does not contain the legacy AppImage entrypoint" >&2
        return 1
      }
      ;;
  esac

  local platform
  [ "$SYSTEM_NAME" = "Darwin" ] && platform="darwin" || platform="linux"
  VALIDATED_VERSION="$(
    cd "$TEMP_ROOT/clean-cwd"
    "$HOST_BUN" run "$ELECTRON_DIR/../../scripts/validate-legacy-electron-layout.ts" \
      --app-root "$app_root" \
      --platform "$platform"
  )"
  echo "✓ $label legacy container contract passed ($VALIDATED_VERSION)"
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
    validate_legacy_app_bundle \
      "previous ZIP preflight" \
      "$previous_root/Polo AI.app/Contents/Resources"
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
    validate_legacy_app_bundle \
      "previous AppImage preflight" \
      "$previous_root/squashfs-root/resources"
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

read_installed_legacy_version() {
  local resources_root="$1"
  "$HOST_BUN" -e \
    'process.stdout.write(JSON.parse(await Bun.file(process.argv[1]).text()).version)' \
    "$resources_root/app/package.json"
}

read_installed_legacy_version_from_appimage() {
  local appimage="$1"
  local extract_root="$TEMP_ROOT/installed-legacy-appimage"
  rm -rf "$extract_root"
  mkdir -p "$extract_root"
  (
    cd "$extract_root"
    "$appimage" --appimage-extract >/dev/null
  )
  read_installed_legacy_version "$extract_root/squashfs-root/resources"
}

run_previous_release_installer() {
  local test_home="$1"
  local artifact="$2"
  local shim_dir="$TEMP_ROOT/legacy installer shim"
  local manifest="$shim_dir/manifest.yml"
  local curl_shim="$shim_dir/curl"
  local host_arch
  local checksum
  local filename

  case "$(uname -m)" in
    arm64|aarch64) host_arch="arm64" ;;
    x86_64|amd64) host_arch="x64" ;;
    *) echo "Unsupported legacy installer host architecture" >&2; return 1 ;;
  esac
  if [ "$SYSTEM_NAME" = "Darwin" ]; then
    checksum="$(shasum -a 512 "$artifact" | cut -d' ' -f1 | xxd -r -p | base64)"
  else
    checksum="$(sha512sum "$artifact" | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n')"
  fi
  filename="$(basename "$artifact")"

  mkdir -p "$shim_dir"
  cat > "$manifest" <<EOF
version: $PREVIOUS_VERSION
files:
  - url: $filename
    sha512: $checksum
    arch: $host_arch
EOF
  cat > "$curl_shim" <<'EOF'
#!/bin/bash
set -euo pipefail
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "$url" == *.yml ]]; then
  if [ -n "$output" ]; then
    cp "$POLO_AI_LEGACY_MANIFEST" "$output"
  else
    cat "$POLO_AI_LEGACY_MANIFEST"
  fi
else
  test -n "$output"
  cp "$POLO_AI_LEGACY_ARTIFACT" "$output"
fi
EOF
  chmod +x "$curl_shim"

  HOME="$test_home" \
    PATH="$shim_dir:/usr/bin:/bin:/usr/sbin:/sbin" \
    POLO_AI_LEGACY_MANIFEST="$manifest" \
    POLO_AI_LEGACY_ARTIFACT="$artifact" \
    bash "$PREVIOUS_INSTALL_SCRIPT"
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
  if ! run_fresh_shell "$shell_path" "$test_home" \
    "polo run --provider openai --model gpt-4o --api-key '$mock_token' --base-url '$base_url' -C '$workspace' --verbose --timeout 60000 --send-timeout 60000 'hello' >'$run_output' 2>&1"; then
    echo "Packaged polo run failed:" >&2
    cat "$run_output" >&2
    return 1
  fi
  cat "$run_output"

  grep -F '"sawHello":true' "$request_log" >/dev/null
  grep -F 'artifact run completed' "$run_output" >/dev/null
  grep -F 'Server ready: ws://127.0.0.1:' "$run_output" >/dev/null
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

macos_running_application_state() {
  local pid="$1"
  /usr/bin/osascript -l JavaScript \
    "$SCRIPT_DIR/macos-running-app-state.jxa" \
    "$pid"
}

wait_for_macos_frontmost_state() {
  local pid="$1"
  local phase="$2"
  local expected="$3"
  local deadline=$((SECONDS + 30))
  local state=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$(macos_running_application_state "$pid" 2>&1 || true)"
    if [ "$expected" = "true" ] \
      && printf '%s' "$state" | grep -F '"active":true' >/dev/null \
      && printf '%s' "$state" | grep -F '"frontmost":true' >/dev/null; then
      echo "macos-focus-state phase=$phase pid=$pid expected=true state=$state"
      return 0
    fi
    if [ "$expected" = "false" ] \
      && printf '%s' "$state" | grep -F '"active":false' >/dev/null \
      && printf '%s' "$state" | grep -F '"frontmost":false' >/dev/null; then
      echo "macos-focus-state phase=$phase pid=$pid expected=false state=$state"
      return 0
    fi
    sleep 0.25
  done
  echo "macos-focus-state phase=$phase pid=$pid expected=$expected timedOut=true state=$state" >&2
  return 1
}

run_macos_full_e2e() {
  local test_home="$TEMP_ROOT/用户 home"
  local install_root="/Applications"
  local installed_app="$install_root/Polo AI.app"
  local executable="$installed_app/Contents/MacOS/Polo AI"
  local resources_root="$installed_app/Contents/Resources"
  local launcher="$test_home/.local/bin/polo"
  local runtime_file="$test_home/.polo-ai/runtime/electron.json"
  local current_install="$TEMP_ROOT/install-current.zip"
  mkdir -p "$test_home" "$install_root" "$TEMP_ROOT/tmp"
  cp "$CURRENT_ARTIFACT" "$current_install"
  if [ -e "$installed_app" ]; then
    echo "macOS full E2E requires a clean runner without $installed_app" >&2
    return 1
  fi
  MAC_INSTALLED_APP="$installed_app"

  local previous_version=""
  if [ "$MODE" = "full" ]; then
    run_previous_release_installer "$test_home" "$PREVIOUS_ARTIFACT"
    previous_version=$(read_installed_legacy_version "$resources_root")
    test "$previous_version" = "$PREVIOUS_VERSION"
    test -x "$resources_root/app/resources/bin/polo-ai"
    test ! -e "$launcher"
  fi
  HOME="$test_home" SHELL=/bin/zsh \
    POLO_AI_INSTALL_ARTIFACT="$current_install" \
    POLO_AI_INSTALL_DIR="$install_root" \
    bash "$INSTALL_SCRIPT"
  local current_version
  current_version=$(read_installed_version "$resources_root")
  if [ "$MODE" = "full" ]; then
    assert_versions_differ "$previous_version" "$current_version"
  fi
  test "$current_version" = "$CURRENT_VERSION"

  local integration_output
  integration_output=$(HOME="$test_home" SHELL=/bin/zsh \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    POLO_AI_TERMINAL_HOME="$test_home" \
    "$executable" --polo-terminal-integration install)
  if ! printf '%s' "$integration_output" \
    | grep -F '"statusCode":"ready"' >/dev/null; then
    echo "macOS terminal integration install did not become ready: $integration_output" >&2
    return 1
  fi
  test "$(readlink "$launcher")" = \
    "$resources_root/app/resources/bin/polo"
  run_fresh_shell /bin/zsh "$test_home" \
    "test \"\$(polo --version)\" = '$current_version' && polo --help | grep -F 'Usage: polo ' >/dev/null"
  run_packaged_headless_lifecycle /bin/zsh "$test_home"
  test_macos_command_conflict "$installed_app"

  launchctl setenv POLO_AI_RUNTIME_DISCOVERY_FILE "$runtime_file"
  MAC_LAUNCH_ENV_CONFIGURED=true
  run_fresh_shell /bin/zsh "$test_home" "polo app"
  wait_for_discovery "$runtime_file"
  local initial_app_pid
  initial_app_pid=$(sed -n 's/.*"pid":[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$runtime_file" | head -1)
  test -n "$initial_app_pid"
  wait_for_macos_frontmost_state "$initial_app_pid" "cold-launch" true
  /usr/bin/osascript -e 'tell application "Finder" to activate'
  wait_for_macos_frontmost_state "$initial_app_pid" "background-before-focus" false
  run_fresh_shell /bin/zsh "$test_home" "polo app"
  local focused_app_pid
  focused_app_pid=$(sed -n 's/.*"pid":[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$runtime_file" | head -1)
  test "$focused_app_pid" = "$initial_app_pid"
  kill -0 "$focused_app_pid"
  wait_for_macos_frontmost_state "$focused_app_pid" "second-polo-app-focus" true
  run_fresh_shell /bin/zsh "$test_home" \
    "POLO_AI_RUNTIME_DISCOVERY_FILE='$runtime_file' polo sessions >/dev/null"
  stop_discovered_app "$runtime_file"
  launchctl unsetenv POLO_AI_RUNTIME_DISCOVERY_FILE
  MAC_LAUNCH_ENV_CONFIGURED=false

  integration_output=$(HOME="$test_home" SHELL=/bin/zsh \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    POLO_AI_TERMINAL_HOME="$test_home" \
    "$executable" --polo-terminal-integration uninstall)
  if ! printf '%s' "$integration_output" \
    | grep -F '"statusCode":"not_installed"' >/dev/null; then
    echo "macOS terminal integration uninstall left managed state: $integration_output" >&2
    return 1
  fi
  rm -rf "$installed_app"
  MAC_INSTALLED_APP=""
  if [ -e "$launcher" ] \
    || grep -R -F '# >>> Polo CLI >>>' \
      "$test_home/.zprofile" "$test_home/.bash_profile" \
      "$test_home/.config/fish/conf.d/polo.fish" 2>/dev/null; then
    echo "macOS full E2E left managed terminal state behind" >&2
    return 1
  fi
  echo "✓ macOS real install/settings/discovery/${MODE}/uninstall E2E passed"
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
  local current_install="$TEMP_ROOT/install-current.AppImage"
  mkdir -p "$test_home" "$TEMP_ROOT/tmp"
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

  local previous_version=""
  if [ "$MODE" = "full" ]; then
    run_previous_release_installer "$test_home" "$PREVIOUS_ARTIFACT"
    previous_version=$(read_installed_legacy_version_from_appimage "$test_home/.polo-ai/app/Polo-AI-x64.AppImage")
    test "$previous_version" = "$PREVIOUS_VERSION"
    test ! -e "$launcher"
    test -x "$test_home/.local/bin/polo-ai"
  fi
  HOME="$test_home" SHELL=/bin/bash \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    POLO_AI_INSTALL_ARTIFACT="$current_install" \
    bash "$INSTALL_SCRIPT"
  local current_version
  current_version=$(HOME="$test_home" "$launcher" --version)
  if [ "$MODE" = "full" ]; then
    assert_versions_differ "$previous_version" "$current_version"
  fi
  test "$current_version" = "$CURRENT_VERSION"
  run_fresh_shell /bin/bash "$test_home" \
    "test \"\$(polo --version)\" = '$current_version' && test \"\$(polo-ai --version 2>/dev/null)\" = '$current_version' && polo --help | grep -F 'Usage: polo ' >/dev/null"
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
    || [ -e "$test_home/.polo-ai/terminal-integration-linux.state" ] \
    || grep -R -F '# >>> Polo CLI >>>' \
      "$test_home/.profile" "$test_home/.bash_profile" \
      "$test_home/.config/fish/conf.d/polo.fish" 2>/dev/null; then
    echo "Linux full E2E left managed install or terminal state behind" >&2
    return 1
  fi
  echo "✓ Linux real install/AppImage/discovery/${MODE}/uninstall E2E passed"
}

case "$SYSTEM_NAME" in
  Darwin) validate_macos ;;
  Linux) validate_linux ;;
  *) echo "Use validate-final-artifacts.ps1 on Windows" >&2; exit 2 ;;
esac

if [ "$MODE" = "full" ] || [ "$MODE" = "bootstrap" ]; then
  if [ "$MODE" = "full" ]; then
    preflight_previous_artifact "$SYSTEM_NAME"
  fi
  run_current_container_smoke
  case "$SYSTEM_NAME" in
    Darwin) run_macos_full_e2e ;;
    Linux) run_linux_full_e2e ;;
  esac
fi
