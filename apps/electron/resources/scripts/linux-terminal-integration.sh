#!/bin/bash

set -euo pipefail

OWNER="com.poloai.terminal-integration"
FORMAT="managed-symlink-v1"
SCHEMA_VERSION="4"
STATE_NAME="terminal-integration-linux.state"

warn() {
  printf "! %s\n" "$1" >&2
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

canonical_existing_path() {
  readlink -f -- "$1"
}

encode_value() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

decode_value() {
  printf '%s' "$1" | base64 -d 2>/dev/null
}

link_identity() {
  local version="$1"
  local path="$2"
  local target="$3"
  local target_hash="$4"
  printf '%s\0%s\0%s\0%s\0%s\0%s\0' \
    "$OWNER" "$FORMAT" "$version" "$path" "$target" "$target_hash" \
    | sha256sum \
    | awk '{print $1}'
}

state_value() {
  local state_file="$1"
  local key="$2"
  [ "$(grep -c "^${key}=" "$state_file" 2>/dev/null || true)" -eq 1 ] || return 1
  sed -n "s/^${key}=//p" "$state_file"
}

load_state() {
  local state_file="$1"
  [ -f "$state_file" ] && [ ! -L "$state_file" ] || return 1
  STATE_SCHEMA="$(state_value "$state_file" schemaVersion)" || return 1
  if [ "$STATE_SCHEMA" = "$SCHEMA_VERSION" ]; then
    [ "$(wc -l < "$state_file" | tr -d ' ')" -eq 14 ] || return 1
  elif [ "$STATE_SCHEMA" = "3" ]; then
    [ "$(wc -l < "$state_file" | tr -d ' ')" -eq 13 ] || return 1
  else
    return 1
  fi
  awk -F= '
    $1 !~ /^(schemaVersion|owner|format|version_b64|polo_path_b64|polo_target_b64|polo_sha256|polo_identity|compat_path_b64|compat_target_b64|compat_sha256|compat_identity|path_entry_owned|profile_path_b64)$/ { exit 1 }
  ' "$state_file" || return 1

  STATE_OWNER="$(state_value "$state_file" owner)" || return 1
  STATE_FORMAT="$(state_value "$state_file" format)" || return 1
  STATE_VERSION="$(decode_value "$(state_value "$state_file" version_b64)")" || return 1
  STATE_POLO_PATH="$(decode_value "$(state_value "$state_file" polo_path_b64)")" || return 1
  STATE_POLO_TARGET="$(decode_value "$(state_value "$state_file" polo_target_b64)")" || return 1
  STATE_POLO_SHA="$(state_value "$state_file" polo_sha256)" || return 1
  STATE_POLO_IDENTITY="$(state_value "$state_file" polo_identity)" || return 1
  STATE_COMPAT_PATH="$(decode_value "$(state_value "$state_file" compat_path_b64)")" || return 1
  STATE_COMPAT_TARGET="$(decode_value "$(state_value "$state_file" compat_target_b64)")" || return 1
  STATE_COMPAT_SHA="$(state_value "$state_file" compat_sha256)" || return 1
  STATE_COMPAT_IDENTITY="$(state_value "$state_file" compat_identity)" || return 1
  STATE_PATH_ENTRY_OWNED="$(state_value "$state_file" path_entry_owned)" || return 1
  if [ "$STATE_SCHEMA" = "$SCHEMA_VERSION" ]; then
    STATE_PROFILE_PATH="$(decode_value "$(state_value "$state_file" profile_path_b64)")" || return 1
  else
    STATE_PROFILE_PATH=""
  fi

  [ "$STATE_OWNER" = "$OWNER" ] || return 1
  [ "$STATE_FORMAT" = "$FORMAT" ] || return 1
  case "$STATE_PATH_ENTRY_OWNED" in true|false) ;; *) return 1 ;; esac
  case "$STATE_POLO_SHA$STATE_POLO_IDENTITY$STATE_COMPAT_SHA$STATE_COMPAT_IDENTITY" in
    *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#STATE_POLO_SHA}" -eq 64 ] \
    && [ "${#STATE_POLO_IDENTITY}" -eq 64 ] \
    && [ "${#STATE_COMPAT_SHA}" -eq 64 ] \
    && [ "${#STATE_COMPAT_IDENTITY}" -eq 64 ] || return 1
  [ "$STATE_POLO_IDENTITY" = "$(link_identity "$STATE_VERSION" "$STATE_POLO_PATH" "$STATE_POLO_TARGET" "$STATE_POLO_SHA")" ] || return 1
  [ "$STATE_COMPAT_IDENTITY" = "$(link_identity "$STATE_VERSION" "$STATE_COMPAT_PATH" "$STATE_COMPAT_TARGET" "$STATE_COMPAT_SHA")" ] || return 1
  if [ "$STATE_PATH_ENTRY_OWNED" = "true" ] && [ "$STATE_SCHEMA" = "$SCHEMA_VERSION" ]; then
    case "$STATE_PROFILE_PATH" in
      "$HOME/.profile"|"$HOME/.bash_profile"|"$HOME/.bash_login"|"$HOME/.zprofile"|"$HOME/.config/fish/conf.d/polo.fish") ;;
      *) return 1 ;;
    esac
  fi
}

