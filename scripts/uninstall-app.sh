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
        return 1
    fi
    if ! awk -v start="$PATH_BLOCK_START" -v end="$PATH_BLOCK_END" '
        $0 == start { start_line = NR }
        $0 == end { end_line = NR }
        END { exit !(start_line && end_line && start_line < end_line) }
    ' "$profile_path"; then
        warn "Left malformed Polo PATH block unchanged: $profile_path"
        return 1
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

validate_managed_path_block() {
    local profile_path="$1"
    local start_count end_count expected_line
    [ -e "$profile_path" ] || return 0
    [ -f "$profile_path" ] && [ ! -L "$profile_path" ] || return 1
    start_count=$(grep -Fxc "$PATH_BLOCK_START" "$profile_path" 2>/dev/null || true)
    end_count=$(grep -Fxc "$PATH_BLOCK_END" "$profile_path" 2>/dev/null || true)
    [ "$start_count" -eq 0 ] && [ "$end_count" -eq 0 ] && return 0
    [ "$start_count" -eq 1 ] && [ "$end_count" -eq 1 ] || return 1
    case "$profile_path" in
        */.config/fish/conf.d/polo.fish) expected_line='fish_add_path -g "$HOME/.local/bin"' ;;
        *) expected_line='export PATH="$HOME/.local/bin:$PATH"' ;;
    esac
    awk -v start="$PATH_BLOCK_START" -v end="$PATH_BLOCK_END" -v expected="$expected_line" '
        $0 == start { start_line = NR; next }
        $0 == end { end_line = NR; next }
        start_line && !end_line {
            managed_lines++
            if ($0 != expected) invalid = 1
        }
        END { exit !(start_line && end_line && start_line < end_line && managed_lines == 1 && !invalid) }
    ' "$profile_path"
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
        profile_paths=()
        if ! bash "$linux_helper" verify-uninstall \
            --app-dir "$HOME/.polo-ai/app" \
            --bin-dir "$HOME/.local/bin"; then
            terminal_cleanup_ok=false
        else
            path_entry_owned=$(bash "$linux_helper" path-entry-owned \
                --app-dir "$HOME/.polo-ai/app" \
                --bin-dir "$HOME/.local/bin") || terminal_cleanup_ok=false
            if [ "$terminal_cleanup_ok" = true ] && [ "$path_entry_owned" = true ]; then
                owned_profile_path=$(bash "$linux_helper" profile-path \
                    --app-dir "$HOME/.polo-ai/app" \
                    --bin-dir "$HOME/.local/bin") || terminal_cleanup_ok=false
                if [ "$terminal_cleanup_ok" = true ] && [ -n "$owned_profile_path" ]; then
                    profile_paths=("$owned_profile_path")
                else
                    terminal_cleanup_ok=false
                    warn "Polo terminal integration was preserved because its PATH profile is not bound to ownership state."
                fi
            fi
            if [ "$terminal_cleanup_ok" = true ] && [ "$path_entry_owned" = true ]; then
                for profile_path in "${profile_paths[@]}"; do
                    if ! validate_managed_path_block "$profile_path"; then
                        terminal_cleanup_ok=false
                        warn "Polo terminal integration was preserved because PATH ownership is malformed or ambiguous: $profile_path"
                        break
                    fi
                done
            fi
            if [ "$terminal_cleanup_ok" = true ]; then
                profile_backup_dir=$(mktemp -d "$HOME/.polo-ai/.terminal-uninstall.XXXXXX")
                profile_index=0
                for profile_path in "${profile_paths[@]}"; do
                    if [ -e "$profile_path" ]; then
                        cp -p "$profile_path" "$profile_backup_dir/$profile_index"
                    fi
                    profile_index=$((profile_index + 1))
                done
                if [ "$path_entry_owned" = true ]; then
                    for profile_path in "${profile_paths[@]}"; do
                        remove_managed_path_block "$profile_path" || terminal_cleanup_ok=false
                    done
                fi
                if [ "$terminal_cleanup_ok" = true ] && bash "$linux_helper" uninstall \
                    --app-dir "$HOME/.polo-ai/app" \
                    --bin-dir "$HOME/.local/bin"; then
                    info "Removed verified Polo terminal launchers and PATH configuration."
                else
                    terminal_cleanup_ok=false
                    profile_index=0
                    for profile_path in "${profile_paths[@]}"; do
                        if [ -f "$profile_backup_dir/$profile_index" ]; then
                            mkdir -p "$(dirname "$profile_path")"
                            cp -p "$profile_backup_dir/$profile_index" "$profile_path"
                        fi
                        profile_index=$((profile_index + 1))
                    done
                    warn "Polo restored PATH configuration because launcher ownership changed during uninstall."
                fi
                rm -rf "$profile_backup_dir"
            fi
        fi
    elif [ -e "$HOME/.local/bin/polo" ] \
        || [ -L "$HOME/.local/bin/polo" ] \
        || [ -e "$HOME/.local/bin/polo-ai" ] \
        || [ -L "$HOME/.local/bin/polo-ai" ]; then
        terminal_cleanup_ok=false
        warn "Polo terminal launchers were left unchanged because ownership state and its verifier are unavailable."
    fi
fi

if [ "$(uname -s)" = "Darwin" ]; then
    remove_managed_path_block "$HOME/.profile"
    remove_managed_path_block "$HOME/.bash_profile"
    remove_managed_path_block "$HOME/.bash_login"
    remove_managed_path_block "$HOME/.zprofile"
    remove_managed_path_block "$HOME/.config/fish/conf.d/polo.fish"
fi

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
[ "$terminal_cleanup_ok" = true ] || exit 2
