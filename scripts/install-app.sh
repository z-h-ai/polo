#!/bin/bash

set -e

VERSIONS_URL="https://polo.ai/electron"
DOWNLOAD_DIR="$HOME/.polo-ai/downloads"

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

# Detect OS
OS="$(uname -s)"
case "$OS" in
    Darwin) OS_TYPE="darwin" ;;
    Linux)  OS_TYPE="linux" ;;
    *)      error "Unsupported operating system: $OS" ;;
esac

# Check for required dependencies
DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER="wget"
else
    error "Either curl or wget is required but neither is installed"
fi

CLI_BIN_DIR="$HOME/.local/bin"
CLI_MANAGED_MARKER="# Managed by Polo AI CLI installer"

ensure_cli_destination_available() {
    destination="$1"
    if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
        return 0
    fi
    if [ -L "$destination" ]; then
        existing_target=$(readlink "$destination")
        case "$existing_target" in
            *"Polo AI.app/Contents/Resources/app/resources/bin/polo"*|*"Polo AI.app/Contents/Resources/app/resources/bin/polo-ai"*) return 0 ;;
        esac
    elif grep -qF "$CLI_MANAGED_MARKER" "$destination" 2>/dev/null; then
        return 0
    elif grep -qF "# Polo AI launcher - handles Linux-specific AppImage issues" "$destination" 2>/dev/null \
        && grep -qF "Polo-AI-x64.AppImage" "$destination" 2>/dev/null; then
        # Recognize the legacy product-owned GUI wrapper so upgrades can replace
        # polo-ai with the compatibility CLI alias required by the current CLI.
        return 0
    fi
    error "Refusing to overwrite unmanaged command: $destination"
}

install_cli_symlink() {
    source_path="$1"
    destination="$2"
    ensure_cli_destination_available "$destination"
    [ -x "$source_path" ] || error "Packaged CLI launcher is missing: $source_path"
    rm -f "$destination"
    ln -s "$source_path" "$destination"
}

ensure_cli_bin_on_path() {
    case ":$PATH:" in
        *":$CLI_BIN_DIR:"*) return 0 ;;
    esac
    case "${SHELL:-}" in
        */zsh) shell_profile="$HOME/.zprofile" ;;
        */bash) shell_profile="$HOME/.bashrc" ;;
        *) shell_profile="$HOME/.profile" ;;
    esac
    path_line='export PATH="$HOME/.local/bin:$PATH" # Polo AI CLI'
    if [ ! -f "$shell_profile" ] || ! grep -qF '# Polo AI CLI' "$shell_profile"; then
        printf '\n%s\n' "$path_line" >> "$shell_profile"
        info "Added $CLI_BIN_DIR to PATH in $shell_profile (open a new terminal to use it)."
    fi
}

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
    INSTALL_DIR="/Applications"
    ext="zip"
    yml_file="latest-mac.yml"
else
    # Linux only supports x64 currently
    if [ "$arch" != "x64" ]; then
        error "Linux currently only supports x64 architecture. Your architecture: $arch"
    fi
    platform="linux-${arch}"
    APP_NAME="Polo-AI-x64.AppImage"
    INSTALL_DIR="$HOME/.local/bin"
    ext="AppImage"
    yml_file="latest-linux.yml"
fi

echo ""
info "Detected platform: $platform"

mkdir -p "$DOWNLOAD_DIR"
mkdir -p "$INSTALL_DIR"

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

# Platform-specific installation
if [ "$OS_TYPE" = "darwin" ]; then
    # macOS installation (from ZIP)
    zip_path="$installer_path"
    ensure_cli_destination_available "$CLI_BIN_DIR/polo"
    ensure_cli_destination_available "$CLI_BIN_DIR/polo-ai"

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

    # Expose both documented command names. The packaged launchers resolve
    # symlinks back into the app bundle, so no payload is copied out of the
    # signed installation.
    mkdir -p "$CLI_BIN_DIR"
    APP_CLI_BIN="$INSTALL_DIR/$APP_NAME/Contents/Resources/app/resources/bin"
    info "Installing polo and polo-ai commands to $CLI_BIN_DIR..."
    install_cli_symlink "$APP_CLI_BIN/polo" "$CLI_BIN_DIR/polo"
    install_cli_symlink "$APP_CLI_BIN/polo-ai" "$CLI_BIN_DIR/polo-ai"
    ensure_cli_bin_on_path

    echo ""
    echo "─────────────────────────────────────────────────────────────────────────"
    echo ""
    success "Installation complete!"
    echo ""
    printf "%b\n" "  Polo AI has been installed to ${BOLD}$INSTALL_DIR/$APP_NAME${NC}"
    echo ""
    printf "%b\n" "  You can launch it from ${BOLD}Applications${NC} or by running:"
    printf "%b\n" "    ${BOLD}open -a 'Polo AI'${NC}"
    printf "%b\n" "  CLI: ${BOLD}polo exec \"hello\"${NC} (also available as polo-ai)"
    printf "%b\n" "  If needed, add ${BOLD}$CLI_BIN_DIR${NC} to PATH."
    echo ""

