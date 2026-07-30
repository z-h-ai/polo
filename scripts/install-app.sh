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

PATH_BLOCK_START="# >>> Polo CLI >>>"
PATH_BLOCK_END="# <<< Polo CLI <<<"

configure_managed_path() {
    local shell_name
    local profile_path
    local path_line
    local start_count
    local end_count
    local profile_tmp
    local profile_mode=""

    shell_name="${SHELL##*/}"
    case "$shell_name" in
        fish)
            profile_path="$HOME/.config/fish/conf.d/polo.fish"
            path_line='fish_add_path -g "$HOME/.local/bin"'
            ;;
        zsh)
            profile_path="$HOME/.zprofile"
            path_line='export PATH="$HOME/.local/bin:$PATH"'
            ;;
        *)
            profile_path="$HOME/.profile"
            path_line='export PATH="$HOME/.local/bin:$PATH"'
            ;;
    esac

    mkdir -p "$(dirname "$profile_path")"
    if [ ! -e "$profile_path" ]; then
        : > "$profile_path"
        chmod 600 "$profile_path"
    fi

    start_count=$(grep -Fxc "$PATH_BLOCK_START" "$profile_path" 2>/dev/null || true)
    end_count=$(grep -Fxc "$PATH_BLOCK_END" "$profile_path" 2>/dev/null || true)
    if [ "$start_count" -ne "$end_count" ] || [ "$start_count" -gt 1 ]; then
        error "Malformed Polo PATH block in $profile_path. It was not changed."
    fi
    if [ "$start_count" -eq 1 ] && ! awk -v start="$PATH_BLOCK_START" -v end="$PATH_BLOCK_END" '
        $0 == start { start_line = NR }
        $0 == end { end_line = NR }
        END { exit !(start_line && end_line && start_line < end_line) }
    ' "$profile_path"; then
        error "Malformed Polo PATH block in $profile_path. It was not changed."
    fi

    profile_tmp="$(dirname "$profile_path")/.polo-profile.$$"
    profile_mode=$(stat -c '%a' "$profile_path" 2>/dev/null || true)
    awk -v start="$PATH_BLOCK_START" -v end="$PATH_BLOCK_END" '
        $0 == start { managed = 1; next }
        $0 == end { managed = 0; next }
        !managed { print }
    ' "$profile_path" > "$profile_tmp"
    {
        printf "%s\n" "$PATH_BLOCK_START"
        printf "%s\n" "$path_line"
        printf "%s\n" "$PATH_BLOCK_END"
    } >> "$profile_tmp"

    if ! cmp -s "$profile_path" "$profile_tmp"; then
        cp "$profile_path" "$profile_path.polo-backup-$(date +%s)"
        mv -f "$profile_tmp" "$profile_path"
        [ -n "$profile_mode" ] && chmod "$profile_mode" "$profile_path"
        info "Configured terminal command in $profile_path"
    else
        rm -f "$profile_tmp"
    fi
}

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

    # New paths
    APP_DIR="$HOME/.polo-ai/app"
    WRAPPER_PATH="$INSTALL_DIR/polo"
    LEGACY_WRAPPER_PATH="$INSTALL_DIR/polo-ai"
    APPIMAGE_INSTALL_PATH="$APP_DIR/Polo-AI-x64.AppImage"

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

    # Create wrapper script
    existing_polo=$(command -v polo 2>/dev/null || true)
    if [ -n "$existing_polo" ] && [ "$existing_polo" != "$WRAPPER_PATH" ]; then
        error "Another command named 'polo' already exists at $existing_polo. It was not changed."
    fi
    if [ -e "$WRAPPER_PATH" ] && ! grep -q "managed by Polo AI" "$WRAPPER_PATH" 2>/dev/null; then
        error "Another file already exists at $WRAPPER_PATH. It was not changed."
    fi
    info "Creating launcher at $WRAPPER_PATH..."
    WRAPPER_TMP="$WRAPPER_PATH.tmp.$$"
    cat > "$WRAPPER_TMP" << 'WRAPPER_EOF'
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
WRAPPER_EOF

    chmod +x "$WRAPPER_TMP"
    mv -f "$WRAPPER_TMP" "$WRAPPER_PATH"

    # Keep the previous command as a managed compatibility shim through Polo 1.0.
    if [ ! -e "$LEGACY_WRAPPER_PATH" ] || grep -q "Polo AI launcher\\|managed by Polo AI\\|deprecated; use 'polo'" "$LEGACY_WRAPPER_PATH" 2>/dev/null; then
        LEGACY_TMP="$LEGACY_WRAPPER_PATH.tmp.$$"
        cat > "$LEGACY_TMP" << 'LEGACY_EOF'
#!/bin/sh
echo "Warning: 'polo-ai' is deprecated; use 'polo' instead." >&2
exec "$HOME/.local/bin/polo" "$@"
LEGACY_EOF
        chmod +x "$LEGACY_TMP"
        mv -f "$LEGACY_TMP" "$LEGACY_WRAPPER_PATH"
    else
        warn "Existing non-Polo command left unchanged: $LEGACY_WRAPPER_PATH"
    fi

    configure_managed_path

    # Migrate old installation
    OLD_APPIMAGE="$INSTALL_DIR/Polo-AI-x64.AppImage"
    [ -f "$OLD_APPIMAGE" ] && rm -f "$OLD_APPIMAGE"

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
