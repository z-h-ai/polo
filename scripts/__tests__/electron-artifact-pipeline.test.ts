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
    expect(hook).toContain("'notarytool', 'submit'")
    expect(hook).toContain("'stapler', 'staple'")
    expect(hook).toContain('outer macOS DMG')
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
    expect(validator).toContain('test_macos_settings_integration "$installed_app"')
    expect(validator).toContain('validate_legacy_app_bundle')
    expect(validator).toContain('previous ZIP preflight (POO-14)')
    expect(validator).toContain('previous AppImage preflight (POO-14)')
    expect(validator).toContain('app/dist/cli/artifact-manifest.json')
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
    expect(validator).toContain('linux-terminal-integration.sh')
    expect(validator).toContain('Pinned uv runtime manifest mismatch')
    expect(validator).toContain('mode=smoke acceptance=development-only')
    expect(validator).toContain('Full macOS validation requires the release Team ID')
    expect(validator).toContain('validate_macos_release_identity')
    expect(validator).toContain('validate_macos_dmg_release_identity')
    expect(validator).not.toContain('codesign --verify --strict "$dmg"')
    expect(validator).not.toContain('macos_team_id "$dmg"')
    expect(validator).toContain('A DMG is not a code object')
    expect(validator).toContain('spctl --assess --type open --context context:primary-signature')
    expect(validator).toContain('macOS DMG Gatekeeper assessment:')
    expect(validator).toContain('xcrun stapler validate "$dmg"')
    expect(validator).toContain('A valid stapled Apple ticket')
    expect(validator).toContain('verify-macos-dmg')
    expect(validator).toContain('--label "DMG outer"')
    expect(validator).toContain('codesign --verify --strict --deep "$app_bundle"')
    expect(validator).toContain('spctl --assess --type execute')
    expect(validator).toContain('xcrun stapler validate "$app_bundle"')
    expect(validator).toContain('release-signing-contract.ts')
    expect(validator).toContain('release-signing-audit-')
    expect(validator).toContain('polo --help')
    expect(validator).toContain('run_packaged_headless_lifecycle')
    expect(validator).toContain('--base-url')
    expect(validator).toContain("-C '$workspace' --verbose")
    expect(validator).not.toContain("--workspace-dir '$workspace'")
    expect(validator).toContain("'hello'")
    expect(validator).toContain('polo-run-server-*')
    expect(validator).not.toContain('POLO_AI_E2E_RUN_PROBE')
    expect(validator).toContain('polo app')
    expect(validator).toContain('POLO_AI_RUNTIME_DISCOVERY_FILE')
    expect(validator).toContain('launchctl setenv POLO_AI_RUNTIME_DISCOVERY_FILE')
    expect(validator).toContain('test "$focused_app_pid" = "$initial_app_pid"')
    expect(validator).toContain('wait_for_macos_frontmost_state "$initial_app_pid" "cold-launch" true')
    expect(validator).toContain('/usr/bin/open -a Finder "$test_home"')
    expect(validator).toContain('wait_for_macos_frontmost_state "$focused_app_pid" "second-polo-app-focus" true')
    expect(validator).toContain('transition=unavailable continuing=true')
    expect(validator).toContain('transition=restored')
    expect(validator).toContain('macos-focus-state phase=')
    expect(validator).toContain('macos-running-app-state.jxa')
    expect(validator).not.toContain('POLO_AI_E2E_DIRECT_APP')
    expect(validator).toContain('polo sessions')
    expect(validator).toContain('user-owned')
    expect(validator).toContain('"$shell_path" -lic "cd \\"\\$HOME\\"')
    expect(validator).toContain(
      'PATH="$installer_shim:/usr/bin:/bin:/usr/sbin:/sbin" \\\n    POLO_AI_INSTALL_ARTIFACT="$current_install"',
    )
    expect(validator).toContain(
      'PATH="/usr/bin:/bin:/usr/sbin:/sbin" \\\n    POLO_AI_TERMINAL_HOME="$integration_home"',
    )
    expect(validator).toContain('Packaged polo run failed:')
    expect(validator).toContain('cat "$run_output" >&2')
    expect(validator).toContain('macOS terminal integration install did not become ready:')
    expect(validator).toContain('macOS terminal integration uninstall left managed state:')
  })

  it('validates the installed NSIS container and real previous-to-current lifecycle', () => {
    const validator = read('apps/electron/scripts/validate-final-artifacts.ps1')
    const validatorBytes = readFileSync(join(root, 'apps/electron/scripts/validate-final-artifacts.ps1'))

    expect(validatorBytes.subarray(0, 3).toString('hex')).toBe('efbbbf')
    expect(validator).toContain('Full validation requires -PreviousArtifact')
    expect(validator).toContain('Invoke-Installer')
    expect(validator).toContain('Test-InstalledContainer')
    expect(validator).toContain('function Invoke-NsisProcess')
    expect(validator).toContain('terminal-integration.json')
    expect(validator).toContain('WaitForExit(180000)')
    expect(validator).toContain('NSIS $Label timed out after 180 seconds')
    expect(validator).toContain('terminal-integration-error.log')
    expect(validator).toContain('No terminal integration diagnostic was written.')
    expect(validator).toContain('function Stop-InstalledPoloApp')
    expect(validator).toContain('NSIS validation phase=desktop-app:stop')
    expect(validator).toContain('$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine")')
    expect(validator).toContain('-Label "conflict-installer" -UseCurrentPath')
    expect(validator).not.toContain('-PassThru -Wait -WindowStyle Hidden')
    const nsis = read('apps/electron/build/installer.nsh')
    expect(nsis).toContain('IfSilent polo_terminal_setup_silent_failure')
    expect(nsis).toContain('ReadEnvStr $R1 "LOCALAPPDATA"')
    expect(nsis).toContain('-BinDir "$R1\\Polo AI\\bin"')
    expect(nsis).toContain('SetErrorLevel 1')
    expect(nsis).toContain('Quit')
    expect(nsis).toContain('IfSilent polo_terminal_uninstall_silent_failure')
    expect(nsis).not.toContain('polo_terminal_uninstall_finished')
    const terminalIntegration = read('apps/electron/resources/scripts/windows-terminal-integration.ps1')
    expect(terminalIntegration).toContain('terminal-integration-error.log')
    expect(terminalIntegration).toContain('The original terminal integration error remains authoritative.')
    expect(terminalIntegration).toContain('bool hasExpectedValue')
    expect(terminalIntegration).toContain('if (hasExpectedValue &&')
    expect(terminalIntegration).toContain('$hasExpectedValue = $null -ne $ExpectedValue')
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
    expect(validator).toContain('Full Windows validation requires the release Publisher')
    expect(validator).toContain('Assert-ReleaseAuthenticodeIdentity')
    expect(validator).toContain('release-signing-contract.ts')
    expect(validator).toContain('release-signing-audit-Windows.jsonl')
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

  it('defines a reusable blocking four-platform release build with an unsigned manual Windows installer', () => {
    const workflow = read('.github/workflows/electron-artifact-full.yml')
    const releaseWorkflow = read('.github/workflows/electron-release.yml')
    const scheduledWorkflow = read('.github/workflows/electron-scheduled-validation.yml')

    expect(workflow).toContain('workflow_call:')
    expect(workflow).not.toContain('release:\n    types:')
    expect(releaseWorkflow).toContain('tags:')
    expect(scheduledWorkflow).toContain('schedule:')
    expect(scheduledWorkflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('previous_release_tag:')
    expect(workflow).toContain('previous_release_version:')
    expect(workflow).toContain('previous_release_commit_sha:')
    expect(workflow).toContain('previous_macos_sha256:')
    expect(workflow).not.toContain('previous_windows_sha256:')
    expect(workflow).toContain('previous_linux_sha256:')
    expect(workflow).toContain('previous_installer_sha256:')
    expect(workflow).toContain('EXPECTED_PREVIOUS_ARTIFACT_SHA256')
    expect(workflow).toContain("inputs.bootstrap && 'bootstrap' || 'full'")
    expect(workflow).toContain('POLO_AI_PREVIOUS_ARTIFACT:')
    expect(workflow).toContain('POLO_AI_PREVIOUS_INSTALL_SCRIPT:')
    expect(workflow).toContain('runner: macos-15-intel')
    expect(workflow).toContain('runner: macos-15')
    expect(workflow).toContain('runner: windows-latest')
    expect(workflow).toContain('runner: ubuntu-latest')
    const unixPreviousPreflight = read('scripts/preflight-previous-release.sh')
    expect(workflow).toContain('preflight-previous-release.sh')
    expect(unixPreviousPreflight).toContain('gh release download')
    expect(unixPreviousPreflight).toContain('--repo "$GITHUB_REPOSITORY"')
    expect(unixPreviousPreflight).toContain('application/vnd.github.raw+json')
    expect(workflow).toContain('validate-previous-release-contract.ts')
    expect(workflow).toContain('verified-contract-${{ matrix.platform }}.json')
    expect(unixPreviousPreflight).toContain('Previous release version must differ from current')
    expect(unixPreviousPreflight).toContain('is_semver')
    const semverPattern = read('scripts/strict-semver-pattern.txt').trim()
    expect(semverPattern.startsWith('^')).toBe(true)
    expect(semverPattern.endsWith('$')).toBe(true)
    for (const consumer of [unixPreviousPreflight]) {
      expect(consumer).toContain('strict-semver-pattern.txt')
    }
    expect(read('scripts/strict-semver.ts')).toContain(
      "'./strict-semver-pattern.txt'",
    )
    expect(read('scripts/validate-previous-release-contract.ts')).toContain(
      "from './strict-semver'",
    )
    expect(workflow).not.toContain("semver_pattern='^")
    expect(workflow).not.toContain('v[0-9]*.[0-9]*.[0-9]*)')
    expect(workflow).toContain('windows-terminal-integration.test.ps1')
    expect(workflow).not.toContain('windows-terminal-integration-race.test.ps1')
    expect(workflow).toContain('POLO_AI_RELEASE_MACOS_TEAM_ID')
    expect(workflow).toContain('POLO_AI_RELEASE_MACOS_APP_REQUIREMENT')
    expect(workflow).toContain('POLO_AI_RELEASE_MACOS_UV_REQUIREMENT')
    expect(workflow).not.toContain('POLO_AI_RELEASE_WINDOWS_PUBLISHER')
    expect(workflow).not.toContain('POLO_AI_RELEASE_WINDOWS_THUMBPRINT')
    expect(workflow).toContain('secrets.macos_csc_link')
    expect(workflow).not.toContain('secrets.windows_csc_link')
    expect(workflow).toContain('electron:dist:mac --arch=${{ matrix.arch }}')
    expect(workflow).toContain('manual_installer: Polo-AI-x64.dmg')
    expect(workflow).toContain('manual_installer: Polo-AI-arm64.dmg')
    expect(workflow).toContain('manual_installer: Polo-AI-x64.exe')
    expect(workflow).toContain('updater: false')
    expect(workflow).toContain("matrix.platform == 'macos' && matrix.arch == 'arm64' && 'signing'")
    expect(workflow).toContain("matrix.updater && (inputs.bootstrap && 'bootstrap' || 'full') || 'smoke'")
    expect(workflow).toContain('Require macOS Developer ID signing audit')
    expect(workflow).toContain('release-signing-audit-macos-${{ matrix.arch }}.jsonl')
    expect(workflow).toContain('"label":"DMG"')
    expect(workflow).toContain('"label":"DMG outer"')
    expect(workflow).toContain('"label":"ZIP"')
    expect(workflow).toContain('electron:dist:win --arch=x64')
    expect(workflow).toContain('Get-AuthenticodeSignature')
    expect(workflow).toContain("$signature.Status -ne 'NotSigned'")
    expect(workflow).toContain('Upload Windows manual installer')
    expect(workflow).toContain('if: matrix.updater')
    expect(workflow).toContain('electron:dist:linux --arch=x64')
    expect(workflow).not.toContain('electron:dist:dev:mac --arch=x64')
    expect(workflow).not.toContain('electron:dist:dev:linux --arch=x64')
    expect(workflow).toContain('prepare-platform-runtime.test.ts')
    expect(workflow).toContain('test ! -e apps/electron/vendor/bun')
    expect(workflow).toContain("find apps/electron/resources/bin -maxdepth 2 -type f -name 'uv*'")
    expect(workflow).toContain('windows-wrapper-smoke.test.ps1')
    expect(workflow).toContain('windows-terminal-integration.test.ps1')
    expect(workflow).toContain('shell: powershell')
    expect(workflow).toContain('Smoke Windows PowerShell installer compatibility')
    expect(workflow).toContain('PowerShell 7-only pass cannot hide an installer failure')
    expect(workflow).toContain('Parse Windows final artifact validator with Windows PowerShell')
    expect(workflow).toContain('[System.Management.Automation.Language.Parser]::ParseFile')
    const wrapperSmoke = read('apps/electron/resources/scripts/tests/windows-wrapper-smoke.test.ps1')
    expect(wrapperSmoke).toContain('Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe')
    expect(wrapperSmoke).toContain('/target:exe')
    expect(wrapperSmoke).not.toContain('-OutputType ConsoleApplication')
    expect(wrapperSmoke).toContain('ConvertFrom-Base64Utf8')
    expect(wrapperSmoke).toContain('[Convert]::FromBase64String')
    expect(wrapperSmoke).not.toContain("$source = @'")
    expect(wrapperSmoke).toContain('[switch]$AsciiOnly')
    expect(wrapperSmoke).toContain('$fixtureInvocationArgument')
    expect(wrapperSmoke).toContain('$rootPathLabel')
    expect(wrapperSmoke).toContain('Invoke-CapturedNativeCommand')
    expect(wrapperSmoke).toContain('$global:LASTEXITCODE = 0')
    expect(workflow.indexOf('Smoke Windows terminal launchers')).toBeLessThan(
      workflow.indexOf('Build and validate unsigned Windows release'),
    )
    expect(workflow).toContain('xvfb-run -a')
    expect(workflow).toContain('full-validation-macos-${{ matrix.arch }}.log')
    expect(workflow).toContain('full-validation-windows-x64.log')
    expect(workflow).toContain('full-validation-linux.log')
    expect(workflow).toContain('release-signing-audit-*.jsonl')
    expect(workflow).toContain('actions/upload-artifact@v4')
    expect(workflow).not.toContain('bun run validate:ci')
    expect(read('scripts/prepare-platform-runtime.ts')).toContain('buildMcpServers(config)')
    const macValidator = read('apps/electron/scripts/validate-final-artifacts.sh')
    expect(macValidator).toContain('"$MODE" != "signing"')
    expect(macValidator).toContain('platform=macos mode=$MODE')
  })

  it('verifies immutable previous assets before every setup or install write', () => {
    const workflow = read('.github/workflows/electron-artifact-full.yml')
    const unixPreflight = workflow.indexOf(
      'Verify and download previous release',
    )
    const setupBun = workflow.indexOf('- name: Setup Bun')
    const setupUv = workflow.indexOf('- name: Install uv')
    const apt = workflow.indexOf('- name: Install Linux GUI dependencies')
    const installDependencies = workflow.indexOf('- name: Install dependencies')

    for (const preflight of [unixPreflight]) {
      expect(preflight).toBeGreaterThan(0)
      expect(preflight).toBeLessThan(setupBun)
      expect(preflight).toBeLessThan(setupUv)
      expect(preflight).toBeLessThan(apt)
      expect(preflight).toBeLessThan(installDependencies)
    }
    expect(workflow.indexOf('preflight-previous-release.sh')).toBeLessThan(setupBun)

    const unix = read('scripts/preflight-previous-release.sh')
    for (const contract of [unix]) {
      expect(contract).toContain('PREVIOUS_RELEASE_COMMIT_SHA')
      expect(contract).toContain('EXPECTED_PREVIOUS_ARTIFACT_SHA256')
      expect(contract).toContain('gh release download')
      expect(contract).toContain('Previous release version must differ')
      expect(contract.toLowerCase()).not.toContain('setup-bun')
      expect(contract).not.toMatch(/\bbun\b/)
    }
    expect(unix).toContain('EXPECTED_PREVIOUS_INSTALLER_SHA256')
    expect(unix).toContain('application/vnd.github.raw+json')
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
    expect(unix.indexOf('Full macOS validation requires the release Team ID')).toBeLessThan(
      unix.indexOf('TEMP_ROOT="$(mktemp -d'),
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
    expect(windows.indexOf('Full Windows validation requires the release Publisher')).toBeLessThan(
      windows.indexOf('$testRoot = Join-Path'),
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
    expect(installer).toContain('linux-terminal-integration.sh')
    expect(installer).toContain('--appimage-extract')
    expect(installer).not.toContain("cat > \"$WRAPPER_TMP\"")
    expect(installer).not.toContain('exec "$APPIMAGE_PATH" --no-sandbox --polo-cli')
  })

  it('keeps the immutable predecessor installer independent from runner-provided yq', () => {
    const validator = read('apps/electron/scripts/validate-final-artifacts.sh')

    expect(validator).toContain('local bash_env="$shim_dir/bash-env"')
    expect(validator).toContain('if [ "$#" -eq 2 ] && [ "$1" = "-v" ] && [ "$2" = "yq" ]; then')
    expect(validator).toContain('BASH_ENV="$bash_env"')
    expect(validator).toContain('write_installer_process_shim')
    expect(validator).toContain('[ "$2" = "Polo-AI.*AppImage" ]')
  })

  it('exercises the POO-14 predecessor terminal links before upgrading them', () => {
    const validator = read('apps/electron/scripts/validate-final-artifacts.sh')
    const linuxLifecycle = validator.slice(validator.indexOf('run_linux_full_e2e()'))
    const macosLifecycle = validator.slice(
      validator.indexOf('run_macos_full_e2e()'),
      validator.indexOf('test_linux_command_conflict()'),
    )

    expect(linuxLifecycle).toContain('test -L "$launcher"')
    expect(linuxLifecycle).not.toContain('test ! -e "$launcher"')
    expect(macosLifecycle).toContain('test -L "$launcher"')
    expect(macosLifecycle).not.toContain('test ! -e "$launcher"')
    expect(linuxLifecycle).toContain('PATH="$installer_shim:/usr/bin:/bin:/usr/sbin:/sbin"')
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
    expect(afterPack).toContain('linux-terminal-integration.sh')
  })
})