verify_owned_link() {
  local path="$1"
  local expected_path="$2"
  local expected_target="$3"
  local expected_hash="$4"
  local actual_target

  [ "$path" = "$expected_path" ] || return 1
  [ -L "$path" ] || return 1
  actual_target="$(canonical_existing_path "$path")" || return 1
  [ "$actual_target" = "$expected_target" ] || return 1
  [ -f "$actual_target" ] || return 1
  [ "$(sha256_file "$actual_target")" = "$expected_hash" ]
}

historical_polo_content() {
  cat <<'EOF'
#!/bin/bash
# Polo CLI launcher (managed by Polo AI)

APPIMAGE_PATH="$HOME/.polo-ai/app/Polo-AI-x64.AppImage"
ELECTRON_CACHE="$HOME/.config/@polo-ai"
ELECTRON_CACHE_ALT="$HOME/.cache/@polo-ai"

# Verify AppImage exists
if [ ! -f "$APPIMAGE_PATH" ]; then
    echo "Error: Polo AI not found at $APPIMAGE_PATH"
    echo "Reinstall: curl -fsSL https://polo.ai/install-app.sh | bash"
    exit 1
fi

# Ensure DISPLAY is set (required for X11)
if [ -z "$DISPLAY" ]; then
    export DISPLAY=:0.0
fi

# Clear stale cache referencing AppImage mount paths
# AppImage creates a new /tmp/.mount_Craft-XXXX each launch, so any cached path is stale
for cache_dir in "$ELECTRON_CACHE" "$ELECTRON_CACHE_ALT"; do
    if [ -d "$cache_dir" ] && grep -rq '/tmp/\.mount_Craft' "$cache_dir" 2>/dev/null; then
        rm -rf "$cache_dir"
    fi
done

# Set APPIMAGE for auto-update
export APPIMAGE="$APPIMAGE_PATH"

# `polo app` starts the GUI. Other commands enter the packaged CLI through
# Electron's no-window bridge.
if [ "${1:-}" = "app" ]; then
    shift
    exec "$APPIMAGE_PATH" --no-sandbox "$@"
fi

exec "$APPIMAGE_PATH" --no-sandbox --polo-cli "$@"
EOF
}

historical_compat_content() {
  cat <<'EOF'
#!/bin/sh
echo "Warning: 'polo-ai' is deprecated; use 'polo' instead." >&2
exec "$HOME/.local/bin/polo" "$@"
EOF
}

