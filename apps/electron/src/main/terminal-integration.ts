import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type {
  TerminalIntegrationErrorCode,
  TerminalIntegrationErrorPayload,
  TerminalIntegrationOperation,
  TerminalIntegrationStatus,
} from '../shared/types'

const BLOCK_START = '# >>> Polo CLI >>>'
const BLOCK_END = '# <<< Polo CLI <<<'
const STATE_SCHEMA_VERSION = 3
const STATE_OWNER = 'com.poloai.terminal-integration'
const LAUNCHER_FORMAT = 'managed-symlink-v1'
const SHELL_TIMEOUT_MS = 7_000
const SHELL_OUTPUT_LIMIT = 16 * 1024

class MalformedTerminalProfileError extends Error {}

export class TerminalIntegrationOperationError extends Error {
  constructor(
    readonly errorCode: TerminalIntegrationErrorCode,
    readonly errorParams?: TerminalIntegrationErrorPayload['errorParams'],
    options?: { cause?: unknown },
  ) {
    super(`Terminal integration failed with ${errorCode}`, options)
    this.name = 'TerminalIntegrationOperationError'
  }
}

export function toTerminalIntegrationErrorPayload(
  error: unknown,
  operation: TerminalIntegrationOperation,
): TerminalIntegrationErrorPayload {
  if (error instanceof TerminalIntegrationOperationError) {
    return {
      errorCode: error.errorCode,
      ...(error.errorParams ? { errorParams: error.errorParams } : {}),
    }
  }
  return {
    errorCode: `${operation}_failed`,
    errorParams: { operation },
  }
}

export type { TerminalIntegrationStatus } from '../shared/types'

export interface TerminalIntegrationOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  shell?: string
  resourcesPath: string
  appExecutable: string
  appVersion: string
  commandLookup?: () => string | null
  commandValidator?: () => { ok: boolean; output?: string }
  shellTimeoutMs?: number
  shellOutputLimit?: number
  shellRunner?: (
    shell: string,
    command: string,
    limits: { timeoutMs: number; outputLimit: number },
  ) => {
    status: 'ok' | 'timeout' | 'failed'
    output?: string
    outputTruncated?: boolean
  }
  /** Allows deterministic transaction-race coverage in main-process tests. */
  onBeforeTransactionStep?: (
    step: TerminalIntegrationTransactionStep,
    path: string,
  ) => void
}

interface TerminalIntegrationState {
  schemaVersion: number
  owner?: string
  launcherFormat?: string
  appVersion?: string
  launcherPath?: string
  launcherTarget?: string
  launcherIdentity?: string
  profilePath?: string
  activeProfile?: string
  profiles?: string[]
  updatedAt?: string
}

type TerminalIntegrationTransactionStep =
  | 'profile_claim'
  | 'profile_publish'
  | 'launcher_claim'
  | 'launcher_publish'

interface LeafSnapshot {
  exists: boolean
  kind?: 'file' | 'symlink' | 'other'
  identity?: string
  mode?: number
  content?: string
  symlinkTarget?: string
  symlinkValue?: string
}

class TerminalIntegrationConflictError extends Error {
  constructor(
    readonly kind: 'profile' | 'launcher',
    readonly path: string,
  ) {
    super(`Terminal integration transaction conflicted at ${path}`)
    this.name = 'TerminalIntegrationConflictError'
  }
}

function getLauncherPath(options: TerminalIntegrationOptions): string {
  return join(options.homeDir ?? homedir(), '.local', 'bin', 'polo')
}

function getPackagedLauncherTarget(options: TerminalIntegrationOptions): string {
  return join(options.resourcesPath, 'app', 'resources', 'bin', 'polo')
}

