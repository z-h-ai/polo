import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const LAUNCHER_MARKER = '# Polo CLI launcher (managed by Polo AI)'
const BLOCK_START = '# >>> Polo CLI >>>'
const BLOCK_END = '# <<< Polo CLI <<<'

export interface TerminalIntegrationStatus {
  supported: boolean
  installed: boolean
  pathReady: boolean
  needsRepair: boolean
  conflict?: string
  launcherPath: string
  profilePath?: string
  message: string
}

export interface TerminalIntegrationOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  shell?: string
  resourcesPath: string
  appExecutable: string
  appVersion: string
  commandLookup?: () => string | null
  commandValidator?: () => { ok: boolean; output?: string }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function getLauncherPath(options: TerminalIntegrationOptions): string {
  return join(options.homeDir ?? homedir(), '.local', 'bin', 'polo')
}

function getProfile(options: TerminalIntegrationOptions): { path: string; block: string } {
  const home = options.homeDir ?? homedir()
  const shell = options.shell ?? process.env.SHELL ?? '/bin/zsh'
  if (shell.endsWith('/fish')) {
    return {
      path: join(home, '.config', 'fish', 'conf.d', 'polo.fish'),
      block: `${BLOCK_START}\nfish_add_path -g "$HOME/.local/bin"\n${BLOCK_END}`,
    }
  }
  if (shell.endsWith('/bash')) {
    return {
      path: join(home, '.bash_profile'),
      block: `${BLOCK_START}\nexport PATH="$HOME/.local/bin:$PATH"\n${BLOCK_END}`,
    }
  }
  return {
    path: join(home, '.zprofile'),
    block: `${BLOCK_START}\nexport PATH="$HOME/.local/bin:$PATH"\n${BLOCK_END}`,
  }
}

function managedLauncherContent(options: TerminalIntegrationOptions): string {
  const appRoot = join(options.resourcesPath, 'app')
  const bun = join(options.resourcesPath, 'vendor', 'bun', 'bun')
  const cli = join(appRoot, 'dist', 'cli', 'polo-cli.js')
  const server = join(appRoot, 'dist', 'server', 'polo-server.js')
  const desktopApp = join(options.resourcesPath, '..', '..')

  return `#!/bin/sh
${LAUNCHER_MARKER}
export POLO_AI_BUN=${shellQuote(bun)}
export POLO_AI_SERVER_ENTRY=${shellQuote(server)}
export POLO_AI_APP_ROOT=${shellQuote(appRoot)}
export POLO_AI_RESOURCES_PATH=${shellQuote(join(appRoot, 'resources'))}
export POLO_AI_BUNDLED_ASSETS_ROOT=${shellQuote(appRoot)}
export POLO_AI_DESKTOP_APP=${shellQuote(desktopApp)}
export POLO_AI_IS_PACKAGED=true
exec ${shellQuote(bun)} run ${shellQuote(cli)} "$@"
`
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function isManagedLauncher(content: string): boolean {
  return content.startsWith(`#!/bin/sh\n${LAUNCHER_MARKER}\n`)
}

function isExecutable(path: string): boolean {
  try {
    return (statSync(path).mode & 0o111) !== 0
  } catch {
    return false
  }
}

function writeAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  writeFileSync(temp, content, { encoding: 'utf8', mode })
  renameSync(temp, path)
  if (mode !== undefined) chmodSync(path, mode)
}

function backup(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  const backupPath = `${path}.polo-backup-${Date.now()}`
  copyFileSync(path, backupPath)
  return backupPath
}

function existingMode(path: string, fallback: number): number {
  return existsSync(path) ? statSync(path).mode & 0o777 : fallback
}

function getManagedBlockRange(content: string): { start: number; end: number } | null {
  const starts = content.split(BLOCK_START).length - 1
  const ends = content.split(BLOCK_END).length - 1
  if (starts === 0 && ends === 0) return null
  const start = content.indexOf(BLOCK_START)
  const endMarker = content.indexOf(BLOCK_END)
  if (starts !== 1 || ends !== 1 || start < 0 || endMarker < start) {
    throw new Error('Polo terminal configuration markers are malformed; the file was not changed.')
  }
  return { start, end: endMarker + BLOCK_END.length }
}

function replaceManagedBlock(content: string, block: string | null): string {
  const range = getManagedBlockRange(content)
  let without = content
  if (range) {
    without = `${content.slice(0, range.start)}${content.slice(range.end)}`.trimEnd()
  }
  if (!block) return without ? `${without}\n` : ''
  return without ? `${without}\n\n${block}\n` : `${block}\n`
}

function lookupCommand(options: TerminalIntegrationOptions): string | null {
  if (options.commandLookup) return options.commandLookup()
  const shell = options.shell ?? process.env.SHELL ?? '/bin/zsh'
  const result = spawnSync(shell, ['-lic', 'command -v polo 2>/dev/null || true'], {
    encoding: 'utf8',
    env: process.env,
  })
  const output = result.stdout?.trim()
  return output || null
}