historical_gui_content() {
  cat <<'EOF'
#!/bin/bash
# Polo AI launcher - handles Linux-specific AppImage issues

APPIMAGE_PATH="$HOME/.polo-ai/app/Polo-AI-x64.AppImage"
ELECTRON_CACHE="$HOME/.config/@polo-ai"
ELECTRON_CACHE_ALT="$HOME/.cache/@polo-ai"

# Verify AppImage exists
if [ ! -f "$APPIMAGE_PATH" ]; then
    echo "Error: Polo AI not found at $APPIMAGE_PATH"
    echo "Reinstall: curl -fsSL https://polo.ai/install-app.sh | bash"
    exit 1
fi

# Ensure DISPLAY is set (required for X11)
if [ -z "$DISPLAY" ]; then
    export DISPLAY=:0.0
fi

# Clear stale cache referencing AppImage mount paths
# AppImage creates a new /tmp/.mount_Craft-XXXX each launch, so any cached path is stale
for cache_dir in "$ELECTRON_CACHE" "$ELECTRON_CACHE_ALT"; do
    if [ -d "$cache_dir" ] && grep -rq '/tmp/\.mount_Craft' "$cache_dir" 2>/dev/null; then
        rm -rf "$cache_dir"
    fi
done

# Set APPIMAGE for auto-update
export APPIMAGE="$APPIMAGE_PATH"

# Launch with --no-sandbox (AppImage extracts to /tmp, losing SUID on chrome-sandbox)
exec "$APPIMAGE_PATH" --no-sandbox "$@"
EOF
}

is_exact_historical_file() {
  local path="$1"
  local kind="$2"
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  if [ "$kind" = "polo" ]; then
    cmp -s "$path" <(historical_polo_content)
  else
    cmp -s "$path" <(historical_compat_content) \
      || cmp -s "$path" <(historical_gui_content)
  fi
}

assert_replaceable() {
  local state_status="$1"
  local path="$2"
  local kind="$3"
  local previous_current="${4:-}"
  local expected_path expected_target expected_hash previous_target

  [ ! -e "$path" ] && [ ! -L "$path" ] && return 0
  if [ "$state_status" = "valid" ]; then
    if [ "$kind" = "polo" ]; then
      expected_path="$STATE_POLO_PATH"
      expected_target="$STATE_POLO_TARGET"
      expected_hash="$STATE_POLO_SHA"
    else
      expected_path="$STATE_COMPAT_PATH"
      expected_target="$STATE_COMPAT_TARGET"
      expected_hash="$STATE_COMPAT_SHA"
    fi
    if verify_owned_link "$path" "$expected_path" "$expected_target" "$expected_hash"; then
      return 0
    fi
    if [ -n "$previous_current" ] \
      && [ "$path" = "$expected_path" ] \
      && [ -L "$path" ] \
      && [ "$(readlink -- "$path")" = "$expected_target" ]; then
      case "$expected_target" in
        "$app_dir/current/"*)
          previous_target="$previous_current/${expected_target#"$app_dir/current/"}"
          [ -f "$previous_target" ] \
            && [ "$(sha256_file "$previous_target")" = "$expected_hash" ] \
            && return 0
          ;;
      esac
    fi
    printf "Polo cannot replace %s because its target or content no longer matches ownership state.\n" "$path" >&2
    return 1
  fi
  if [ "$state_status" = "missing" ] && is_exact_historical_file "$path" "$kind"; then
    return 0
  fi
  printf "Polo cannot replace %s because ownership state is missing, invalid, or the file is user-owned.\n" "$path" >&2
  return 1
}

