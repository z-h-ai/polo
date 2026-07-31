#!/bin/bash

set -e

PATH_BLOCK_START="# >>> Polo CLI >>>"
PATH_BLOCK_END="# <<< Polo CLI <<<"

info() { printf "> %s\n" "$1"; }
warn() { printf "! %s\n" "$1" >&2; }

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

terminal_cleanup_ok=true
if [ "$(uname -s)" = "Linux" ]; then
    linux_helper="$HOME/.polo-ai/app/current/resources/app/resources/scripts/linux-terminal-integration.sh"
    if [ -f "$linux_helper" ] && [ ! -L "$linux_helper" ]; then
        if bash "$linux_helper" uninstall \
            --app-dir "$HOME/.polo-ai/app" \
            --bin-dir "$HOME/.local/bin"; then
            info "Removed verified Polo terminal launchers."
        else
            terminal_cleanup_ok=false
        fi
    elif [ -e "$HOME/.local/bin/polo" ] \
        || [ -L "$HOME/.local/bin/polo" ] \
        || [ -e "$HOME/.local/bin/polo-ai" ] \
        || [ -L "$HOME/.local/bin/polo-ai" ]; then
        terminal_cleanup_ok=false
        warn "Polo terminal launchers were left unchanged because ownership state and its verifier are unavailable."
    fi
fi

remove_managed_path_block "$HOME/.profile"
remove_managed_path_block "$HOME/.bash_profile"
remove_managed_path_block "$HOME/.bash_login"
remove_managed_path_block "$HOME/.zprofile"
remove_managed_path_block "$HOME/.config/fish/conf.d/polo.fish"

if [ "$(uname -s)" = "Linux" ]; then
    if [ "$terminal_cleanup_ok" = true ]; then
        app_dir="$HOME/.polo-ai/app"
        if [ -d "$app_dir" ]; then
            rm -rf "$app_dir"
            info "Removed $app_dir"
        fi
    else
        warn "Polo application files were preserved because a terminal launcher may still reference them."
    fi
fi

info "Polo-managed terminal integration was removed."
