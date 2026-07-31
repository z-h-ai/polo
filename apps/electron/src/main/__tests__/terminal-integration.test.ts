import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getTerminalIntegrationStatus,
  installTerminalIntegration,
  TerminalIntegrationOperationError,
  toTerminalIntegrationErrorPayload,
  uninstallTerminalIntegration,
  type TerminalIntegrationOptions,
} from '../terminal-integration'

const roots: string[] = []

function setup(shell = '/bin/zsh'): TerminalIntegrationOptions {
  const root = join(tmpdir(), `polo-terminal-test-${crypto.randomUUID()}`)
  const home = join(root, 'home')
  const resources = join(root, 'Polo AI.app', 'Contents', 'Resources')
  roots.push(root)
  mkdirSync(join(resources, 'vendor', 'bun'), { recursive: true })
  mkdirSync(join(resources, 'app', 'dist', 'cli'), { recursive: true })
  mkdirSync(join(resources, 'app', 'dist', 'server'), { recursive: true })
  mkdirSync(join(resources, 'app', 'resources', 'bin'), { recursive: true })
  writeFileSync(join(resources, 'vendor', 'bun', 'bun'), '')
  writeFileSync(join(resources, 'app', 'dist', 'cli', 'polo-cli.js'), '')
  writeFileSync(join(resources, 'app', 'dist', 'server', 'polo-server.js'), '')
  const packagedLauncher = join(resources, 'app', 'resources', 'bin', 'polo')
  writeFileSync(packagedLauncher, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const launcherPath = join(home, '.local', 'bin', 'polo')
  return {
    platform: 'darwin',
    homeDir: home,
    shell,
    resourcesPath: resources,
    appExecutable: join(root, 'Polo AI.app', 'Contents', 'MacOS', 'Polo AI'),
    appVersion: '0.10.0',
    commandLookup: () => existsSync(launcherPath) ? launcherPath : null,
    commandValidator: () => ({ ok: true, output: '0.10.0' }),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('macOS terminal integration', () => {
  it('installs an idempotent managed launcher and PATH block', () => {
    const options = setup()
    const first = installTerminalIntegration(options)
    const profile = first.profilePath!
    const firstProfile = readFileSync(profile, 'utf8')
    const firstLauncher = readFileSync(first.launcherPath, 'utf8')

    const second = installTerminalIntegration(options)
    expect(readFileSync(profile, 'utf8')).toBe(firstProfile)
    expect(readFileSync(second.launcherPath, 'utf8')).toBe(firstLauncher)
    expect(firstProfile.match(/# >>> Polo CLI >>>/g)?.length).toBe(1)
    expect(lstatSync(second.launcherPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(second.launcherPath)).toBe(
      join(options.resourcesPath, 'app', 'resources', 'bin', 'polo'),
    )
    expect(second.installed).toBe(true)
    expect(second.pathReady).toBe(true)
    expect(JSON.parse(readFileSync(
      join(options.homeDir!, '.polo-ai', 'terminal-integration.json'),
      'utf8',
    ))).toMatchObject({
      schemaVersion: 3,
      owner: 'com.poloai.terminal-integration',
      launcherFormat: 'managed-symlink-v1',
      appVersion: '0.10.0',
      launcherPath: second.launcherPath,
      launcherTarget: second.launcherTarget,
    })
  })

  it('backs up and preserves existing shell configuration', () => {
    const options = setup('/bin/bash')
    const profile = join(options.homeDir!, '.bash_profile')
    mkdirSync(options.homeDir!, { recursive: true })
    writeFileSync(profile, 'export EDITOR=vim\n')

    installTerminalIntegration(options)
    const next = readFileSync(profile, 'utf8')
    expect(next).toContain('export EDITOR=vim')
    expect(next).toContain('# >>> Polo CLI >>>')
    const backups = readdirSync(options.homeDir!).filter((name) =>
      name.startsWith('.bash_profile.polo-backup-'))
    expect(backups.length).toBe(1)
  })

  it('rejects a user-owned shell-profile symlink without changing its target', () => {
    const options = setup()
    const profile = join(options.homeDir!, '.zprofile')
    const userProfile = join(options.homeDir!, 'user-zprofile')
    mkdirSync(options.homeDir!, { recursive: true })
    writeFileSync(userProfile, 'export USER_PROFILE=1\n')
    symlinkSync(userProfile, profile)

    const status = installTerminalIntegration(options)

    expect(status.conflict).toEqual({ code: 'profile_conflict', path: profile })
    expect(lstatSync(profile).isSymbolicLink()).toBe(true)
    expect(readlinkSync(profile)).toBe(userProfile)
    expect(readFileSync(userProfile, 'utf8')).toBe('export USER_PROFILE=1\n')
  })

  it('preserves macOS shell profiles across regular, symlink, rename, and content races', () => {
    for (const race of [
      'regular_publish',
      'symlink_publish',
      'rename_claim',
      'content_claim',
    ] as const) {
      const options = setup()
      const profile = join(options.homeDir!, '.zprofile')
      const original = 'export ORIGINAL_PROFILE=1\n'
      const userContent = `export USER_${race.toUpperCase()}=1\n`
      const movedOriginal = join(options.homeDir!, `moved-${race}`)
      const userTarget = join(options.homeDir!, `user-target-${race}`)
      mkdirSync(options.homeDir!, { recursive: true })
      writeFileSync(profile, original)
      writeFileSync(userTarget, userContent)
      options.onBeforeTransactionStep = (step, path) => {
        if (path !== profile) return
        if (race === 'regular_publish' && step === 'profile_publish') {
          writeFileSync(profile, userContent)
        }
        if (race === 'symlink_publish' && step === 'profile_publish') {
          symlinkSync(userTarget, profile)
        }
        if (race === 'rename_claim' && step === 'profile_claim') {
          renameSync(profile, movedOriginal)
          writeFileSync(profile, userContent)
        }
        if (race === 'content_claim' && step === 'profile_claim') {
          writeFileSync(profile, userContent)
        }
      }

      let thrown: unknown
      try {
        installTerminalIntegration(options)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(TerminalIntegrationOperationError)
      expect(toTerminalIntegrationErrorPayload(thrown, 'install')).toEqual({
        errorCode: 'install_failed',
        errorParams: { operation: 'install' },
      })
      expect(existsSync(join(options.homeDir!, '.local', 'bin', 'polo'))).toBe(false)
      if (race === 'symlink_publish') {
        expect(lstatSync(profile).isSymbolicLink()).toBe(true)
        expect(readlinkSync(profile)).toBe(userTarget)
        expect(readFileSync(userTarget, 'utf8')).toBe(userContent)
      } else {
        expect(readFileSync(profile, 'utf8')).toBe(userContent)
      }
      if (race === 'rename_claim') {
        expect(readFileSync(movedOriginal, 'utf8')).toBe(original)
      }
      if (race.endsWith('publish')) {
        const backups = readdirSync(options.homeDir!).filter((name) =>
          name.startsWith('.zprofile.polo-backup-'))
        expect(backups).toHaveLength(1)
        expect(readFileSync(join(options.homeDir!, backups[0]!), 'utf8')).toBe(original)
      }
    }
  })

  it('keeps the managed launcher current across app version upgrades', () => {
    const options = setup()
    installTerminalIntegration(options)

    const upgraded = {
      ...options,
      appVersion: '0.11.0',
      commandValidator: () => ({ ok: true, output: '0.11.0' }),
    }
    const status = getTerminalIntegrationStatus(upgraded)
    expect(status.installed).toBe(true)
    expect(status.needsRepair).toBe(false)
  })

  it('repairs a managed symlink after the app bundle moves', () => {
    const options = setup()
    const installed = installTerminalIntegration(options)
    const movedRoot = join(dirname(dirname(dirname(options.resourcesPath))), 'Polo Moved.app')
    const movedResources = join(movedRoot, 'Contents', 'Resources')
    mkdirSync(join(movedResources, 'app', 'resources', 'bin'), { recursive: true })
    const movedLauncher = join(movedResources, 'app', 'resources', 'bin', 'polo')
    writeFileSync(movedLauncher, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    rmSync(dirname(dirname(options.resourcesPath)), { recursive: true, force: true })
    const movedOptions = {
      ...options,
      resourcesPath: movedResources,
    }

    const beforeRepair = getTerminalIntegrationStatus(movedOptions)
    expect(beforeRepair.installed).toBe(true)
    expect(beforeRepair.needsRepair).toBe(true)

    const repaired = installTerminalIntegration(movedOptions)
    expect(repaired.pathReady).toBe(true)
    expect(readlinkSync(installed.launcherPath)).toBe(movedLauncher)
  })

  it('requires the managed launcher to remain executable', () => {
    const options = setup()
    const installed = installTerminalIntegration(options)
    chmodSync(installed.launcherPath, 0o644)

    const status = getTerminalIntegrationStatus(options)
    expect(status.installed).toBe(true)
    expect(status.pathReady).toBe(false)
    expect(status.needsRepair).toBe(true)

    chmodSync(installed.launcherTarget!, 0o755)
    const repaired = installTerminalIntegration(options)
    expect(repaired.pathReady).toBe(true)
    expect(repaired.needsRepair).toBe(false)
  })

  it('requires the exact managed PATH block content', () => {
    const options = setup()
    const installed = installTerminalIntegration(options)
    const invalidBlock = [
      '# >>> Polo CLI >>>',
      'export PATH="/tmp/not-polo:$PATH"',
      '# <<< Polo CLI <<<',
      '',
    ].join('\n')
    writeFileSync(installed.profilePath!, invalidBlock)

    const status = getTerminalIntegrationStatus(options)
    expect(status.installed).toBe(true)
    expect(status.pathReady).toBe(false)
    expect(status.needsRepair).toBe(true)

    const repaired = installTerminalIntegration(options)
    expect(repaired.pathReady).toBe(true)
    expect(repaired.needsRepair).toBe(false)
    expect(readFileSync(installed.profilePath!, 'utf8')).toContain(
      'export PATH="$HOME/.local/bin:$PATH"',
    )
  })

  it('marks command validation failures for repair', () => {
    const options = setup()
    installTerminalIntegration(options)
    options.commandValidator = () => ({ ok: false })

    const status = getTerminalIntegrationStatus(options)
    expect(status.pathReady).toBe(false)
    expect(status.needsRepair).toBe(true)
  })

  it('does not overwrite an existing non-Polo launcher', () => {
    const options = setup()
    const launcher = join(options.homeDir!, '.local', 'bin', 'polo')
    mkdirSync(join(launcher, '..'), { recursive: true })
    writeFileSync(launcher, '#!/bin/sh\necho other\n')

    const status = installTerminalIntegration(options)
    expect(status.conflict).toEqual({
      code: 'launcher_conflict',
      path: launcher,
    })
    expect(readFileSync(launcher, 'utf8')).toContain('echo other')
  })

  it('does not overwrite a regular file or symlink created after launcher validation', () => {
    for (const kind of ['regular', 'symlink'] as const) {
      const options = setup()
      const launcher = join(options.homeDir!, '.local', 'bin', 'polo')
      const userTarget = join(options.homeDir!, `user-polo-${kind}`)
      const userContent = `#!/bin/sh\necho ${kind}-user-command\n`
      mkdirSync(dirname(launcher), { recursive: true })
      writeFileSync(userTarget, userContent, { mode: 0o755 })
      options.onBeforeTransactionStep = (step, path) => {
        if (step !== 'launcher_publish' || path !== launcher) return
        if (kind === 'regular') {
          writeFileSync(launcher, userContent, { mode: 0o755 })
        } else {
          symlinkSync(userTarget, launcher)
        }
      }

      const status = installTerminalIntegration(options)

      expect(status.conflict).toEqual({ code: 'launcher_conflict', path: launcher })
      expect(existsSync(join(options.homeDir!, '.polo-ai', 'terminal-integration.json'))).toBe(false)
      if (kind === 'regular') {
        expect(lstatSync(launcher).isSymbolicLink()).toBe(false)
        expect(readFileSync(launcher, 'utf8')).toBe(userContent)
      } else {
        expect(lstatSync(launcher).isSymbolicLink()).toBe(true)
        expect(readlinkSync(launcher)).toBe(userTarget)
        expect(readFileSync(userTarget, 'utf8')).toBe(userContent)
      }
    }
  })

  it('restores an existing launcher race without replacing the user command', () => {
    for (const kind of ['regular', 'symlink'] as const) {
      const options = setup()
      const installed = installTerminalIntegration(options)
      const movedResources = join(
        dirname(dirname(dirname(options.resourcesPath))),
        `Polo Launcher Race ${kind}.app`,
        'Contents',
        'Resources',
      )
      const movedTarget = join(movedResources, 'app', 'resources', 'bin', 'polo')
      mkdirSync(dirname(movedTarget), { recursive: true })
      writeFileSync(movedTarget, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const userTarget = join(options.homeDir!, `racing-user-polo-${kind}`)
      const userContent = `#!/bin/sh\necho replacement-${kind}\n`
      writeFileSync(userTarget, userContent, { mode: 0o755 })
      const racedOptions: TerminalIntegrationOptions = {
        ...options,
        resourcesPath: movedResources,
        onBeforeTransactionStep: (step, path) => {
          if (step !== 'launcher_claim' || path !== installed.launcherPath) return
          rmSync(path)
          if (kind === 'regular') {
            writeFileSync(path, userContent, { mode: 0o755 })
          } else {
            symlinkSync(userTarget, path)
          }
        },
      }

      let thrown: unknown
      try {
        installTerminalIntegration(racedOptions)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(TerminalIntegrationOperationError)
      if (kind === 'regular') {
        expect(readFileSync(installed.launcherPath, 'utf8')).toBe(userContent)
      } else {
        expect(lstatSync(installed.launcherPath).isSymbolicLink()).toBe(true)
        expect(readlinkSync(installed.launcherPath)).toBe(userTarget)
      }
      expect(readFileSync(userTarget, 'utf8')).toBe(userContent)
    }
  })

  it('does not own or uninstall a user-created symlink to the packaged target', () => {
    const options = setup()
    const launcher = join(options.homeDir!, '.local', 'bin', 'polo')
    const target = join(options.resourcesPath, 'app', 'resources', 'bin', 'polo')
    mkdirSync(dirname(launcher), { recursive: true })
    symlinkSync(target, launcher)

    const before = getTerminalIntegrationStatus(options)
    expect(before.installed).toBe(false)
    expect(before.conflict).toEqual({ code: 'launcher_conflict', path: launcher })

    const after = uninstallTerminalIntegration(options)
    expect(lstatSync(launcher).isSymbolicLink()).toBe(true)
    expect(readlinkSync(launcher)).toBe(target)
    expect(after.conflict).toEqual({ code: 'launcher_conflict', path: launcher })
  })

  it('preserves the launcher when ownership state is missing or corrupt', () => {
    for (const stateContent of [null, '{broken json', '{"schemaVersion":2}']) {
      const options = setup()
      const installed = installTerminalIntegration(options)
      const state = join(options.homeDir!, '.polo-ai', 'terminal-integration.json')
      if (stateContent === null) {
        rmSync(state)
      } else {
        writeFileSync(state, stateContent)
      }

      uninstallTerminalIntegration(options)
      expect(lstatSync(installed.launcherPath).isSymbolicLink()).toBe(true)
      if (stateContent !== null) {
        expect(readFileSync(state, 'utf8')).toBe(stateContent)
      }
    }
  })

  it('preserves the launcher when the recorded ownership identity is tampered', () => {
    const options = setup()
    const installed = installTerminalIntegration(options)
    const statePath = join(options.homeDir!, '.polo-ai', 'terminal-integration.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
    writeFileSync(statePath, `${JSON.stringify({
      ...state,
      launcherIdentity: '0'.repeat(64),
    })}\n`)

    const status = uninstallTerminalIntegration(options)
    expect(lstatSync(installed.launcherPath).isSymbolicLink()).toBe(true)
    expect(status.conflict).toEqual({
      code: 'launcher_conflict',
      path: installed.launcherPath,
    })
    expect(existsSync(statePath)).toBe(true)
  })

  it('preserves a managed path whose symlink identity was replaced by the user', () => {
    const options = setup()
    const installed = installTerminalIntegration(options)
    const userTarget = join(options.homeDir!, 'user-polo')
    writeFileSync(userTarget, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    rmSync(installed.launcherPath)
    symlinkSync(userTarget, installed.launcherPath)

    uninstallTerminalIntegration(options)
    expect(readlinkSync(installed.launcherPath)).toBe(userTarget)
  })

  it('does not delete a user command that races a managed launcher uninstall', () => {
    for (const kind of ['regular', 'symlink'] as const) {
      const options = setup()
      const installed = installTerminalIntegration(options)
      const userTarget = join(options.homeDir!, `uninstall-user-polo-${kind}`)
      const userContent = `#!/bin/sh\necho uninstall-${kind}\n`
      writeFileSync(userTarget, userContent, { mode: 0o755 })
      options.onBeforeTransactionStep = (step, path) => {
        if (step !== 'launcher_claim' || path !== installed.launcherPath) return
        rmSync(path)
        if (kind === 'regular') {
          writeFileSync(path, userContent, { mode: 0o755 })
        } else {
          symlinkSync(userTarget, path)
        }
      }

      uninstallTerminalIntegration(options)

      if (kind === 'regular') {
        expect(readFileSync(installed.launcherPath, 'utf8')).toBe(userContent)
      } else {
        expect(lstatSync(installed.launcherPath).isSymbolicLink()).toBe(true)
        expect(readlinkSync(installed.launcherPath)).toBe(userTarget)
      }
      expect(readFileSync(userTarget, 'utf8')).toBe(userContent)
    }
  })

  it('migrates a verified historical ownership state during App path repair', () => {
    const options = setup()
    const installed = installTerminalIntegration(options)
    const statePath = join(options.homeDir!, '.polo-ai', 'terminal-integration.json')
    writeFileSync(statePath, `${JSON.stringify({
      schemaVersion: 2,
      launcherPath: installed.launcherPath,
      launcherTarget: installed.launcherTarget,
      profilePath: installed.profilePath,
      updatedAt: '2026-07-30T12:00:00.000Z',
    })}\n`)

    const movedResources = join(
      dirname(dirname(dirname(options.resourcesPath))),
      'Polo Historical Move.app',
      'Contents',
      'Resources',
    )
    const movedTarget = join(movedResources, 'app', 'resources', 'bin', 'polo')
    mkdirSync(dirname(movedTarget), { recursive: true })
    writeFileSync(movedTarget, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const movedOptions = { ...options, resourcesPath: movedResources, appVersion: '0.11.0' }

    const repaired = installTerminalIntegration(movedOptions)
    expect(readlinkSync(repaired.launcherPath)).toBe(movedTarget)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      schemaVersion: 3,
      owner: 'com.poloai.terminal-integration',
      launcherFormat: 'managed-symlink-v1',
      appVersion: '0.11.0',
      launcherTarget: movedTarget,
    })

    uninstallTerminalIntegration(movedOptions)
    expect(existsSync(repaired.launcherPath)).toBe(false)
  })

  it('removes only Polo-managed content', () => {
    const options = setup()
    const installed = installTerminalIntegration(options)
    const profile = installed.profilePath!
    const content = readFileSync(profile, 'utf8')
    writeFileSync(profile, `export EDITOR=nano\n${content}`)

    const status = uninstallTerminalIntegration(options)
    expect(existsSync(installed.launcherPath)).toBe(false)
    expect(readFileSync(profile, 'utf8')).toContain('export EDITOR=nano')
    expect(readFileSync(profile, 'utf8')).not.toContain('# >>> Polo CLI >>>')
    expect(status.installed).toBe(false)
  })

  it('repairs and uninstalls profiles left by a previous default shell', () => {
    const zshOptions = setup('/bin/zsh')
    const installed = installTerminalIntegration(zshOptions)
    const zprofile = installed.profilePath!
    const bashOptions = { ...zshOptions, shell: '/bin/bash' }

    const repaired = installTerminalIntegration(bashOptions)
    const bashProfile = repaired.profilePath!
    expect(bashProfile).toEndWith('.bash_profile')
    expect(readFileSync(zprofile, 'utf8')).not.toContain('# >>> Polo CLI >>>')
    expect(readFileSync(bashProfile, 'utf8')).toContain('# >>> Polo CLI >>>')

    uninstallTerminalIntegration({ ...bashOptions, shell: '/opt/homebrew/bin/fish' })
    expect(readFileSync(bashProfile, 'utf8')).not.toContain('# >>> Polo CLI >>>')
    expect(existsSync(repaired.launcherPath)).toBe(false)
  })

  it('reports a bounded structured timeout from login-shell detection', () => {
    const options = setup()
    options.commandLookup = undefined
    options.commandValidator = undefined
    options.shellTimeoutMs = 5_000
    options.shellOutputLimit = 32
    options.shellRunner = (_shell, _command, limits) => ({
      status: 'timeout',
      output: 'x'.repeat(limits.outputLimit + 10),
    })

    const status = getTerminalIntegrationStatus(options)
    expect(status.shellCheck).toEqual({
      status: 'timeout',
      timeoutMs: 5_000,
      outputTruncated: true,
    })
    expect(status.pathReady).toBe(false)
  })

  it('kills a real login-shell probe at the configured timeout', () => {
    const options = setup()
    const slowShell = join(options.homeDir!, 'slow-shell')
    mkdirSync(options.homeDir!, { recursive: true })
    writeFileSync(slowShell, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
    options.shell = slowShell
    options.commandLookup = undefined
    options.commandValidator = undefined
    options.shellTimeoutMs = 50

    const startedAt = Date.now()
    const status = getTerminalIntegrationStatus(options)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(status.shellCheck?.status).toBe('timeout')
    expect(status.pathReady).toBe(false)
  })

  it('reports command-name conflicts', () => {
    const options = setup()
    options.commandLookup = () => '/opt/tools/polo'
    const status = getTerminalIntegrationStatus(options)
    expect(status.conflict).toEqual({
      code: 'command_conflict',
      path: '/opt/tools/polo',
    })
  })

  it('does not treat the packaged wrapper symlink target as a user command conflict', () => {
    const options = setup()
    const packagedWrapper = join(
      options.resourcesPath,
      'app',
      'resources',
      'bin',
      'polo',
    )
    options.commandLookup = () => packagedWrapper

    const status = installTerminalIntegration(options)

    expect(status.conflict).toBeUndefined()
    expect(status.installed).toBe(true)
  })

  it('does not modify malformed managed profile markers', () => {
    const options = setup()
    const profile = join(options.homeDir!, '.zprofile')
    mkdirSync(options.homeDir!, { recursive: true })
    const malformed = 'export EDITOR=vim\n# <<< Polo CLI <<<\n# >>> Polo CLI >>>\n'
    writeFileSync(profile, malformed)

    const status = installTerminalIntegration(options)
    expect(readFileSync(profile, 'utf8')).toBe(malformed)
    expect(status.conflict).toEqual({
      code: 'profile_conflict',
      path: profile,
    })
  })

  it('exposes a safe structured code for unsupported platform errors', () => {
    const options = { ...setup(), platform: 'linux' as const }
    let thrown: unknown
    try {
      installTerminalIntegration(options)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(TerminalIntegrationOperationError)
    expect(toTerminalIntegrationErrorPayload(thrown, 'install')).toEqual({
      errorCode: 'unsupported_platform',
    })
  })

  it('maps malformed uninstall profiles to a safe path parameter', () => {
    const options = setup()
    const installed = installTerminalIntegration(options)
    const malformed = '# <<< Polo CLI <<<\n# >>> Polo CLI >>>\n'
    writeFileSync(installed.profilePath!, malformed)

    let thrown: unknown
    try {
      uninstallTerminalIntegration(options)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(TerminalIntegrationOperationError)
    expect(toTerminalIntegrationErrorPayload(thrown, 'uninstall')).toEqual({
      errorCode: 'profile_malformed',
      errorParams: {
        path: installed.profilePath,
        operation: 'uninstall',
      },
    })
    expect(readFileSync(installed.profilePath!, 'utf8')).toBe(malformed)
  })
})