render_state() {
  local output="$1"
  local version="$2"
  local polo_path="$3"
  local polo_target="$4"
  local compat_path="$5"
  local compat_target="$6"
  local path_entry_owned="$7"
  local profile_path="$8"
  local polo_hash compat_hash

  polo_hash="$(sha256_file "$polo_target")"
  compat_hash="$(sha256_file "$compat_target")"
  {
    printf 'schemaVersion=%s\n' "$SCHEMA_VERSION"
    printf 'owner=%s\n' "$OWNER"
    printf 'format=%s\n' "$FORMAT"
    printf 'version_b64=%s\n' "$(encode_value "$version")"
    printf 'polo_path_b64=%s\n' "$(encode_value "$polo_path")"
    printf 'polo_target_b64=%s\n' "$(encode_value "$polo_target")"
    printf 'polo_sha256=%s\n' "$polo_hash"
    printf 'polo_identity=%s\n' "$(link_identity "$version" "$polo_path" "$polo_target" "$polo_hash")"
    printf 'compat_path_b64=%s\n' "$(encode_value "$compat_path")"
    printf 'compat_target_b64=%s\n' "$(encode_value "$compat_target")"
    printf 'compat_sha256=%s\n' "$compat_hash"
    printf 'compat_identity=%s\n' "$(link_identity "$version" "$compat_path" "$compat_target" "$compat_hash")"
    printf 'path_entry_owned=%s\n' "$path_entry_owned"
    printf 'profile_path_b64=%s\n' "$(encode_value "$profile_path")"
  } > "$output"
}

write_state_no_clobber() {
  local state_file="$1"
  local version="$2"
  local polo_path="$3"
  local polo_target="$4"
  local compat_path="$5"
  local compat_target="$6"
  local path_entry_owned="$7"
  local profile_path="$8"
  local state_tmp

  state_tmp="${state_file}.$$.$RANDOM.tmp"
  umask 077
  render_state "$state_tmp" "$version" "$polo_path" "$polo_target" \
    "$compat_path" "$compat_target" "$path_entry_owned" "$profile_path"
  chmod 600 "$state_tmp"
  if ! ln "$state_tmp" "$state_file"; then
    rm -f "$state_tmp"
    return 1
  fi
  rm -f "$state_tmp"
}

restore_candidate() {
  local path="$1"
  local candidate="$2"
  local installed_target="$3"

  if [ -L "$path" ] && [ "$(readlink -- "$path")" = "$installed_target" ]; then
    rm -f "$path"
  fi
  if [ -e "$candidate" ] || [ -L "$candidate" ]; then
    if [ -e "$path" ] || [ -L "$path" ]; then
      warn "Polo preserved a concurrently created file at $path; the previous managed entry remains at $candidate."
      return 1
    fi
    mv "$candidate" "$path"
  fi
}

move_verified_candidate() {
  local path="$1"
  local candidate="$2"
  local state_status="$3"
  local kind="$4"
  local previous_current="${5:-}"

  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return 0
  fi
  mv "$path" "$candidate"
  if ! verify_moved_candidate "$candidate" "$state_status" "$kind" "$previous_current"; then
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then
      mv "$candidate" "$path"
    fi
    return 1
  fi
}

verify_moved_candidate() {
  local candidate="$1"
  local state_status="$2"
  local kind="$3"
  local previous_current="${4:-}"
  local expected_target expected_hash hash_target

  if [ "$state_status" = "valid" ]; then
    if [ "$kind" = "polo" ]; then
      expected_target="$STATE_POLO_TARGET"
      expected_hash="$STATE_POLO_SHA"
    else
      expected_target="$STATE_COMPAT_TARGET"
      expected_hash="$STATE_COMPAT_SHA"
    fi
    [ -L "$candidate" ] && [ "$(readlink -- "$candidate")" = "$expected_target" ] || return 1
    hash_target="$expected_target"
    if [ -n "$previous_current" ]; then
      case "$expected_target" in
        "$app_dir/current/"*)
          hash_target="$previous_current/${expected_target#"$app_dir/current/"}"
          ;;
      esac
    fi
    [ -f "$hash_target" ] && [ "$(sha256_file "$hash_target")" = "$expected_hash" ]
    return
  fi
  [ "$state_status" = "missing" ] && is_exact_historical_file "$candidate" "$kind"
}

