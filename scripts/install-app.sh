#!/bin/bash

set -e

VERSIONS_URL="https://polo.ai/electron"
DOWNLOAD_DIR="$HOME/.polo-ai/downloads"
LOCAL_ARTIFACT="${POLO_AI_INSTALL_ARTIFACT:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info() { printf "%b\n" "${BLUE}>${NC} $1"; }
success() { printf "%b\n" "${GREEN}>${NC} $1"; }
warn() { printf "%b\n" "${YELLOW}!${NC} $1"; }
error() { printf "%b\n" "${RED}x${NC} $1"; exit 1; }

PATH_BLOCK_START="# >>> Polo CLI >>>"
PATH_BLOCK_END="# <<< Polo CLI <<<"

managed_profile_path() {
    local shell_name
    local profile_path

    shell_name="${SHELL##*/}"
    case "$shell_name" in
        fish)
            profile_path="$HOME/.config/fish/conf.d/polo.fish"
            ;;
        zsh)
            profile_path="$HOME/.zprofile"
            ;;
        bash)
            # Bash login shells read only the first existing file in this
            # order. Updating .profile while .bash_profile/.bash_login exists
            # would leave a fresh Terminal unable to find `polo`.
            if [ -e "$HOME/.bash_profile" ]; then
                profile_path="$HOME/.bash_profile"
            elif [ -e "$HOME/.bash_login" ]; then
                profile_path="$HOME/.bash_login"
            else
                profile_path="$HOME/.profile"
            fi
            ;;
        *)
            profile_path="$HOME/.profile"
            ;;
    esac
    printf '%s\n' "$profile_path"
}

managed_path_line() {
    case "$1" in
        */.config/fish/conf.d/polo.fish) printf '%s\n' 'fish_add_path -g "$HOME/.local/bin"' ;;
        *) printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"' ;;
    esac
}

validate_managed_path() {
    local profile_path="$1"
    local path_line
    local start_count
    local end_count

    [ -e "$profile_path" ] || return 0
    [ -f "$profile_path" ] && [ ! -L "$profile_path" ] || {
        warn "Polo PATH profile is not a regular owned file: $profile_path"
        return 1
    }
    path_line="$(managed_path_line "$profile_path")"
    start_count=$(grep -Fxc "$PATH_BLOCK_START" "$profile_path" 2>/dev/null || true)
    end_count=$(grep -Fxc "$PATH_BLOCK_END" "$profile_path" 2>/dev/null || true)
    if [ "$start_count" -ne "$end_count" ] || [ "$start_count" -gt 1 ]; then
        warn "Malformed Polo PATH block in $profile_path. It was not changed."
        return 1
    fi
    if [ "$start_count" -eq 1 ] && ! awk \
        -v start="$PATH_BLOCK_START" -v end="$PATH_BLOCK_END" -v path_line="$path_line" '
        $0 == start { start_line = NR; next }
        $0 == end { end_line = NR; next }
        start_line && !end_line {
            managed_lines++
            if ($0 != path_line) invalid = 1
        }
        END { exit !(start_line && end_line && start_line < end_line && managed_lines == 1 && !invalid) }
    ' "$profile_path"; then
        warn "Malformed Polo PATH block in $profile_path. It was not changed."
        return 1
    fi
}

profile_sha256() {
    sha256sum "$1" | awk '{print $1}'
}

profile_filesystem_identity() {
    stat -c '%d:%i' -- "$1" 2>/dev/null \
        || stat -f '%d:%i' "$1" 2>/dev/null
}

restore_profile_candidate_no_replace() {
    local candidate="$1"
    local profile_path="$2"
    local target

    [ -e "$candidate" ] || [ -L "$candidate" ] || return 0
    if [ -e "$profile_path" ] || [ -L "$profile_path" ]; then
        return 1
    fi
    if [ -L "$candidate" ]; then
        target="$(readlink -- "$candidate")" || return 1
        ln -s -- "$target" "$profile_path" || return 1
    elif [ -f "$candidate" ]; then
        ln -- "$candidate" "$profile_path" || return 1
    else
        return 1
    fi
    rm -f -- "$candidate"
}

