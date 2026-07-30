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
    expect(validator).toContain('--polo-terminal-integration uninstall')
    expect(validator).toContain('validate_legacy_app_bundle')
    expect(validator).toContain('validate-legacy-electron-layout.ts')
    expect(validator).toContain('legacy container contract passed')
    expect(validator).toContain('POLO_AI_PREVIOUS_INSTALL_SCRIPT')
    expect(validator).toContain('run_previous_release_installer')
    expect(validator).toContain('bash "$PREVIOUS_INSTALL_SCRIPT"')
    expect(validator).toContain('POLO_AI_LEGACY_ARTIFACT')
    expect(validator).toContain('Previous artifact version must differ')
    expect(validator).toContain('"$uv" --version')
    expect(validator).toContain('runtime-manifest.json')
    expect(validator).toContain('uv-runtime-lock.json')
    expect(validator).toContain('Pinned uv runtime manifest mismatch')
    expect(validator).toContain('codesign --verify --strict "$uv"')
    expect(validator).toContain('polo --help')
    expect(validator).toContain('run_packaged_headless_lifecycle')
    expect(validator).toContain('--base-url')
    expect(validator).toContain("'hello'")
    expect(validator).toContain('polo-run-server-*')
    expect(validator).not.toContain('POLO_AI_E2E_RUN_PROBE')
    expect(validator).toContain('polo app')
    expect(validator).toContain('POLO_AI_RUNTIME_DISCOVERY_FILE')
    expect(validator).toContain('launchctl setenv POLO_AI_RUNTIME_DISCOVERY_FILE')
    expect(validator).toContain('test "$focused_app_pid" = "$initial_app_pid"')
    expect(validator).toContain('wait_for_macos_frontmost_state "$initial_app_pid" "cold-launch" true')
    expect(validator).toContain('wait_for_macos_frontmost_state "$focused_app_pid" "second-polo-app-focus" true')
    expect(validator).toContain('macos-focus-state phase=')
    expect(validator).toContain('macos-running-app-state.jxa')
    expect(validator).not.toContain('POLO_AI_E2E_DIRECT_APP')
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
    expect(validator).toContain('Get-LegacyNsisArtifactVersion')
    expect(validator).toContain('Get-CurrentNsisArtifactVersion')
    expect(validator).toContain('Test-LegacyInstalledContainer')
    expect(validator).toContain('validate-legacy-electron-layout.ts')
    expect(validator).toContain('Read-only NSIS lifecycle preflight passed')
    expect(validator).toContain('polo --help')
    expect(validator).toContain('Invoke-PackagedRunLifecycle')
    expect(validator).toContain('--base-url')
    expect(validator).toContain('polo app')
    expect(validator).toContain('artifact-manifest.json')
    expect(validator).toContain('uv runtime smoke failed')
    expect(validator).toContain('runtime-manifest.json')
    expect(validator).toContain('uv-runtime-lock.json')
    expect(validator).toContain('pinned uv runtime manifest')
    expect(validator).toContain('Get-AuthenticodeSignature -LiteralPath $uvPath')
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
    expect(workflow).toContain('previous_release_version:')
    expect(workflow).toContain('previous_release_commit_sha:')
    expect(workflow).toContain('previous_macos_sha256:')
    expect(workflow).toContain('previous_windows_sha256:')
    expect(workflow).toContain('previous_linux_sha256:')
    expect(workflow).toContain('previous_installer_sha256:')
    expect(workflow).toContain('POLO_AI_FULL_E2E_PREVIOUS_RELEASE_TAG')
    expect(workflow).toContain('POLO_AI_FULL_E2E_PREVIOUS_RELEASE_COMMIT_SHA')
    expect(workflow).toContain('EXPECTED_PREVIOUS_ARTIFACT_SHA256')
    expect(workflow).toContain('POLO_AI_ARTIFACT_VALIDATION_MODE: full')
    expect(workflow).toContain('POLO_AI_PREVIOUS_ARTIFACT:')
    expect(workflow).toContain('POLO_AI_PREVIOUS_INSTALL_SCRIPT:')
    expect(workflow).toContain('runner: macos-14')
    expect(workflow).toContain('runner: windows-latest')
    expect(workflow).toContain('runner: ubuntu-latest')
    expect(workflow).toContain('gh release download')
    expect(workflow).toContain('--repo "$GITHUB_REPOSITORY"')
    expect(workflow).toContain('application/vnd.github.raw+json')
    expect(workflow).toContain('validate-previous-release-contract.ts')
    expect(workflow).toContain('verified-contract-${{ matrix.platform }}.json')
    expect(workflow).toContain('Previous release version must differ from current')
    expect(workflow).toContain('windows-terminal-integration.test.ps1')
    expect(workflow).toContain('electron:dist:dev:mac')
    expect(workflow).toContain('electron:dist:dev:win')
    expect(workflow).toContain('electron:dist:dev:linux')
    expect(workflow).toContain('prepare-platform-runtime.test.ts')
    expect(workflow).toContain('test ! -e apps/electron/vendor/bun')
    expect(workflow).toContain("find apps/electron/resources/bin -maxdepth 2 -type f -name 'uv*'")
    expect(workflow).toContain('windows-wrapper-smoke.test.ps1')
    expect(workflow).toContain('xvfb-run -a')
    expect(workflow).toContain('full-validation-macos.log')
    expect(workflow).toContain('full-validation-windows.log')
    expect(workflow).toContain('full-validation-linux.log')
    expect(workflow).toContain('previous_artifact_sha256=')
    expect(workflow).toContain('actions/upload-artifact@v4')
    expect(workflow).not.toContain('bun run validate:ci')
    expect(read('scripts/prepare-platform-runtime.ts')).toContain('buildMcpServers(config)')
  })

  it('routes every formal and legacy dist entry through target-aware runtime preparation', () => {
    const rootPackage = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
    }
    const electronPackage = JSON.parse(read('apps/electron/package.json')) as {
      scripts: Record<string, string>
    }
    const distEntry = read('scripts/electron-dist.ts')

    for (const name of [
      'electron:dist',
      'electron:dist:mac',
      'electron:dist:win',
      'electron:dist:linux',
      'electron:dist:dev:mac',
      'electron:dist:dev:win',
      'electron:dist:dev:linux',
    ]) {
      expect(rootPackage.scripts[name]).toContain('scripts/electron-dist.ts')
    }
    for (const name of ['dist:mac', 'dist:mac:x64', 'dist:win', 'dist:linux']) {
      expect(electronPackage.scripts[name]).toContain('scripts/electron-dist.ts')
    }
    for (const legacy of [
      'apps/electron/scripts/build-dmg.sh',
      'apps/electron/scripts/build-linux.sh',
      'apps/electron/scripts/build-win.ps1',
    ]) {
      expect(read(legacy).replaceAll('\\', '/')).toContain('scripts/electron-dist.ts')
      expect(read(legacy)).not.toContain('electron-builder')
    }
    expect(distEntry.indexOf('prepareRuntime(runtimeOptions)')).toBeLessThan(
      distEntry.indexOf('dependencies.build(options, env)'),
    )
    expect(distEntry.indexOf('dependencies.build(options, env)')).toBeLessThan(
      distEntry.indexOf('dependencies.stageHelpers(runtimeOptions)'),
    )
    expect(distEntry.indexOf('dependencies.stageHelpers(runtimeOptions)')).toBeLessThan(
      distEntry.indexOf('dependencies.package(options, env)'),
    )
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
    expect(windows.indexOf('Get-LegacyNsisArtifactVersion $PreviousArtifact')).toBeLessThan(
      windows.indexOf('$env:LOCALAPPDATA = $testLocalAppData'),
    )
    expect(cli).not.toContain('POLO_AI_E2E_RUN_PROBE')
    expect(cli).not.toContain('POLO_AI_E2E_DIRECT_APP')
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
    const beforePack = read('apps/electron/scripts/beforePack.cjs')

    for (const source of [build, validate, afterPack]) {
      expect(source).toContain('dist/cli/package.json')
      expect(source).toContain('cliPackage')
    }
    expect(build).toContain("main: './polo-cli.js'")
    expect(build).toContain("license: sourceCliPackage.license")
    expect(validate).toContain("'dependencies' in cliPackage")
    expect(afterPack).toContain('allowedPackageKeys')
    for (const source of [beforePack, afterPack]) {
      expect(source).toContain('runtime-manifest.json')
      expect(source).toContain('uv-runtime-lock.json')
      expect(source).toContain('binarySha256')
      expect(source).toContain('astral-sh-release')
    }
  })
})
