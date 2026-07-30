import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const read = (relativePath: string) => readFileSync(join(root, relativePath), 'utf8')

describe('Electron final artifact validation pipeline', () => {
  it('makes final container smoke a builder gate', () => {
    const builder = read('apps/electron/electron-builder.yml')
    const hook = read('apps/electron/scripts/afterAllArtifactBuild.cjs')

    expect(builder).toContain('afterAllArtifactBuild: scripts/afterAllArtifactBuild.cjs')
    expect(hook).toContain('validate-final-artifacts.sh')
    expect(hook).toContain('validate-final-artifacts.ps1')
    expect(hook).toContain("POLO_AI_ARTIFACT_VALIDATION_MODE || 'smoke'")
    expect(hook).toContain('POLO_AI_PREVIOUS_ARTIFACT')
    expect(hook).toContain('full artifact validation requires')
    expect(hook).toContain('final artifact validation failed')
  })

  it('validates final Unix containers and real cross-version lifecycle mode', () => {
    const validator = read('apps/electron/scripts/validate-final-artifacts.sh')

    expect(validator).toContain('Polo-AI-${ARCH}.dmg')
    expect(validator).toContain('Polo-AI-${ARCH}.zip')
    expect(validator).toContain('hdiutil attach')
    expect(validator).toContain('ditto -x -k')
    expect(validator).toContain('--appimage-extract')
    expect(validator).toContain('Full validation requires --previous-artifact')
    expect(validator).toContain('POLO_AI_INSTALL_ARTIFACT')
    expect(validator).toContain('bash "$INSTALL_SCRIPT"')
    expect(validator).toContain('bash "$UNINSTALL_SCRIPT"')
    expect(validator).toContain('--polo-terminal-integration install')
    expect(validator).toContain('--polo-terminal-integration repair')
    expect(validator).toContain('--polo-terminal-integration uninstall')
    expect(validator).toContain('Previous artifact version must differ')
    expect(validator).toContain('polo --help')
    expect(validator).toContain('run_packaged_headless_lifecycle')
    expect(validator).toContain('--base-url')
    expect(validator).toContain("'hello'")
    expect(validator).toContain('polo-run-server-*')
    expect(validator).not.toContain('POLO_AI_E2E_RUN_PROBE')
    expect(validator).toContain('polo app')
    expect(validator).toContain('POLO_AI_RUNTIME_DISCOVERY_FILE')
    expect(validator).toContain('polo sessions')
    expect(validator).toContain('user-owned')
    expect(validator).toContain('"$shell_path" -lic "cd \\"\\$HOME\\"')
  })

  it('validates the installed NSIS container and real previous-to-current lifecycle', () => {
    const validator = read('apps/electron/scripts/validate-final-artifacts.ps1')

    expect(validator).toContain('Full validation requires -PreviousArtifact')
    expect(validator).toContain('Invoke-Installer')
    expect(validator).toContain('Test-InstalledContainer')
    expect(validator).toContain('Test-FullLifecycle')
    expect(validator).toContain('Invoke-Installer $PreviousArtifact')
    expect(validator).toContain('Previous artifact version must differ')
    expect(validator).toContain('Get-NsisArtifactVersion')
    expect(validator).toContain('Read-only NSIS lifecycle preflight passed')
    expect(validator).toContain('polo --help')
    expect(validator).toContain('Invoke-PackagedRunLifecycle')
    expect(validator).toContain('--base-url')
    expect(validator).toContain('polo app')
    expect(validator).toContain('artifact-manifest.json')
    expect(validator).toContain('polo sessions')
    expect(validator).toContain('rem user modification')
    expect(validator).toContain('Test-UserCommandConflict')
    expect(validator).toContain('Invoke-Uninstaller')
    expect(validator).toContain('Assert-ManagedPathPresent')
    expect(validator).toContain('Assert-FreshShellCommandAbsent')
    expect(validator).toContain('GetEnvironmentVariable("Path", "Machine")')
    expect(validator).toContain('cd /d')
    expect(validator).toContain('changed User PATH despite a user command conflict')
    expect(validator).not.toContain('$env:Path = "$binDir;')
  })

  it('defines a blocking release/nightly three-platform full workflow', () => {
    const workflow = read('.github/workflows/electron-artifact-full.yml')

    expect(workflow).toContain('release:')
    expect(workflow).toContain('schedule:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('previous_release_tag:')
    expect(workflow).toContain('POLO_AI_FULL_E2E_PREVIOUS_RELEASE_TAG')
    expect(workflow).toContain('POLO_AI_ARTIFACT_VALIDATION_MODE: full')
    expect(workflow).toContain('POLO_AI_PREVIOUS_ARTIFACT:')
    expect(workflow).toContain('runner: macos-14')
    expect(workflow).toContain('runner: windows-latest')
    expect(workflow).toContain('runner: ubuntu-latest')
    expect(workflow).toContain('gh release download')
    expect(workflow).toContain('windows-terminal-integration.test.ps1')
    expect(workflow).toContain('electron:dist:dev:mac')
    expect(workflow).toContain('electron:dist:dev:win')
    expect(workflow).toContain('electron:dist:dev:linux')
    expect(workflow).toContain('prepare-platform-runtime.test.ts')
    expect(workflow).toContain('test ! -e apps/electron/vendor/bun')
    expect(workflow).toContain('windows-wrapper-smoke.test.ps1')
    expect(workflow).toContain('xvfb-run -a')
    expect(workflow).toContain('actions/upload-artifact@v4')
    expect(workflow).not.toContain('bun run validate:ci')
    expect(read('scripts/prepare-platform-runtime.ts')).toContain('buildMcpServers(config)')
  })

  it('keeps full validation preflight and native display contracts ahead of lifecycle writes', () => {
    const unix = read('apps/electron/scripts/validate-final-artifacts.sh')
    const windows = read('apps/electron/scripts/validate-final-artifacts.ps1')
    const cli = read('apps/cli/src/index.ts')

    expect(unix.indexOf('preflight_previous_artifact "$SYSTEM_NAME"')).toBeLessThan(
      unix.lastIndexOf('run_macos_full_e2e'),
    )
    expect(unix.indexOf('preflight_previous_artifact "$SYSTEM_NAME"')).toBeLessThan(
      unix.lastIndexOf('run_current_container_smoke'),
    )
    expect(unix).toContain('CURRENT_ARTIFACT="$appimage"')
    expect(unix).toContain('DISPLAY="${DISPLAY:-}"')
    expect(unix).toContain('XAUTHORITY="${XAUTHORITY:-}"')
    expect(unix).toContain('Linux full E2E requires a runner-provided DISPLAY')
    expect(windows.indexOf('Get-NsisArtifactVersion $PreviousArtifact')).toBeLessThan(
      windows.indexOf('$env:LOCALAPPDATA = $testLocalAppData'),
    )
    expect(cli).not.toContain('POLO_AI_E2E_RUN_PROBE')
  })

  it('supports explicit local artifacts in the real Unix installer entry', () => {
    const installer = read('scripts/install-app.sh')

    expect(installer).toContain('POLO_AI_INSTALL_ARTIFACT')
    expect(installer).toContain('POLO_AI_INSTALL_DIR')
    expect(installer).toContain('POLO_AI_BIN_DIR')
    expect(installer).toContain('Using local install artifact')
  })

  it('builds and validates dependency-free sanitized CLI metadata', () => {
    const build = read('scripts/build-cli-artifacts.ts')
    const validate = read('scripts/validate-cli-artifacts.ts')
    const afterPack = read('apps/electron/scripts/afterPack.cjs')

    for (const source of [build, validate, afterPack]) {
      expect(source).toContain('dist/cli/package.json')
      expect(source).toContain('cliPackage')
    }
    expect(build).toContain("main: './polo-cli.js'")
    expect(build).toContain("license: sourceCliPackage.license")
    expect(validate).toContain("'dependencies' in cliPackage")
    expect(afterPack).toContain('allowedPackageKeys')
  })
})