mark_profile_transaction_conflict() {
    local reason="$1"
    local journal="$profile_transaction_dir/ROLLBACK_REQUIRED"

    PROFILE_ROLLBACK_CONFLICT=true
    {
        printf 'owner=com.poloai.terminal-integration\n'
        printf 'reason=%s\n' "$reason"
        printf 'profile_path_b64=%s\n' "$(printf '%s' "$MANAGED_PROFILE_PATH" | base64 | tr -d '\n')"
        printf 'created_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    } > "$journal"
    chmod 600 "$journal"
    warn "Polo preserved a concurrently changed shell profile at $MANAGED_PROFILE_PATH."
    warn "The verified previous profile and rollback journal are available at $profile_transaction_dir"
}

begin_managed_profile_transaction() {
    local transaction_root="$1"

    [ -n "${MANAGED_PROFILE_PATH:-}" ] || MANAGED_PROFILE_PATH="$(managed_profile_path)"
    validate_managed_path "$MANAGED_PROFILE_PATH" || return 1
    mkdir -p "$transaction_root"
    profile_transaction_dir="$(mktemp -d "$transaction_root/.profile-transaction.XXXXXX")"
    chmod 700 "$profile_transaction_dir"
    profile_backup="$profile_transaction_dir/profile.previous"
    profile_existed=false
    PROFILE_BEFORE_HASH=""
    PROFILE_BEFORE_IDENTITY=""
    PROFILE_AFTER_HASH=""
    PROFILE_AFTER_IDENTITY=""
    PROFILE_CONFIG_CHANGED=false
    PROFILE_ROLLBACK_CONFLICT=false

    if [ -e "$MANAGED_PROFILE_PATH" ]; then
        PROFILE_BEFORE_HASH="$(profile_sha256 "$MANAGED_PROFILE_PATH")"
        if ! PROFILE_BEFORE_IDENTITY="$(profile_filesystem_identity "$MANAGED_PROFILE_PATH")"; then
            mark_profile_transaction_conflict "profile-backup-identity-failed"
            return 1
        fi
        if ! cp -p "$MANAGED_PROFILE_PATH" "$profile_backup"; then
            mark_profile_transaction_conflict "profile-backup-copy-failed"
            return 1
        fi
        profile_existed=true
        if [ "$(profile_sha256 "$profile_backup")" != "$PROFILE_BEFORE_HASH" ] \
            || [ ! -f "$MANAGED_PROFILE_PATH" ] \
            || [ -L "$MANAGED_PROFILE_PATH" ] \
            || [ "$(profile_filesystem_identity "$MANAGED_PROFILE_PATH")" != "$PROFILE_BEFORE_IDENTITY" ] \
            || [ "$(profile_sha256 "$MANAGED_PROFILE_PATH")" != "$PROFILE_BEFORE_HASH" ]; then
            mark_profile_transaction_conflict "profile-backup-snapshot-changed"
            return 1
        fi
    fi
}

configure_managed_path() {
    local profile_path="${MANAGED_PROFILE_PATH:-}"
    local path_line
    local profile_tmp
    local profile_mode=""
    local profile_claim="$profile_transaction_dir/profile.claimed"
    local generated_hash
    local generated_identity
    local durable_backup

    [ -n "$profile_path" ] || profile_path="$(managed_profile_path)"
    path_line="$(managed_path_line "$profile_path")"
    mkdir -p "$(dirname "$profile_path")"
    profile_tmp="$(dirname "$profile_path")/.polo-profile-generated.$$"
    if [ "$profile_existed" = true ]; then
        cp -p "$profile_backup" "$profile_tmp" || return 1
        profile_mode=$(stat -c '%a' "$profile_backup" 2>/dev/null \
            || stat -f '%Lp' "$profile_backup" 2>/dev/null || true)
    else
        : > "$profile_tmp"
        chmod 600 "$profile_tmp"
    fi
    if ! awk -v start="$PATH_BLOCK_START" -v end="$PATH_BLOCK_END" '
        $0 == start { managed = 1; next }
        $0 == end { managed = 0; next }
        !managed { print }
    ' "$profile_tmp" > "$profile_tmp.rendered"; then
        rm -f "$profile_tmp" "$profile_tmp.rendered"
        return 1
    fi
    if ! cp "$profile_tmp.rendered" "$profile_tmp"; then
        rm -f "$profile_tmp" "$profile_tmp.rendered"
        return 1
    fi
    rm -f "$profile_tmp.rendered"
    {
        printf "%s\n" "$PATH_BLOCK_START"
        printf "%s\n" "$path_line"
        printf "%s\n" "$PATH_BLOCK_END"
    } >> "$profile_tmp"
    if [ -n "$profile_mode" ] && ! chmod "$profile_mode" "$profile_tmp"; then
        rm -f "$profile_tmp"
        return 1
    fi

    # An already-canonical profile requires no write. Revalidate the complete
    # snapshot so a concurrent update still aborts before launcher/App commit.
    if [ "$profile_existed" = true ] && cmp -s "$profile_backup" "$profile_tmp"; then
        rm -f "$profile_tmp"
        if [ ! -f "$profile_path" ] \
            || [ -L "$profile_path" ] \
            || [ "$(profile_filesystem_identity "$profile_path")" != "$PROFILE_BEFORE_IDENTITY" ] \
            || [ "$(profile_sha256 "$profile_path")" != "$PROFILE_BEFORE_HASH" ]; then
            mark_profile_transaction_conflict "profile-noop-snapshot-changed"
            return 1
        fi
        PROFILE_AFTER_IDENTITY="$PROFILE_BEFORE_IDENTITY"
        PROFILE_AFTER_HASH="$PROFILE_BEFORE_HASH"
        return 0
    fi

    # Claim the verified original inode before publishing. Checking the claim
    # after rename catches replacement, symlink, rename and in-place updates
    # injected between the snapshot and atomic claim.
    if [ "$profile_existed" = true ]; then
        if ! mv "$profile_path" "$profile_claim"; then
            rm -f "$profile_tmp"
            mark_profile_transaction_conflict "profile-config-claim-failed"
            return 1
        fi
        if [ ! -f "$profile_claim" ] \
            || [ -L "$profile_claim" ] \
            || [ "$(profile_filesystem_identity "$profile_claim")" != "$PROFILE_BEFORE_IDENTITY" ] \
            || [ "$(profile_sha256 "$profile_claim")" != "$PROFILE_BEFORE_HASH" ]; then
            restore_profile_candidate_no_replace "$profile_claim" "$profile_path" || true
            rm -f "$profile_tmp"
            mark_profile_transaction_conflict "profile-config-claim-identity-mismatch"
            return 1
        fi
    elif [ -e "$profile_path" ] || [ -L "$profile_path" ]; then
        rm -f "$profile_tmp"
        mark_profile_transaction_conflict "profile-config-created-concurrently"
        return 1
    fi

    generated_hash="$(profile_sha256 "$profile_tmp")"
    generated_identity="$(profile_filesystem_identity "$profile_tmp")" || {
        restore_profile_candidate_no_replace "$profile_claim" "$profile_path" || true
        rm -f "$profile_tmp"
        mark_profile_transaction_conflict "profile-config-generated-identity-failed"
        return 1
    }
    if ! ln -- "$profile_tmp" "$profile_path"; then
        restore_profile_candidate_no_replace "$profile_claim" "$profile_path" || true
        rm -f "$profile_tmp"
        mark_profile_transaction_conflict "profile-config-path-occupied"
        return 1
    fi
    PROFILE_CONFIG_CHANGED=true
    PROFILE_AFTER_HASH="$generated_hash"
    PROFILE_AFTER_IDENTITY="$generated_identity"
    rm -f "$profile_tmp"
    if [ ! -f "$profile_path" ] \
        || [ -L "$profile_path" ] \
        || [ "$(profile_filesystem_identity "$profile_path")" != "$PROFILE_AFTER_IDENTITY" ] \
        || [ "$(profile_sha256 "$profile_path")" != "$PROFILE_AFTER_HASH" ]; then
        mark_profile_transaction_conflict "profile-config-result-changed"
        return 1
    fi

    rm -f "$profile_claim"
    if [ "$profile_existed" = true ]; then
        durable_backup="$profile_path.polo-backup-$(date +%s).$$.$RANDOM"
        if ! ln -- "$profile_backup" "$durable_backup"; then
            return 1
        fi
    fi
    info "Configured terminal command in $profile_path"
}

restore_managed_profile() {
    local profile_path="$1"
    local profile_backup="$2"
    local profile_existed="$3"
    local generated_claim="$profile_transaction_dir/profile.generated"

    if [ "$PROFILE_ROLLBACK_CONFLICT" = true ]; then
        return 1
    fi
    if [ "$PROFILE_CONFIG_CHANGED" != true ]; then
        if [ "$profile_existed" = true ]; then
            if [ ! -f "$profile_path" ] \
                || [ -L "$profile_path" ] \
                || [ "$(profile_filesystem_identity "$profile_path")" != "$PROFILE_AFTER_IDENTITY" ] \
                || [ "$(profile_sha256 "$profile_path")" != "$PROFILE_AFTER_HASH" ]; then
                mark_profile_transaction_conflict "profile-rollback-noop-changed"
                return 1
            fi
        elif [ -e "$profile_path" ] || [ -L "$profile_path" ]; then
            mark_profile_transaction_conflict "profile-rollback-noop-created"
            return 1
        fi
        rm -rf "$profile_transaction_dir"
        return 0
    fi

    # Claim exactly the profile generated by this transaction. The checks are
    # deliberately after rename, so an update in the final validation window
    # is preserved rather than overwritten by the previous snapshot.
    if ! mv "$profile_path" "$generated_claim"; then
        mark_profile_transaction_conflict "profile-rollback-claim-failed"
        return 1
    fi
    if [ ! -f "$generated_claim" ] \
        || [ -L "$generated_claim" ] \
        || [ "$(profile_filesystem_identity "$generated_claim")" != "$PROFILE_AFTER_IDENTITY" ] \
        || [ "$(profile_sha256 "$generated_claim")" != "$PROFILE_AFTER_HASH" ]; then
        restore_profile_candidate_no_replace "$generated_claim" "$profile_path" || true
        mark_profile_transaction_conflict "profile-rollback-claim-identity-mismatch"
        return 1
    fi

    if [ "$profile_existed" = true ]; then
        if ! ln -- "$profile_backup" "$profile_path"; then
            restore_profile_candidate_no_replace "$generated_claim" "$profile_path" || true
            mark_profile_transaction_conflict "profile-rollback-path-occupied"
            return 1
        fi
        if [ ! -f "$profile_path" ] \
            || [ -L "$profile_path" ] \
            || [ "$(profile_sha256 "$profile_path")" != "$PROFILE_BEFORE_HASH" ]; then
            mark_profile_transaction_conflict "profile-rollback-result-changed"
            return 1
        fi
    fi
    rm -f "$generated_claim"
    rm -rf "$profile_transaction_dir"
}

# Detect OS
OS="$(uname -s)"
case "$OS" in
    Darwin) OS_TYPE="darwin" ;;
    Linux)  OS_TYPE="linux" ;;
    *)      error "Unsupported operating system: $OS" ;;
