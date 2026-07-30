import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  writeFileSync(join(resources, 'vendor', 'bun', 'bun'), '')
  writeFileSync(join(resources, 'app', 'dist', 'cli', 'polo-cli.js'), '')
  writeFileSync(join(resources, 'app', 'dist', 'server', 'polo-server.js'), '')
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
    expect(second.installed).toBe(true)
    expect(second.pathReady).toBe(true)
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

  it('requires the managed launcher to remain executable', () => {
    const options = setup()
    const installed = installTerminalIntegration(options)
    chmodSync(installed.launcherPath, 0o644)

    const status = getTerminalIntegrationStatus(options)
    expect(status.installed).toBe(true)
    expect(status.pathReady).toBe(false)
    expect(status.needsRepair).toBe(true)

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

  it('reports command-name conflicts', () => {
    const options = setup()
    options.commandLookup = () => '/opt/tools/polo'
    const status = getTerminalIntegrationStatus(options)
    expect(status.conflict).toEqual({
      code: 'command_conflict',
      path: '/opt/tools/polo',
    })
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