function validateCommand(options: TerminalIntegrationOptions): boolean {
  if (options.commandValidator) return options.commandValidator().ok
  const shell = options.shell ?? process.env.SHELL ?? '/bin/zsh'
  const result = spawnSync(shell, ['-lic', 'command -v polo && polo --version'], {
    encoding: 'utf8',
    env: process.env,
  })
  return result.status === 0 && result.stdout.includes(options.appVersion)
}

export function getTerminalIntegrationStatus(
  options: TerminalIntegrationOptions,
): TerminalIntegrationStatus {
  const launcherPath = getLauncherPath(options)
  if ((options.platform ?? process.platform) !== 'darwin') {
    return {
      supported: false,
      installed: false,
      pathReady: false,
      needsRepair: false,
      launcherPath,
      message: 'Terminal setup is managed by the platform installer.',
    }
  }

  const profile = getProfile(options)
  const launcher = read(launcherPath)
  const profileContent = read(profile.path)
  const installed = isManagedLauncher(launcher)
  const launcherCurrent = launcher === managedLauncherContent(options)
  let blockReady = false
  let malformedProfile = false
  try {
    const range = getManagedBlockRange(profileContent)
    blockReady = range !== null
      && profileContent.slice(range.start, range.end) === profile.block
  } catch {
    malformedProfile = true
  }
  const found = lookupCommand(options)
  const launcherExecutable = installed && isExecutable(launcherPath)
  const conflict = malformedProfile
    ? `Malformed Polo configuration in ${profile.path}`
    : found && found !== launcherPath
      ? found
      : undefined
  const pathReady = blockReady
    && found === launcherPath
    && launcherExecutable
    && validateCommand(options)

  return {
    supported: true,
    installed,
    pathReady,
    needsRepair: installed
      ? !blockReady || !launcherCurrent || !launcherExecutable || !pathReady
      : existsSync(launcherPath) || malformedProfile,
    conflict,
    launcherPath,
    profilePath: profile.path,
    message: conflict
      ? `Another command named polo already exists at ${conflict}. It was not changed.`
      : installed && pathReady
        ? 'Polo terminal features are ready.'
        : installed
          ? 'Polo is installed. Open a new Terminal window to use it.'
          : 'Polo terminal features are not installed.',
  }
}

export function installTerminalIntegration(
  options: TerminalIntegrationOptions,
): TerminalIntegrationStatus {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error('In-app terminal setup is currently available on macOS only')
  }

  const launcherPath = getLauncherPath(options)
  const existingLauncher = read(launcherPath)
  if (existingLauncher && !isManagedLauncher(existingLauncher)) {
    throw new Error(`Another file already exists at ${launcherPath}; Polo did not overwrite it.`)
  }

  const found = lookupCommand(options)
  if (found && found !== launcherPath) {
    throw new Error(`Another command named polo already exists at ${found}; Polo did not overwrite it.`)
  }

  const profile = getProfile(options)
  const currentProfile = read(profile.path)
  const nextProfile = replaceManagedBlock(currentProfile, profile.block)
  if (nextProfile !== currentProfile) {
    const profileMode = existingMode(profile.path, 0o600)
    backup(profile.path)
    writeAtomic(profile.path, nextProfile, profileMode)
  }

  const content = managedLauncherContent(options)
  if (content !== existingLauncher || !isExecutable(launcherPath)) {
    if (existingLauncher && content !== existingLauncher) backup(launcherPath)
    writeAtomic(launcherPath, content, 0o755)
  }

  return getTerminalIntegrationStatus(options)
}

export function uninstallTerminalIntegration(
  options: TerminalIntegrationOptions,
): TerminalIntegrationStatus {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error('In-app terminal setup is currently available on macOS only')
  }

  const launcherPath = getLauncherPath(options)
  const launcher = read(launcherPath)
  if (isManagedLauncher(launcher)) {
    rmSync(launcherPath)
  }

  const profile = getProfile(options)
  const currentProfile = read(profile.path)
  const nextProfile = replaceManagedBlock(currentProfile, null)
  if (nextProfile !== currentProfile) {
    const profileMode = existingMode(profile.path, 0o600)
    backup(profile.path)
    writeAtomic(profile.path, nextProfile, profileMode)
  }

  return getTerminalIntegrationStatus(options)
}

function promptStatePath(options: TerminalIntegrationOptions): string {
  return join(options.homeDir ?? homedir(), '.polo-ai', 'terminal-setup.json')
}

export function wasTerminalSetupDismissed(options: TerminalIntegrationOptions): boolean {
  try {
    const value = JSON.parse(read(promptStatePath(options))) as { dismissed?: boolean }
    return value.dismissed === true
  } catch {
    return false
  }
}

export function setTerminalSetupDismissed(
  options: TerminalIntegrationOptions,
  dismissed: boolean,
): void {
  writeAtomic(
    promptStatePath(options),
    `${JSON.stringify({ dismissed, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    0o600,
  )
}