install_links_transaction() {
  local previous_current="$1"
  local transaction_dir state_candidate polo_candidate compat_candidate state_hash="" new_state_hash=""

  transaction_dir="$(mktemp -d "$state_root/.terminal-install.XXXXXX")"
  chmod 700 "$transaction_dir"
  polo_candidate="$transaction_dir/polo.previous"
  compat_candidate="$transaction_dir/polo-ai.previous"
  state_candidate="$transaction_dir/state.previous"
  if [ "$state_status" = "valid" ]; then
    state_hash="$(sha256_file "$state_file")"
  fi

  if ! move_verified_candidate "$polo_path" "$polo_candidate" "$state_status" polo "$previous_current"; then
    rm -rf "$transaction_dir"
    return 1
  fi
  if ! ln -s "$polo_target" "$polo_path"; then
    restore_candidate "$polo_path" "$polo_candidate" "$polo_target" || true
    rm -rf "$transaction_dir"
    return 1
  fi

  if ! move_verified_candidate "$compat_path" "$compat_candidate" "$state_status" compat "$previous_current"; then
    restore_candidate "$polo_path" "$polo_candidate" "$polo_target" || true
    rm -rf "$transaction_dir"
    return 1
  fi
  if ! ln -s "$compat_target" "$compat_path"; then
    restore_candidate "$compat_path" "$compat_candidate" "$compat_target" || true
    restore_candidate "$polo_path" "$polo_candidate" "$polo_target" || true
    rm -rf "$transaction_dir"
    return 1
  fi

  if [ -e "$state_file" ] || [ -L "$state_file" ]; then
    mv "$state_file" "$state_candidate"
    if [ "$state_status" != "valid" ] \
      || [ ! -f "$state_candidate" ] \
      || [ -L "$state_candidate" ] \
      || [ "$(sha256_file "$state_candidate")" != "$state_hash" ]; then
      [ ! -e "$state_file" ] && [ ! -L "$state_file" ] && mv "$state_candidate" "$state_file"
      restore_candidate "$compat_path" "$compat_candidate" "$compat_target" || true
      restore_candidate "$polo_path" "$polo_candidate" "$polo_target" || true
      rm -rf "$transaction_dir"
      return 1
    fi
  elif [ "$state_status" != "missing" ]; then
    restore_candidate "$compat_path" "$compat_candidate" "$compat_target" || true
    restore_candidate "$polo_path" "$polo_candidate" "$polo_target" || true
    rm -rf "$transaction_dir"
    return 1
  fi

  if ! write_state_no_clobber "$state_file" "$version" "$polo_path" "$polo_target" \
    "$compat_path" "$compat_target" "$path_entry_owned" "$profile_path"; then
    [ ! -e "$state_file" ] && [ ! -L "$state_file" ] \
      && [ -e "$state_candidate" ] && mv "$state_candidate" "$state_file"
    restore_candidate "$compat_path" "$compat_candidate" "$compat_target" || true
    restore_candidate "$polo_path" "$polo_candidate" "$polo_target" || true
    rm -rf "$transaction_dir"
    return 1
  fi
  new_state_hash="$(sha256_file "$state_file")"

  if ! load_state "$state_file" \
    || ! verify_owned_link "$polo_path" "$STATE_POLO_PATH" "$STATE_POLO_TARGET" "$STATE_POLO_SHA" \
    || ! verify_owned_link "$compat_path" "$STATE_COMPAT_PATH" "$STATE_COMPAT_TARGET" "$STATE_COMPAT_SHA"; then
    if [ -f "$state_file" ] && [ ! -L "$state_file" ] \
      && [ "$(sha256_file "$state_file")" = "$new_state_hash" ]; then
      rm -f "$state_file"
    fi
    [ ! -e "$state_file" ] && [ ! -L "$state_file" ] \
      && [ -e "$state_candidate" ] && mv "$state_candidate" "$state_file"
    restore_candidate "$compat_path" "$compat_candidate" "$compat_target" || true
    restore_candidate "$polo_path" "$polo_candidate" "$polo_target" || true
    rm -rf "$transaction_dir"
    return 1
  fi

  rm -rf "$transaction_dir"
}