function profileForShell(
  options: TerminalIntegrationOptions,
  shell = options.shell ?? process.env.SHELL ?? '/bin/zsh',
): { path: string; block: string } {
  const home = options.homeDir ?? homedir()
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

function legacyManagedLauncherContent(options: TerminalIntegrationOptions): string {
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`
  const marker = '# Polo CLI launcher (managed by Polo AI)'
  const appRoot = join(options.resourcesPath, 'app')
  const bun = join(options.resourcesPath, 'vendor', 'bun', 'bun')
  const cli = join(appRoot, 'dist', 'cli', 'polo-cli.js')
  const server = join(appRoot, 'dist', 'server', 'polo-server.js')
  const desktopApp = join(options.resourcesPath, '..', '..')

  return `#!/bin/sh
${marker}
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

function statePath(options: TerminalIntegrationOptions): string {
  return join(options.homeDir ?? homedir(), '.polo-ai', 'terminal-integration.json')
}

function readState(options: TerminalIntegrationOptions): TerminalIntegrationState | null {
  try {
    const state = JSON.parse(read(statePath(options))) as TerminalIntegrationState
    if (![1, 2, STATE_SCHEMA_VERSION].includes(state.schemaVersion)) return null
    if ((state.schemaVersion === 1 || state.schemaVersion === 2) && (
      !state.launcherPath
      || !state.launcherTarget
      || !state.updatedAt
      || Number.isNaN(Date.parse(state.updatedAt))
      || !(state.profilePath || state.activeProfile || state.profiles?.length)
    )) {
      return null
    }
    if (state.schemaVersion === STATE_SCHEMA_VERSION && (
      state.owner !== STATE_OWNER
      || state.launcherFormat !== LAUNCHER_FORMAT
      || !state.appVersion
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(state.appVersion)
      || !state.launcherPath
      || !state.launcherTarget
      || !state.updatedAt
      || Number.isNaN(Date.parse(state.updatedAt))
      || state.launcherIdentity !== launcherIdentity(
        state.launcherPath,
        state.launcherTarget,
        state.appVersion,
      )
    )) {
      return null
    }
    return state
  } catch {
    return null
  }
}

function safeProfilePaths(
  options: TerminalIntegrationOptions,
  state = readState(options),
): string[] {
  const home = options.homeDir ?? homedir()
  const known = [
    join(home, '.zprofile'),
    join(home, '.bash_profile'),
    join(home, '.config', 'fish', 'conf.d', 'polo.fish'),
  ]
  const stateProfiles = [
    state?.activeProfile,
    state?.profilePath,
    ...(state?.profiles ?? []),
  ].filter((path): path is string => Boolean(path))
  const allowed = new Set(known)
  return [...new Set([...known, ...stateProfiles.filter(path => allowed.has(path))])]
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function captureLeaf(path: string): LeafSnapshot {
  try {
    const stats = lstatSync(path)
    const identity = `${stats.dev}:${stats.ino}`
    if (stats.isSymbolicLink()) {
      const symlinkValue = readlinkSync(path)
      return {
        exists: true,
        kind: 'symlink',
        identity,
        mode: stats.mode & 0o777,
        symlinkValue,
        symlinkTarget: resolve(dirname(path), symlinkValue),
      }
    }
    if (stats.isFile()) {
      return {
        exists: true,
        kind: 'file',
        identity,
        mode: stats.mode & 0o777,
        content: readFileSync(path, 'utf8'),
      }
    }
    return { exists: true, kind: 'other', identity, mode: stats.mode & 0o777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw error
  }
}

function isSameLeaf(expected: LeafSnapshot, actual: LeafSnapshot): boolean {
  return expected.exists === actual.exists
    && expected.kind === actual.kind
    && expected.identity === actual.identity
    && expected.content === actual.content
    && expected.symlinkTarget === actual.symlinkTarget
    && expected.symlinkValue === actual.symlinkValue
}

function transactionPath(path: string, purpose: 'claim' | 'tmp' | 'backup'): string {
  return `${path}.polo-${purpose}-${process.pid}-${crypto.randomUUID()}`
}

function publishRegularFileNoReplace(temp: string, path: string): boolean {
  try {
    // `link` fails with EEXIST and never follows a destination symlink. The
    // temporary file lives beside its destination, so this is an atomic
    // no-replace publication on every supported macOS filesystem.
    linkSync(temp, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    rmSync(temp, { force: true })
  }
}

function publishSymlinkNoReplace(path: string, target: string): boolean {
  try {
    // Creating a symlink is atomic and fails if a user-created leaf appeared
    // after preflight; unlike rename it cannot replace that leaf.
    symlinkSync(target, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

function restoreClaimedLeafNoReplace(claimedPath: string, destination: string): boolean {
  const claimed = captureLeaf(claimedPath)
  if (!claimed.exists) return true
  if (claimed.kind === 'file') {
    return publishRegularFileNoReplace(claimedPath, destination)
  }
  if (claimed.kind === 'symlink' && claimed.symlinkValue) {
    const restored = publishSymlinkNoReplace(destination, claimed.symlinkValue)
    if (restored) rmSync(claimedPath, { force: true })
    return restored
  }
  return false
}

function claimVerifiedLeaf(
  options: TerminalIntegrationOptions,
  step: 'profile_claim' | 'launcher_claim',
  kind: 'profile' | 'launcher',
  path: string,
  expected: LeafSnapshot,
): string | undefined {
  if (!expected.exists) return undefined
  options.onBeforeTransactionStep?.(step, path)
  const claimedPath = transactionPath(path, 'claim')
  try {
    renameSync(path, claimedPath)
  } catch {
    throw new TerminalIntegrationConflictError(kind, path)
  }
  if (!isSameLeaf(expected, captureLeaf(claimedPath))) {
    restoreClaimedLeafNoReplace(claimedPath, path)
    throw new TerminalIntegrationConflictError(kind, path)
  }
  return claimedPath
}

function backupClaimedRegularFile(path: string, originalPath = path): string {
  const backupPath = transactionPath(originalPath, 'backup')
  copyFileSync(path, backupPath)
  return backupPath
}

function updateManagedProfile(
  options: TerminalIntegrationOptions,
  path: string,
  block: string | null,
): void {
  const snapshot = captureLeaf(path)
  if (snapshot.exists && snapshot.kind !== 'file') {
    throw new TerminalIntegrationConflictError('profile', path)
  }
  const current = snapshot.content ?? ''
  const next = replaceManagedBlock(current, block)
  if (next === current) return

  const claimedPath = claimVerifiedLeaf(options, 'profile_claim', 'profile', path, snapshot)
  if (claimedPath) backupClaimedRegularFile(claimedPath, path)
  const temp = transactionPath(path, 'tmp')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(temp, next, { encoding: 'utf8', mode: snapshot.mode ?? 0o600 })
  options.onBeforeTransactionStep?.('profile_publish', path)
  if (!publishRegularFileNoReplace(temp, path)) {
    // The pre-transaction content is already preserved in the explicit
    // backup. A newly appeared user leaf wins; never restore over it.
    if (claimedPath) rmSync(claimedPath, { force: true })
    throw new TerminalIntegrationConflictError('profile', path)
  }
  if (claimedPath) rmSync(claimedPath, { force: true })
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

function writeState(
  options: TerminalIntegrationOptions,
  launcherTarget: string,
  profiles: string[],
  activeProfile: string,
): void {
  writeAtomic(
    statePath(options),
    `${JSON.stringify({
      schemaVersion: STATE_SCHEMA_VERSION,
      owner: STATE_OWNER,
      launcherFormat: LAUNCHER_FORMAT,
      appVersion: options.appVersion,
      launcherPath: getLauncherPath(options),
      launcherTarget,
      launcherIdentity: launcherIdentity(
        getLauncherPath(options),
        launcherTarget,
        options.appVersion,
      ),
      activeProfile,
      profiles: [...new Set(profiles)],
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    0o600,
  )
}

function launcherIdentity(path: string, target: string, appVersion: string): string {
  return createHash('sha256')
    .update(`${STATE_OWNER}\0${LAUNCHER_FORMAT}\0${appVersion}\0${path}\0${target}`)
    .digest('hex')
}

function resolveSymlinkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null
    const target = readlinkSync(path)
    return resolve(dirname(path), target)
  } catch {
    return null
  }
}

function isOwnedLauncherSnapshot(
  path: string,
  snapshot: LeafSnapshot,
  state: TerminalIntegrationState | null,
  options: TerminalIntegrationOptions,
): boolean {
  if (!snapshot.exists) return false
  if (
    snapshot.kind === 'symlink'
    && snapshot.symlinkTarget
    && state?.launcherPath === path
    && state.launcherTarget === snapshot.symlinkTarget
  ) {
    if (state.schemaVersion === STATE_SCHEMA_VERSION) {
      return state.owner === STATE_OWNER
        && state.launcherFormat === LAUNCHER_FORMAT
        && Boolean(state.appVersion)
        && state.launcherIdentity === launcherIdentity(
          path,
          snapshot.symlinkTarget,
          state.appVersion!,
        )
    }
    // Schema 1/2 is a historical Polo state marker. Requiring both the exact
    // recorded path and current symlink target permits a one-time migration
    // without treating a target match alone as ownership.
    return state.schemaVersion === 1 || state.schemaVersion === 2
  }
  return snapshot.kind === 'file'
    && snapshot.content === legacyManagedLauncherContent(options)
}

function isOwnedLauncher(
  path: string,
  state: TerminalIntegrationState | null,
  options: TerminalIntegrationOptions,
): boolean {
  return isOwnedLauncherSnapshot(path, captureLeaf(path), state, options)
}

function installManagedLauncher(
  options: TerminalIntegrationOptions,
  path: string,
  target: string,
  state: TerminalIntegrationState | null,
): boolean {
  const snapshot = captureLeaf(path)
  if (snapshot.exists && !isOwnedLauncherSnapshot(path, snapshot, state, options)) {
    return false
  }
  if (snapshot.kind === 'symlink' && snapshot.symlinkTarget === target) return true

  const claimedPath = claimVerifiedLeaf(options, 'launcher_claim', 'launcher', path, snapshot)
  if (claimedPath && snapshot.kind === 'file') backupClaimedRegularFile(claimedPath, path)
  mkdirSync(dirname(path), { recursive: true })
  options.onBeforeTransactionStep?.('launcher_publish', path)
  if (!publishSymlinkNoReplace(path, target)) {
    // A caller may have installed a command after the verified old launcher
    // was claimed. Restore only into an empty leaf and otherwise preserve both
    // the new command and our verified rollback candidate/backup.
    if (claimedPath) restoreClaimedLeafNoReplace(claimedPath, path)
    return false
  }
  if (claimedPath) rmSync(claimedPath, { force: true })
  return true
}

function removeManagedLauncher(
  options: TerminalIntegrationOptions,
  path: string,
  state: TerminalIntegrationState | null,
): boolean {
  const snapshot = captureLeaf(path)
  if (!isOwnedLauncherSnapshot(path, snapshot, state, options)) return false
  let claimedPath: string | undefined
  try {
    claimedPath = claimVerifiedLeaf(options, 'launcher_claim', 'launcher', path, snapshot)
  } catch (error) {
    if (error instanceof TerminalIntegrationConflictError) return false
    throw error
  }
  if (!claimedPath) return false
  // Delete only the private, revalidated candidate. If a user recreated the
  // command after the claim, it occupies the public path and is left alone.
  rmSync(claimedPath, { force: true })
  return true
}

function getManagedBlockRange(content: string): { start: number; end: number } | null {
  const starts = content.split(BLOCK_START).length - 1
  const ends = content.split(BLOCK_END).length - 1
  if (starts === 0 && ends === 0) return null
  const start = content.indexOf(BLOCK_START)
  const endMarker = content.indexOf(BLOCK_END)
  if (starts !== 1 || ends !== 1 || start < 0 || endMarker < start) {
    throw new MalformedTerminalProfileError()
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

interface ShellCommandResult {
  status: 'ok' | 'timeout' | 'failed'
  output: string
  outputTruncated?: boolean
}

function runLoginShell(
  options: TerminalIntegrationOptions,
  command: string,
): ShellCommandResult {
  const shell = options.shell ?? process.env.SHELL ?? '/bin/zsh'
  const timeoutMs = options.shellTimeoutMs ?? SHELL_TIMEOUT_MS
  const outputLimit = options.shellOutputLimit ?? SHELL_OUTPUT_LIMIT
  if (options.shellRunner) {
    const result = options.shellRunner(shell, command, { timeoutMs, outputLimit })
    return {
      status: result.status,
      output: (result.output ?? '').slice(0, outputLimit),
      outputTruncated: result.outputTruncated
        || (result.output?.length ?? 0) > outputLimit,
    }
  }
  const result = spawnSync(shell, ['-lic', command], {
    encoding: 'utf8',
    env: process.env,
    timeout: timeoutMs,
    maxBuffer: outputLimit,
    killSignal: 'SIGKILL',
  })
  const rawOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const output = rawOutput.slice(0, outputLimit)
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code
  if (errorCode === 'ETIMEDOUT') {
    return { status: 'timeout', output, outputTruncated: rawOutput.length > outputLimit }
  }
  if (result.status !== 0 || result.error) {
    return { status: 'failed', output, outputTruncated: rawOutput.length > outputLimit }
  }
  return { status: 'ok', output, outputTruncated: rawOutput.length > outputLimit }
}

function lookupAndValidateCommand(options: TerminalIntegrationOptions): {
  found: string | null
  valid: boolean
  shellCheck: NonNullable<TerminalIntegrationStatus['shellCheck']>
} {
  const timeoutMs = options.shellTimeoutMs ?? SHELL_TIMEOUT_MS
  if (options.commandLookup) {
    const found = options.commandLookup()
    const validation = options.commandValidator?.() ?? { ok: false }
    return {
      found,
      valid: validation.ok,
      shellCheck: { status: validation.ok ? 'ok' : 'failed', timeoutMs },
    }
  }

  const lookup = runLoginShell(
    options,
    'polo_command="$(command -v polo 2>/dev/null || true)"; '
      + 'printf \'__POLO_COMMAND__%s\\n\' "$polo_command"',
  )
  if (lookup.status !== 'ok') {
    return {
      found: null,
      valid: false,
      shellCheck: {
        status: lookup.status,
        timeoutMs,
        ...(lookup.outputTruncated ? { outputTruncated: true } : {}),
      },
    }
  }
  const found = lookup.output
    .split(/\r?\n/)
    .find(line => line.startsWith('__POLO_COMMAND__'))
    ?.slice('__POLO_COMMAND__'.length)
    || null
  if (!found) {
    return {
      found: null,
      valid: false,
      shellCheck: {
        status: 'ok',
        timeoutMs,
        ...(lookup.outputTruncated ? { outputTruncated: true } : {}),
      },
    }
  }
  const validation = runLoginShell(
    options,
    'polo_version="$(polo --version)" && '
      + 'printf \'__POLO_VERSION__%s\\n\' "$polo_version"',
  )
  return {
    found,
    valid: validation.status === 'ok'
      && validation.output.split(/\r?\n/)
        .some(line => line === `__POLO_VERSION__${options.appVersion}`),
    shellCheck: {
      status: validation.status,
      timeoutMs,
      ...(validation.outputTruncated ? { outputTruncated: true } : {}),
    },
  }
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
      statusCode: 'managed_by_installer',
    }
  }

  const state = readState(options)
  const profile = profileForShell(options)
  const profilePaths = safeProfilePaths(options, state)
  const launcherTarget = getPackagedLauncherTarget(options)
  const resolvedTarget = resolveSymlinkTarget(launcherPath)
  const installed = isOwnedLauncher(launcherPath, state, options)
  const launcherCurrent = resolvedTarget === launcherTarget
  const launcherExecutable = launcherCurrent && isExecutable(launcherPath)
  let blockReady = false
  let malformedProfile: string | null = null
  let staleManagedProfile = false
  const managedProfiles: string[] = []
  for (const path of profilePaths) {
    try {
      const profileSnapshot = captureLeaf(path)
      if (profileSnapshot.exists && profileSnapshot.kind !== 'file') {
        malformedProfile = path
        break
      }
      const content = profileSnapshot.content ?? ''
      const range = getManagedBlockRange(content)
      if (!range) continue
      managedProfiles.push(path)
      const exactBlock = content.slice(range.start, range.end)
      if (path === profile.path) {
        blockReady = exactBlock === profile.block
      } else {
        staleManagedProfile = true
      }
    } catch {
      malformedProfile = path
      break
    }
  }
  const command = lookupAndValidateCommand(options)
  const found = command.found
  // The packaged app prepends its internal resources/bin directory to PATH for
  // agent sessions. That bundled wrapper is the symlink target we are about to
  // install, not a user-owned system command conflict.
  const externalFound = found === launcherTarget ? null : found
  const launcherExists = pathExists(launcherPath)
  const conflict = malformedProfile
    ? { code: 'profile_conflict' as const, path: malformedProfile }
    : launcherExists && !installed
      ? { code: 'launcher_conflict' as const, path: launcherPath }
      : externalFound && externalFound !== launcherPath
        ? { code: 'command_conflict' as const, path: externalFound }
        : undefined
  const pathReady = blockReady
    && !staleManagedProfile
    && found === launcherPath
    && launcherExecutable
    && command.valid

  return {
    supported: true,
    installed,
    pathReady,
    needsRepair: installed
      ? !blockReady
        || staleManagedProfile
        || !launcherCurrent
        || !launcherExecutable
        || !pathReady
      : launcherExists || Boolean(malformedProfile),
    conflict,
    statusCode: conflict?.code
      ?? (installed && pathReady
        ? 'ready'
        : installed
          ? 'repair_required'
          : 'not_installed'),
    statusParams: conflict ? { path: conflict.path } : undefined,
    launcherPath,
    launcherTarget,
    profilePath: profile.path,
    managedProfiles,
    shellCheck: command.shellCheck,
  }
}

export function installTerminalIntegration(
  options: TerminalIntegrationOptions,
): TerminalIntegrationStatus {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new TerminalIntegrationOperationError('unsupported_platform')
  }

  const profile = profileForShell(options)
  try {
    const currentStatus = getTerminalIntegrationStatus(options)
    if (currentStatus.conflict) return currentStatus

    const launcherPath = getLauncherPath(options)
    const launcherTarget = getPackagedLauncherTarget(options)
    if (!existsSync(launcherTarget) || !isExecutable(launcherTarget)) {
      throw new Error(`Packaged launcher is missing or not executable: ${launcherTarget}`)
    }

    const state = readState(options)
    const profiles = safeProfilePaths(options, state)
    for (const path of profiles) {
      const block = path === profile.path ? profile.block : null
      updateManagedProfile(options, path, block)
    }

    if (!installManagedLauncher(options, launcherPath, launcherTarget, state)) {
      return getTerminalIntegrationStatus(options)
    }
    writeState(options, launcherTarget, [profile.path], profile.path)

    return getTerminalIntegrationStatus(options)
  } catch (error) {
    if (error instanceof TerminalIntegrationOperationError) throw error
    if (error instanceof MalformedTerminalProfileError) {
      throw new TerminalIntegrationOperationError(
        'profile_malformed',
        { path: profile.path, operation: 'install' },
        { cause: error },
      )
    }
    throw new TerminalIntegrationOperationError(
      'install_failed',
      { operation: 'install' },
      { cause: error },
    )
  }
}

export function uninstallTerminalIntegration(
  options: TerminalIntegrationOptions,
): TerminalIntegrationStatus {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new TerminalIntegrationOperationError('unsupported_platform')
  }

  const profile = profileForShell(options)
  try {
    const launcherPath = getLauncherPath(options)
    const state = readState(options)
    removeManagedLauncher(options, launcherPath, state)

    for (const path of safeProfilePaths(options, state)) {
      updateManagedProfile(options, path, null)
    }
    if (state) rmSync(statePath(options), { force: true })

    return getTerminalIntegrationStatus(options)
  } catch (error) {
    if (error instanceof TerminalIntegrationOperationError) throw error
    if (error instanceof MalformedTerminalProfileError) {
      throw new TerminalIntegrationOperationError(
        'profile_malformed',
        { path: profile.path, operation: 'uninstall' },
        { cause: error },
      )
    }
    throw new TerminalIntegrationOperationError(
      'uninstall_failed',
      { operation: 'uninstall' },
      { cause: error },
    )
  }
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