esac

# Check for required dependencies. A local artifact is the explicit CI/offline
# contract and must not require network tooling.
DOWNLOADER=""
if [ -n "$LOCAL_ARTIFACT" ]; then
    [ -f "$LOCAL_ARTIFACT" ] || error "Local install artifact not found: $LOCAL_ARTIFACT"
elif command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER="wget"
else
    error "Either curl or wget is required but neither is installed"
fi

# Check if yq is available (optional, for YAML parsing)
HAS_YQ=false
if command -v yq >/dev/null 2>&1; then
    HAS_YQ=true
fi

# Download function that works with both curl and wget
# Usage: download_file <url> [output_file] [show_progress]
download_file() {
    local url="$1"
    local output="$2"
    local show_progress="${3:-false}"

    if [ "$DOWNLOADER" = "curl" ]; then
        if [ -n "$output" ]; then
            if [ "$show_progress" = "true" ]; then
                curl -fL --progress-bar -o "$output" "$url"
            else
                curl -fsSL -o "$output" "$url"
            fi
        else
            curl -fsSL "$url"
        fi
    elif [ "$DOWNLOADER" = "wget" ]; then
        if [ -n "$output" ]; then
            if [ "$show_progress" = "true" ]; then
                wget --show-progress -q -O "$output" "$url"
            else
                wget -q -O "$output" "$url"
            fi
        else
            wget -q -O - "$url"
        fi
    else
        return 1
    fi
}