else
    # Linux installation
    appimage_path="$installer_path"

    # New paths
    APP_DIR="$HOME/.polo-ai/app"
    GUI_WRAPPER_PATH="$INSTALL_DIR/polo-gui"
    POLO_CLI_PATH="$INSTALL_DIR/polo"
    POLO_AI_CLI_PATH="$INSTALL_DIR/polo-ai"
    APPIMAGE_INSTALL_PATH="$APP_DIR/Polo-AI-x64.AppImage"
    ensure_cli_destination_available "$POLO_CLI_PATH"
    ensure_cli_destination_available "$POLO_AI_CLI_PATH"
    ensure_cli_destination_available "$GUI_WRAPPER_PATH"

    # Kill the app if it's running
    if pgrep -f "Polo-AI.*AppImage" >/dev/null 2>&1; then
        info "Stopping Polo AI..."
        pkill -f "Polo-AI.*AppImage" 2>/dev/null || true
        sleep 2
    fi

    # Create directories
    mkdir -p "$APP_DIR"
    mkdir -p "$INSTALL_DIR"

    # Remove existing AppImage
    [ -f "$APPIMAGE_INSTALL_PATH" ] && rm -f "$APPIMAGE_INSTALL_PATH"

    # Install AppImage
    info "Installing AppImage to $APP_DIR..."
    mv "$appimage_path" "$APPIMAGE_INSTALL_PATH"
    chmod +x "$APPIMAGE_INSTALL_PATH"

    # Keep an explicit GUI launcher while polo and polo-ai become aliases for
    # the non-interactive CLI contract.
    info "Creating GUI launcher at $GUI_WRAPPER_PATH..."
    cat > "$GUI_WRAPPER_PATH" << 'WRAPPER_EOF'
#!/bin/bash
# Managed by Polo AI CLI installer
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
WRAPPER_EOF

    chmod +x "$GUI_WRAPPER_PATH"

cat > "$POLO_CLI_PATH" << 'CLI_WRAPPER_EOF'
#!/bin/sh
# Managed by Polo AI CLI installer
APPIMAGE_PATH="$HOME/.polo-ai/app/Polo-AI-x64.AppImage"
if [ ! -x "$APPIMAGE_PATH" ]; then
    echo "Polo AI is not installed at $APPIMAGE_PATH" >&2
    exit 1
fi

# Mount the AppImage without starting Electron, then invoke the real packaged
# CLI launcher. Capturing the mount runtime's stdout keeps polo JSONL/stdout
# protocol-clean.
MOUNT_LOG=$(mktemp "${TMPDIR:-/tmp}/polo-appimage-mount.XXXXXX") || exit 1
MOUNT_PID=""
cleanup_mount() {
    if [ -n "$MOUNT_PID" ]; then
        kill "$MOUNT_PID" 2>/dev/null || true
        wait "$MOUNT_PID" 2>/dev/null || true
    fi
    rm -f "$MOUNT_LOG"
}
trap cleanup_mount EXIT HUP INT TERM
(trap '' HUP INT TERM; exec "$APPIMAGE_PATH" --appimage-mount >"$MOUNT_LOG" 2>&1) &
MOUNT_PID=$!

attempt=0
MOUNT_DIR=""
while [ "$attempt" -lt 100 ]; do
    MOUNT_DIR=$(sed -n '/^\//{p;q;}' "$MOUNT_LOG" 2>/dev/null || true)
    if [ -n "$MOUNT_DIR" ] && [ -d "$MOUNT_DIR" ]; then
        break
    fi
    if ! kill -0 "$MOUNT_PID" 2>/dev/null; then
        cat "$MOUNT_LOG" >&2
        echo "Failed to mount the Polo AI AppImage" >&2
        exit 1
    fi
    sleep 0.05
    attempt=$((attempt + 1))
done
if [ -z "$MOUNT_DIR" ] || [ ! -d "$MOUNT_DIR" ]; then
    echo "Timed out mounting the Polo AI AppImage" >&2
    exit 1
fi

PACKAGED_CLI=$(find "$MOUNT_DIR" -path '*/resources/app/resources/bin/polo' -type f -print -quit)
if [ -z "$PACKAGED_CLI" ] || [ ! -x "$PACKAGED_CLI" ]; then
    echo "Packaged Polo CLI launcher is missing from the AppImage" >&2
    exit 1
fi
"$PACKAGED_CLI" "$@"
exit $?
CLI_WRAPPER_EOF
    cat > "$POLO_AI_CLI_PATH" << 'CLI_ALIAS_EOF'
#!/bin/sh
# Managed by Polo AI CLI installer
BIN_DIR=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
exec "$BIN_DIR/polo" "$@"
CLI_ALIAS_EOF
    chmod +x "$POLO_CLI_PATH" "$POLO_AI_CLI_PATH"
    ensure_cli_bin_on_path

    # Migrate old installation
    OLD_APPIMAGE="$INSTALL_DIR/Polo-AI-x64.AppImage"
    [ -f "$OLD_APPIMAGE" ] && rm -f "$OLD_APPIMAGE"

    echo ""
    echo "─────────────────────────────────────────────────────────────────────────"
    echo ""
    success "Installation complete!"
    echo ""
    printf "%b\n" "  AppImage: ${BOLD}$APPIMAGE_INSTALL_PATH${NC}"
    printf "%b\n" "  GUI launcher: ${BOLD}$GUI_WRAPPER_PATH${NC}"
    printf "%b\n" "  CLI launchers: ${BOLD}$POLO_CLI_PATH${NC}, ${BOLD}$POLO_AI_CLI_PATH${NC}"
    echo ""
    printf "%b\n" "  Run CLI with: ${BOLD}polo exec \"hello\"${NC}"
    printf "%b\n" "  Run GUI with: ${BOLD}polo-gui${NC}"
    echo ""
    printf "%b\n" "  Add to PATH if needed:"
    printf "%b\n" "    ${BOLD}echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc${NC}"
    echo ""

    # FUSE check
    if ! command -v fusermount >/dev/null 2>&1; then
        warn "FUSE required but not detected."
        printf "%b\n" "  Install: ${BOLD}sudo apt install fuse libfuse2${NC} (Debian/Ubuntu)"
        printf "%b\n" "           ${BOLD}sudo dnf install fuse fuse-libs${NC} (Fedora)"
    fi
fi