uninstall_links_transaction() {
  local transaction_dir polo_candidate compat_candidate state_candidate state_hash=""

  transaction_dir="$(mktemp -d "$state_root/.terminal-uninstall.XXXXXX")"
  chmod 700 "$transaction_dir"
  polo_candidate="$transaction_dir/polo.owned"
  compat_candidate="$transaction_dir/polo-ai.owned"
  state_candidate="$transaction_dir/state.owned"
  if [ "$state_status" = "valid" ]; then
    state_hash="$(sha256_file "$state_file")"
  fi

  if ! move_verified_candidate "$polo_path" "$polo_candidate" "$state_status" polo; then
    rm -rf "$transaction_dir"
    return 1
  fi
  if ! move_verified_candidate "$compat_path" "$compat_candidate" "$state_status" compat; then
    [ ! -e "$polo_path" ] && [ ! -L "$polo_path" ] && [ -e "$polo_candidate" ] \
      && mv "$polo_candidate" "$polo_path"
    rm -rf "$transaction_dir"
    return 1
  fi

  if [ "$state_status" = "valid" ]; then
    if [ ! -e "$state_file" ] || [ -L "$state_file" ]; then
      [ ! -e "$compat_path" ] && [ ! -L "$compat_path" ] && mv "$compat_candidate" "$compat_path"
      [ ! -e "$polo_path" ] && [ ! -L "$polo_path" ] && mv "$polo_candidate" "$polo_path"
      rm -rf "$transaction_dir"
      return 1
    fi
    mv "$state_file" "$state_candidate"
    if [ ! -f "$state_candidate" ] \
      || [ -L "$state_candidate" ] \
      || [ "$(sha256_file "$state_candidate")" != "$state_hash" ]; then
      [ ! -e "$state_file" ] && [ ! -L "$state_file" ] && mv "$state_candidate" "$state_file"
      [ ! -e "$compat_path" ] && [ ! -L "$compat_path" ] && mv "$compat_candidate" "$compat_path"
      [ ! -e "$polo_path" ] && [ ! -L "$polo_path" ] && mv "$polo_candidate" "$polo_path"
      rm -rf "$transaction_dir"
      return 1
    fi
  elif [ -e "$state_file" ] || [ -L "$state_file" ]; then
    [ ! -e "$compat_path" ] && [ ! -L "$compat_path" ] && mv "$compat_candidate" "$compat_path"
    [ ! -e "$polo_path" ] && [ ! -L "$polo_path" ] && mv "$polo_candidate" "$polo_path"
    rm -rf "$transaction_dir"
    return 1
  fi

  rm -rf "$transaction_dir"
}

mode="${1:-}"
shift || true

app_dir=""
bin_dir=""
version=""
staged_polo=""
staged_compat=""
path_entry_owned="false"
previous_current=""
profile_path=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-dir) app_dir="$2"; shift 2 ;;
    --bin-dir) bin_dir="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --staged-polo) staged_polo="$2"; shift 2 ;;
    --staged-compat) staged_compat="$2"; shift 2 ;;
    --path-entry-owned) path_entry_owned="$2"; shift 2 ;;
    --previous-current) previous_current="$2"; shift 2 ;;
    --profile-path) profile_path="$2"; shift 2 ;;
    *) printf "Unknown argument: %s\n" "$1" >&2; exit 64 ;;
  esac
done

[ -n "$app_dir" ] && [ -n "$bin_dir" ] || {
  printf "Both --app-dir and --bin-dir are required.\n" >&2
  exit 64
}

app_dir="$(canonical_existing_path "$app_dir")"
bin_dir="$(canonical_existing_path "$bin_dir")"
state_root="$(canonical_existing_path "$app_dir/..")"
state_file="$state_root/$STATE_NAME"
polo_path="$bin_dir/polo"
compat_path="$bin_dir/polo-ai"
polo_target="$app_dir/current/resources/app/resources/bin/polo"
compat_target="$app_dir/current/resources/app/resources/bin/polo-ai"

state_status="missing"
if [ -e "$state_file" ] || [ -L "$state_file" ]; then
  if load_state "$state_file"; then
    state_status="valid"
  else
    state_status="invalid"
  fi