# Extract sha512 from YAML for a specific architecture
# YAML format: files array with url, sha512, arch fields
get_sha512_from_yaml() {
    local yaml="$1"
    local target_arch="$2"

    # Find the line with the target arch and extract sha512 from preceding lines
    local in_target_block=false
    local sha512=""

    while IFS= read -r line; do
        # Check if we're entering a new file entry
        if [[ $line =~ ^[[:space:]]*-[[:space:]]*url: ]]; then
            in_target_block=false
            sha512=""
        fi
        # Extract sha512
        if [[ $line =~ sha512:[[:space:]]*(.+) ]]; then
            sha512="${BASH_REMATCH[1]}"
        fi
        # Check arch
        if [[ $line =~ arch:[[:space:]]*(.+) ]]; then
            local arch="${BASH_REMATCH[1]}"
            if [ "$arch" = "$target_arch" ] && [ -n "$sha512" ]; then
                echo "$sha512"
                return 0
            fi
        fi
    done <<< "$yaml"

    return 1
}

# Extract filename from YAML for a specific architecture
get_filename_from_yaml() {
    local yaml="$1"
    local target_arch="$2"

    local url=""

    while IFS= read -r line; do
        # Check if we're entering a new file entry
        if [[ $line =~ ^[[:space:]]*-[[:space:]]*url:[[:space:]]*(.+) ]]; then
            url="${BASH_REMATCH[1]}"
        fi
        # Check arch
        if [[ $line =~ arch:[[:space:]]*(.+) ]]; then
            local arch="${BASH_REMATCH[1]}"
            if [ "$arch" = "$target_arch" ] && [ -n "$url" ]; then
                echo "$url"
                return 0
            fi
        fi
    done <<< "$yaml"

    return 1
}

