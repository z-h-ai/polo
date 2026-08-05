import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const unixInstaller = readFileSync(join(root, 'scripts', 'install-app.sh'), 'utf8')
const windowsInstaller = readFileSync(join(root, 'scripts', 'install-app.ps1'), 'utf8')

describe('installed CLI entrypoints', () => {
  it('installs both macOS aliases from the packaged CLI payload', () => {
    expect(unixInstaller).toContain('Contents/Resources/app/resources/bin')
    expect(unixInstaller).toContain('install_cli_symlink "$APP_CLI_BIN/polo" "$CLI_BIN_DIR/polo"')
    expect(unixInstaller).toContain('install_cli_symlink "$APP_CLI_BIN/polo-ai" "$CLI_BIN_DIR/polo-ai"')
  })

  it('mounts Linux AppImage resources and directly invokes the packaged CLI launcher', () => {
    expect(unixInstaller).toContain('exec "$APPIMAGE_PATH" --appimage-mount')
    expect(unixInstaller).toContain("-path '*/resources/app/resources/bin/polo'")
    expect(unixInstaller).toContain('"$PACKAGED_CLI" "$@"')
    expect(unixInstaller).toContain('exec "$BIN_DIR/polo" "$@"')
    expect(unixInstaller).toContain('GUI_WRAPPER_PATH="$INSTALL_DIR/polo-gui"')
  })

  it('installs both Windows aliases against the packaged CLI instead of the GUI executable', () => {
    expect(windowsInstaller).toContain('$poloCmdFile = "$binDir\\polo.cmd"')
    expect(windowsInstaller).toContain('$poloAiCmdFile = "$binDir\\polo-ai.cmd"')
    expect(windowsInstaller).toContain('resources\\app\\resources\\bin\\polo.cmd')
    expect(windowsInstaller).toContain('call `"$packagedCliPath`" %*')
    expect(windowsInstaller).toContain('call `"%~dp0polo.cmd`" %*')
  })

  it('refuses to overwrite command paths that are not owned by this installer', () => {
    expect(unixInstaller).toContain('Refusing to overwrite unmanaged command')
    expect(windowsInstaller).toContain('Refusing to overwrite unmanaged command')
  })

  it('makes the user-level Unix command directory discoverable in new shells', () => {
    expect(unixInstaller).toContain('ensure_cli_bin_on_path')
    expect(unixInstaller).toContain('export PATH="$HOME/.local/bin:$PATH" # Polo AI CLI')
  })
})