fi

assert_uninstallable() {
  local pair local_path local_kind
  if [ "$state_status" = "valid" ]; then
    verify_owned_link "$polo_path" "$STATE_POLO_PATH" "$STATE_POLO_TARGET" "$STATE_POLO_SHA" \
      && verify_owned_link "$compat_path" "$STATE_COMPAT_PATH" "$STATE_COMPAT_TARGET" "$STATE_COMPAT_SHA"
    return
  fi
  if [ "$state_status" = "missing" ]; then
    for pair in "$polo_path:polo" "$compat_path:compat"; do
      local_path="${pair%:*}"
      local_kind="${pair##*:}"
      if [ ! -e "$local_path" ] && [ ! -L "$local_path" ]; then
        continue
      fi
      is_exact_historical_file "$local_path" "$local_kind" || return 1
    done
    return 0
  fi
  return 1
}

case "$mode" in
  preflight)
    [ -n "$version" ] && [ -f "$staged_polo" ] && [ -f "$staged_compat" ] || {
      printf "Preflight requires version and staged canonical wrappers.\n" >&2
      exit 64
    }
    assert_replaceable "$state_status" "$polo_path" polo
    assert_replaceable "$state_status" "$compat_path" compat
    ;;
  install)
    [ -n "$version" ] && [ -f "$polo_target" ] && [ -f "$compat_target" ] || {
      printf "Installed canonical wrappers are missing.\n" >&2
      exit 65
    }
    case "$path_entry_owned" in true|false) ;; *) exit 64 ;; esac
    if [ "$path_entry_owned" = "true" ]; then
      [ -n "$profile_path" ] || {
        printf "Install requires --profile-path when Polo owns the PATH entry.\n" >&2
        exit 64
      }
      case "$profile_path" in
        "$HOME/.profile"|"$HOME/.bash_profile"|"$HOME/.bash_login"|"$HOME/.zprofile"|"$HOME/.config/fish/conf.d/polo.fish") ;;
        *) printf "Install profile path is outside the supported shell profiles.\n" >&2; exit 64 ;;
      esac
    fi
    mkdir -p "$bin_dir" "$(dirname "$state_file")"
    chmod 700 "$(dirname "$state_file")"
    if [ -n "$previous_current" ]; then
      previous_current="$(canonical_existing_path "$previous_current")"
    fi
    assert_replaceable "$state_status" "$polo_path" polo "$previous_current"
    assert_replaceable "$state_status" "$compat_path" compat "$previous_current"
    install_links_transaction "$previous_current"
    ;;
  verify-uninstall)
    if ! assert_uninstallable; then
      warn "Polo left terminal files, PATH configuration, and application unchanged because ownership could not be verified."
      exit 2
    fi
    ;;
  path-entry-owned)
    assert_uninstallable || exit 2
    if [ "$state_status" = "valid" ]; then
      printf '%s\n' "$STATE_PATH_ENTRY_OWNED"
    else
      printf 'false\n'
    fi
    ;;
  profile-path)
    assert_uninstallable || exit 2
    if [ "$state_status" = "valid" ] \
      && [ "$STATE_SCHEMA" = "$SCHEMA_VERSION" ] \
      && [ "$STATE_PATH_ENTRY_OWNED" = "true" ]; then
      printf '%s\n' "$STATE_PROFILE_PATH"
    fi
    ;;
  uninstall)
    conflict="false"
    if assert_uninstallable; then
      uninstall_links_transaction || conflict="true"
    else
      conflict="true"
    fi
    if [ "$conflict" = "true" ]; then
      warn "Polo left terminal files and ownership state unchanged because ownership could not be verified."
      exit 2
    fi
    ;;
  *)
    printf "Usage: %s <preflight|install|verify-uninstall|path-entry-owned|profile-path|uninstall> --app-dir PATH --bin-dir PATH\n" "$0" >&2
    exit 64
    ;;
esac