# Detect architecture
case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)" ;;
esac

# Set platform-specific variables
if [ "$OS_TYPE" = "darwin" ]; then
    platform="darwin-${arch}"
    APP_NAME="Polo AI.app"
    INSTALL_DIR="${POLO_AI_INSTALL_DIR:-/Applications}"
    ext="zip"
    yml_file="latest-mac.yml"
else
    # Linux only supports x64 currently
    if [ "$arch" != "x64" ]; then
        error "Linux currently only supports x64 architecture. Your architecture: $arch"
    fi
    platform="linux-${arch}"
    APP_NAME="Polo-AI-x64.AppImage"
    INSTALL_DIR="${POLO_AI_BIN_DIR:-$HOME/.local/bin}"
    ext="AppImage"
    yml_file="latest-linux.yml"
fi

echo ""
info "Detected platform: $platform"

mkdir -p "$DOWNLOAD_DIR"
mkdir -p "$INSTALL_DIR"

if [ -n "$LOCAL_ARTIFACT" ]; then
    filename="$(basename "$LOCAL_ARTIFACT")"
    installer_path="$DOWNLOAD_DIR/$filename"
    cp "$LOCAL_ARTIFACT" "$installer_path"
    info "Using local install artifact: $LOCAL_ARTIFACT"
else
    # Fetch YAML manifest directly from /electron/latest/ (no version endpoint needed)
    info "Fetching release info..."
    manifest_yaml=$(download_file "$VERSIONS_URL/latest/$yml_file")

    if [ -z "$manifest_yaml" ]; then
        error "Failed to fetch release info from $yml_file"
    fi

    # Extract version from YAML manifest
    if [ "$HAS_YQ" = true ]; then
        version=$(echo "$manifest_yaml" | yq -r '.version // empty')
    else
        version=$(echo "$manifest_yaml" | grep -m1 '^version:' | sed 's/^version:[[:space:]]*//')
    fi

    if [ -z "$version" ]; then
        error "Failed to extract version from manifest"
    fi

    info "Latest version: $version"

    # Extract sha512 and filename for our architecture
    if [ "$HAS_YQ" = true ]; then
        checksum=$(echo "$manifest_yaml" | yq -r ".files[] | select(.arch == \"$arch\") | .sha512")
        filename=$(echo "$manifest_yaml" | yq -r ".files[] | select(.arch == \"$arch\") | .url")
    else
        checksum=$(get_sha512_from_yaml "$manifest_yaml" "$arch")
        filename=$(get_filename_from_yaml "$manifest_yaml" "$arch")
    fi

    # Validate checksum format (SHA512 base64 = 88 characters)
    if [ -z "$checksum" ] || [ ${#checksum} -lt 80 ]; then
        error "Architecture $arch not found in $yml_file"
    fi

    # Use default filename if not found
    if [ -z "$filename" ]; then
        filename="Polo-AI-${arch}.${ext}"
    fi

    info "Expected sha512: ${checksum:0:20}..."

    # Download installer
    installer_url="$VERSIONS_URL/latest/$filename"
    installer_path="$DOWNLOAD_DIR/$filename"

    info "Downloading $filename..."
    echo ""
    if ! download_file "$installer_url" "$installer_path" true; then
        rm -f "$installer_path"
        error "Download failed"
    fi
    echo ""

    # Verify checksum (sha512, base64 encoded)
    info "Verifying checksum..."
    if [ "$OS_TYPE" = "darwin" ]; then
        # macOS: shasum outputs hex, convert to base64
        actual=$(shasum -a 512 "$installer_path" | cut -d' ' -f1 | xxd -r -p | base64)
    else
        # Linux: sha512sum outputs hex, convert to base64
        actual=$(sha512sum "$installer_path" | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n')
    fi

    if [ "$actual" != "$checksum" ]; then
        rm -f "$installer_path"
        error "Checksum verification failed\n  Expected: $checksum\n  Actual:   $actual"
    fi

    success "Checksum verified!"
fi

# Platform-specific installation
if [ "$OS_TYPE" = "darwin" ]; then
    # macOS installation (from ZIP)
    zip_path="$installer_path"

    # Quit the app if it's running (use bundle ID for reliability)
    APP_BUNDLE_ID="com.poloai.app"
    if pgrep -x "Polo AI" >/dev/null 2>&1; then
        info "Quitting Polo AI..."
        osascript -e "tell application id \"$APP_BUNDLE_ID\" to quit" 2>/dev/null || true
        # Wait for app to quit (max 5 seconds) - POSIX compatible loop
        i=0
        while [ $i -lt 10 ]; do
            if ! pgrep -x "Polo AI" >/dev/null 2>&1; then
                break
            fi
            sleep 0.5
            i=$((i + 1))
        done
        # Force kill if still running
        if pgrep -x "Polo AI" >/dev/null 2>&1; then
            warn "App didn't quit gracefully. Force quitting (unsaved data may be lost)..."
            pkill -9 -x "Polo AI" 2>/dev/null || true
            # Wait longer for macOS to release file handles
            sleep 3
        fi
    fi

    # Remove existing installation if present
    if [ -d "$INSTALL_DIR/$APP_NAME" ]; then
        info "Removing previous installation..."
        rm -rf "$INSTALL_DIR/$APP_NAME"
    fi

    # Extract ZIP to temp directory
    info "Extracting..."
    temp_dir=$(mktemp -d)
    if ! unzip -q "$zip_path" -d "$temp_dir"; then
        rm -rf "$temp_dir"
        rm -f "$zip_path"
        error "Failed to extract ZIP"
    fi

    # Find the .app in the extracted contents
    app_source=$(find "$temp_dir" -maxdepth 1 -name "*.app" -type d | head -1)

    if [ -z "$app_source" ]; then
        rm -rf "$temp_dir"
        rm -f "$zip_path"
        error "No .app found in ZIP"
    fi

    # Copy app to /Applications
    info "Installing to $INSTALL_DIR..."
    cp -R "$app_source" "$INSTALL_DIR/$APP_NAME"

    # Clean up
    info "Cleaning up..."
    rm -rf "$temp_dir"
    rm -f "$zip_path"

    # Remove quarantine attribute if present
    xattr -rd com.apple.quarantine "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true

    echo ""
    echo "─────────────────────────────────────────────────────────────────────────"
    echo ""
    success "Installation complete!"
    echo ""
    printf "%b\n" "  Polo AI has been installed to ${BOLD}$INSTALL_DIR/$APP_NAME${NC}"
    echo ""
    printf "%b\n" "  You can launch it from ${BOLD}Applications${NC} or by running:"
    printf "%b\n" "    ${BOLD}open -a 'Polo AI'${NC}"
    echo ""

else
    # Linux installation
    appimage_path="$installer_path"

    APP_DIR="$HOME/.polo-ai/app"
    WRAPPER_PATH="$INSTALL_DIR/polo"
    LEGACY_WRAPPER_PATH="$INSTALL_DIR/polo-ai"
    APPIMAGE_INSTALL_PATH="$APP_DIR/Polo-AI-x64.AppImage"
    EXTRACTED_INSTALL_PATH="$APP_DIR/current"

    mkdir -p "$APP_DIR"
    mkdir -p "$INSTALL_DIR"

    # Extract into a staging directory first. The installed command is a
    # state-owned symlink to the exact canonical wrapper shipped inside the
    # AppImage, so the installer never carries a divergent launcher template.
    extraction_temp="$(mktemp -d "$APP_DIR/.polo-extract.XXXXXX")"
    cleanup_linux_stage() {
        rm -rf "$extraction_temp"
    }
    trap cleanup_linux_stage EXIT
    info "Extracting packaged terminal runtime..."
    (
        cd "$extraction_temp"
        chmod +x "$appimage_path"
        "$appimage_path" --appimage-extract >/dev/null
    )
    extracted_root="$extraction_temp/squashfs-root"
    staged_polo="$extracted_root/resources/app/resources/bin/polo"
    staged_compat="$extracted_root/resources/app/resources/bin/polo-ai"
    staged_helper="$extracted_root/resources/app/resources/scripts/linux-terminal-integration.sh"
    staged_package="$extracted_root/resources/app/package.json"
    for required in "$staged_polo" "$staged_compat" "$staged_helper" "$staged_package"; do
        [ -f "$required" ] || error "Required packaged terminal file is missing: $required"
    done
    packaged_version=$(
        sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
            "$staged_package" | head -1
    )
    [ -n "$packaged_version" ] || error "Unable to read the packaged Polo version."

    existing_polo=$(command -v polo 2>/dev/null || true)
    if [ -n "$existing_polo" ] && [ "$existing_polo" != "$WRAPPER_PATH" ]; then
        error "Another command named 'polo' already exists at $existing_polo. It was not changed."
    fi

    bash "$staged_helper" preflight \
        --app-dir "$APP_DIR" \
        --bin-dir "$INSTALL_DIR" \
        --version "$packaged_version" \
        --staged-polo "$staged_polo" \
        --staged-compat "$staged_compat"

    # Validate and snapshot the selected login profile before any App/runtime
    # mutation. A malformed or user-replaced profile aborts the transaction.
    MANAGED_PROFILE_PATH="$(managed_profile_path)"
    begin_managed_profile_transaction "$APP_DIR" \
        || error "Polo terminal setup found a conflicting shell profile. The existing installation was not changed; see ${profile_transaction_dir:-the profile warning above}."

    rollback_linux_app() {
        local profile_rollback_ok=true

        rm -rf "$EXTRACTED_INSTALL_PATH"
        rm -f "$APPIMAGE_INSTALL_PATH"
        [ -d "$current_backup" ] && mv "$current_backup" "$EXTRACTED_INSTALL_PATH"
        [ -f "$appimage_backup" ] && mv "$appimage_backup" "$APPIMAGE_INSTALL_PATH"
        restore_managed_profile "$MANAGED_PROFILE_PATH" "$profile_backup" "$profile_existed" \
            || profile_rollback_ok=false
        [ "$profile_rollback_ok" = true ]
    }

    # No installed App/runtime/PATH mutation occurs until ownership and the
    # selected profile have both passed their read-only preflight.
    if pgrep -f "Polo-AI.*AppImage" >/dev/null 2>&1; then
        info "Stopping Polo AI..."
        pkill -f "Polo-AI.*AppImage" 2>/dev/null || true
        sleep 2
    fi

    current_backup="$APP_DIR/.current.previous.$$"
    appimage_backup="$APP_DIR/.Polo-AI.previous.$$"
    [ -d "$EXTRACTED_INSTALL_PATH" ] && mv "$EXTRACTED_INSTALL_PATH" "$current_backup"
    [ -f "$APPIMAGE_INSTALL_PATH" ] && mv "$APPIMAGE_INSTALL_PATH" "$appimage_backup"
    if ! mv "$extracted_root" "$EXTRACTED_INSTALL_PATH"; then
        [ -d "$current_backup" ] && mv "$current_backup" "$EXTRACTED_INSTALL_PATH"
        [ -f "$appimage_backup" ] && mv "$appimage_backup" "$APPIMAGE_INSTALL_PATH"
        rm -rf "$profile_transaction_dir"
        error "Failed to install the packaged runtime."
    fi
    if ! mv "$appimage_path" "$APPIMAGE_INSTALL_PATH"; then
        rm -rf "$EXTRACTED_INSTALL_PATH"
        [ -d "$current_backup" ] && mv "$current_backup" "$EXTRACTED_INSTALL_PATH"
        [ -f "$appimage_backup" ] && mv "$appimage_backup" "$APPIMAGE_INSTALL_PATH"
        rm -rf "$profile_transaction_dir"
        error "Failed to install the AppImage."
    fi
    chmod +x "$APPIMAGE_INSTALL_PATH"

    # Configure PATH while the old App backups are still available. If this
    # fails, neither launchers nor ownership state have been changed yet.
    if ! configure_managed_path; then
        profile_rollback_ok=true
        rollback_linux_app || profile_rollback_ok=false
        if [ "$profile_rollback_ok" = true ]; then
            error "Failed to configure Polo terminal PATH. The previous installation was restored."
        fi
        error "Failed to configure Polo terminal PATH because the profile changed concurrently. User content was preserved; see $profile_transaction_dir."
    fi

    path_entry_owned=true
    installed_helper="$EXTRACTED_INSTALL_PATH/resources/app/resources/scripts/linux-terminal-integration.sh"
    previous_args=()
    if [ -d "$current_backup" ]; then
        previous_args=(--previous-current "$current_backup")
    fi
    if ! bash "$installed_helper" install \
        --app-dir "$APP_DIR" \
        --bin-dir "$INSTALL_DIR" \
        --version "$packaged_version" \
        --path-entry-owned "$path_entry_owned" \
        --profile-path "$MANAGED_PROFILE_PATH" \
        "${previous_args[@]}"; then
        profile_rollback_ok=true
        rollback_linux_app || profile_rollback_ok=false
        if [ "$profile_rollback_ok" = true ]; then
            error "Failed to install Polo terminal integration. The previous installation and profile were restored."
        fi
        error "Failed to install Polo terminal integration after the profile changed concurrently. User content was preserved; see $profile_transaction_dir."
    fi

    # The helper performs final launcher/state verification before returning.
    # Until it succeeds, the previous App and profile remain available.
    rm -rf "$current_backup"
    rm -f "$appimage_backup"
    rm -rf "$profile_transaction_dir"

    # Migrate old installation
    OLD_APPIMAGE="$INSTALL_DIR/Polo-AI-x64.AppImage"
    [ -f "$OLD_APPIMAGE" ] && rm -f "$OLD_APPIMAGE"
    trap - EXIT
    cleanup_linux_stage

    echo ""
    echo "─────────────────────────────────────────────────────────────────────────"
    echo ""
    success "Installation complete!"
    echo ""
    printf "%b\n" "  AppImage: ${BOLD}$APPIMAGE_INSTALL_PATH${NC}"
    printf "%b\n" "  Launcher: ${BOLD}$WRAPPER_PATH${NC}"
    echo ""
    printf "%b\n" "  App: ${BOLD}polo app${NC}"
    printf "%b\n" "  Terminal: ${BOLD}polo --help${NC}"
    echo ""
    printf "%b\n" "  Open a new terminal if ${BOLD}polo${NC} is not visible yet."
    echo ""

    # FUSE check
    if ! command -v fusermount >/dev/null 2>&1; then
        warn "FUSE required but not detected."
        printf "%b\n" "  Install: ${BOLD}sudo apt install fuse libfuse2${NC} (Debian/Ubuntu)"
        printf "%b\n" "           ${BOLD}sudo dnf install fuse fuse-libs${NC} (Fedora)"
    fi
fi
