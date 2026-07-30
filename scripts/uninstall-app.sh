#!/bin/bash

set -e

PATH_BLOCK_START="# >>> Polo CLI >>>"
PATH_BLOCK_END="# <<< Polo CLI <<<"
LAUNCHER_MARKER="# Polo CLI launcher (managed by Polo AI)"

info() { printf "> %s\n" "$1"; }
warn() { printf "! %s\n" "$1" >&2; }

remove_managed_file() {
    local path="$1"
    shift
    [ -e "$path" ] || return 0

    local marker
    for marker in "$@"; do
        if grep -Fq "$marker" "$path" 2>/dev/null; then
            rm -f "$path"
            info "Removed $path"
            return 0
        fi
    done
    warn "Left non-Polo file unchanged: $path"
}

remove_managed_path_block() {
    local profile_path="$1"
    [ -e "$profile_path" ] || return 0

    local start_count
    local end_count
    local profile_tmp
    local profile_mode=""

    start_count=$(grep -Fxc "$PATH_BLOCK_START" "$profile_path" 2>/dev/null || true)
    end_count=$(grep -Fxc "$PATH_BLOCK_END" "$profile_path" 2>/dev/null || true)
    if [ "$start_count" -eq 0 ] && [ "$end_count" -eq 0 ]; then
        return 0
    fi
    if [ "$start_count" -ne 1 ] || [ "$end_count" -ne 1 ]; then
        warn "Left malformed Polo PATH block unchanged: $profile_path"
        return 0
    fi
    if ! awk -v start="$PATH_BLOCK_START" -v end="$PATH_BLOCK_END" '
        $0 == start { start_line = NR }
        $0 == end { end_line = NR }
        END { exit !(start_line && end_line && start_line < end_line) }
    ' "$profile_path"; then
        warn "Left malformed Polo PATH block unchanged: $profile_path"
        return 0
    fi

    profile_tmp="$(dirname "$profile_path")/.polo-uninstall.$$"
    profile_mode=$(stat -c '%a' "$profile_path" 2>/dev/null || stat -f '%Lp' "$profile_path" 2>/dev/null || true)
    awk -v start="$PATH_BLOCK_START" -v end="$PATH_BLOCK_END" '
        $0 == start { managed = 1; next }
        $0 == end { managed = 0; next }
        !managed { print }
    ' "$profile_path" > "$profile_tmp"

    cp "$profile_path" "$profile_path.polo-backup-$(date +%s)"
    mv -f "$profile_tmp" "$profile_path"
    [ -n "$profile_mode" ] && chmod "$profile_mode" "$profile_path"
    info "Removed Polo PATH configuration from $profile_path"
}

case "$(uname -s)" in
    Darwin|Linux) ;;
    *)
        printf "Unsupported operating system: %s\n" "$(uname -s)" >&2
        exit 1
        ;;
esac

remove_managed_file "$HOME/.local/bin/polo" "$LAUNCHER_MARKER"
remove_managed_file \
    "$HOME/.local/bin/polo-ai" \
    "deprecated; use 'polo'" \
    "# Polo AI launcher"

remove_managed_path_block "$HOME/.profile"
remove_managed_path_block "$HOME/.bash_profile"
remove_managed_path_block "$HOME/.bash_login"
remove_managed_path_block "$HOME/.zprofile"
remove_managed_path_block "$HOME/.config/fish/conf.d/polo.fish"

if [ "$(uname -s)" = "Linux" ]; then
    appimage="$HOME/.polo-ai/app/Polo-AI-x64.AppImage"
    if [ -f "$appimage" ]; then
        rm -f "$appimage"
        info "Removed $appimage"
    fi
fi

info "Polo-managed terminal integration was removed."
