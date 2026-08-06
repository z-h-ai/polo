import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const unixInstaller = readFileSync(join(root, 'scripts', 'install-app.sh'), 'utf8')
const windowsInstaller = readFileSync(join(root, 'scripts', 'install-app.ps1'), 'utf8')
const linuxIntegration = readFileSync(
  join(root, 'apps', 'electron', 'resources', 'scripts', 'linux-terminal-integration.sh'),
  'utf8',
)
const windowsIntegration = readFileSync(
  join(root, 'apps', 'electron', 'resources', 'scripts', 'windows-terminal-integration.ps1'),
  'utf8',
)

describe('installed CLI entrypoints', () => {
  it('installs both macOS aliases from the packaged CLI payload', () => {
    expect(unixInstaller).toContain('Contents/Resources/app/resources/bin')
    expect(unixInstaller).toContain('install_cli_symlink "$APP_CLI_BIN/polo" "$CLI_BIN_DIR/polo"')
    expect(unixInstaller).toContain('install_cli_symlink "$APP_CLI_BIN/polo-ai" "$CLI_BIN_DIR/polo-ai"')
  })

  it('extracts Linux AppImage resources and installs the packaged launchers transactionally', () => {
    expect(unixInstaller).toContain('"$appimage_path" --appimage-extract')
    expect(unixInstaller).toContain('resources/app/resources/bin/polo')
    expect(unixInstaller).toContain('linux-terminal-integration.sh')
    expect(unixInstaller).toContain('bash "$staged_helper" preflight')
    expect(linuxIntegration).toContain('exec "$APPIMAGE_PATH" --no-sandbox --polo-cli "$@"')
  })

  it('delegates Windows launcher installation to the packaged transactional integration', () => {
    expect(windowsInstaller).toContain('windows-terminal-integration.ps1')
    expect(windowsInstaller).toContain('-Mode Install -InstallDir $installDir')
    expect(windowsIntegration).toContain('$launcher = Join-Path $BinDir "polo.cmd"')
    expect(windowsIntegration).toContain('$legacyLauncher = Join-Path $BinDir "polo-ai.cmd"')
    expect(windowsIntegration).toContain('"bin\\polo.cmd"')
    expect(windowsIntegration).toContain('"bin\\polo-ai.cmd"')
  })

  it('refuses to overwrite command paths that are not owned by this installer', () => {
    expect(unixInstaller).toContain('Refusing to overwrite unmanaged command')
    expect(linuxIntegration).toContain('ownership state is missing, invalid, or the file is user-owned')
    expect(windowsIntegration).toContain('because it is modified or user-owned')
  })

  it('makes the user-level Unix command directory discoverable in new shells', () => {
    expect(unixInstaller).toContain('ensure_cli_bin_on_path')
    expect(unixInstaller).toContain('export PATH="$HOME/.local/bin:$PATH" # Polo AI CLI')
  })
})
