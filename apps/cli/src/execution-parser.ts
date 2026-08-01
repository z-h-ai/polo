export type ExecutionCommandKind =
  | 'run'
  | 'exec'
  | 'resume'
  | 'sessions'
  | 'delete'
  | 'help'
  | 'version'

export interface ExecutionArgs {
  entryCommand: 'run' | 'exec'
  kind: ExecutionCommandKind
  prompt?: string
  threadId?: string
  last: boolean
  workspace?: string
  workingDirectory?: string
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  json: boolean
  permissionMode: 'safe' | 'ask' | 'allow-all'
  ephemeral: boolean
  noCleanup: boolean
  color: 'always' | 'never' | 'auto'
  outputLastMessage?: string
  sources: string[]
  outputFormat: 'text' | 'stream-json'
  noSpinner: boolean
  forceStdin: boolean
  verbose: boolean
  serverEntry?: string
  startupTimeout: number
  sendTimeout?: number
}

export class UsageError extends Error {
  readonly exitCode = 2
}

/**
 * Authoritative arity table used while locating run/exec among options.
 * It includes both one-shot options and legacy server-client options so an
 * unsupported legacy value can never be mistaken for the command or route a
 * run invocation back to the full server path.
 */
export const CLI_OPTION_ARITY: Readonly<Record<string, 0 | 1>> = Object.freeze({
  '--workspace': 1,
  '-C': 1,
  '--cd': 1,
  '--provider': 1,
  '-m': 1,
  '--model': 1,
  '--api-key': 1,
  '--base-url': 1,
  '--color': 1,
  '-o': 1,
  '--output-last-message': 1,
  '--source': 1,
  '--mode': 1,
  '--output-format': 1,
  '--server-entry': 1,
  '--timeout': 1,
  '--workspace-dir': 1,
  '--send-timeout': 1,
  '--url': 1,
  '--token': 1,
  '--tls-ca': 1,
  '--json': 0,
  '--yolo': 0,
  '--dangerously-bypass-approvals-and-sandbox': 0,
  '--ephemeral': 0,
  '--no-cleanup': 0,
  '--last': 0,
  '--disable-spinner': 0,
  '--no-spinner': 0,
  '--stdin': 0,
  '--verbose': 0,
  '-v': 0,
  '-h': 0,
  '--help': 0,
  '-V': 0,
  '--version': 0,
  '--validate-server': 0,
  '--sandbox': 1,
  '--add-dir': 1,
  '--skip-git-repo-check': 0,
  '--image': 1,
  '-i': 1,
  '--output-schema': 1,
  '--config': 1,
  '-c': 1,
  '--profile': 1,
  '--enable': 1,
  '--disable': 1,
  '--strict-config': 0,
  '--oss': 0,
  '--local-provider': 1,
  '--ignore-user-config': 0,
  '--ignore-rules': 0,
  '--dangerously-bypass-hook-trust': 0,
})

const LEGACY_SERVER_ONLY_OPTIONS = new Set([
  '--url',
  '--token',
  '--tls-ca',
])

const UNSUPPORTED_OPTIONS = new Set([
  '--sandbox',
  '--add-dir',
  '--skip-git-repo-check',
  '--image',
  '-i',
  '--output-schema',
  '--config',
  '-c',
  '--profile',
  '--enable',
  '--disable',
  '--strict-config',
  '--oss',
  '--local-provider',
  '--ignore-user-config',
  '--ignore-rules',
  '--dangerously-bypass-hook-trust',
])

const EXEC_UNSUPPORTED_LEGACY_OPTIONS = new Set([
  '--disable-spinner',
  '--no-spinner',
  '--verbose',
  '-v',
  '--server-entry',
  '--timeout',
  '--workspace-dir',
])

export function findExecutionCommandIndex(argv: string[]): number {
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    const [name, inline] = splitLongOption(token)
    if (CLI_OPTION_ARITY[name] === 1) {
      if (inline === undefined) i++
      continue
    }
    if (token.startsWith('-')) continue
    return token === 'run' || token === 'exec' ? i + 2 : -1
  }
  return -1
}

function splitLongOption(token: string): [string, string | undefined] {
  if (!token.startsWith('--')) return [token, undefined]
  const index = token.indexOf('=')
  return index < 0 ? [token, undefined] : [token.slice(0, index), token.slice(index + 1)]
}

function takeValue(tokens: string[], index: number, inline: string | undefined, option: string): [string, number] {
  if (inline !== undefined) {
    if (!inline) throw new UsageError(`missing value for ${option}`)
    return [inline, index]
  }
  const value = tokens[index + 1]
  if (value === undefined || value === '--' || value.startsWith('-')) {
    throw new UsageError(`missing value for ${option}`)
  }
  return [value, index + 1]
}

function rejectInlineValue(inline: string | undefined, option: string): void {
  if (inline !== undefined) throw new UsageError(`${option} does not take a value`)
}

export function parseExecutionArgs(argv: string[]): ExecutionArgs {
  const commandIndex = findExecutionCommandIndex(argv)
  if (commandIndex < 0) throw new UsageError('expected run or exec command')

  const command = argv[commandIndex] as 'run' | 'exec'
  const tokens = [...argv.slice(2, commandIndex), ...argv.slice(commandIndex + 1)]
  const positionals: string[] = []
  const args: ExecutionArgs = {
    entryCommand: command,
    kind: command,
    last: false,
    json: false,
    permissionMode: command === 'exec' ? 'safe' : 'allow-all',
    ephemeral: false,
    noCleanup: false,
    color: 'auto',
    sources: [],
    outputFormat: 'text',
    noSpinner: false,
    forceStdin: false,
    verbose: false,
    startupTimeout: 30_000,
    sendTimeout: command === 'run' ? 300_000 : undefined,
  }

  let afterSeparator = false
  let positionalsBeforeSeparator: number | undefined
  let yolo = false
  let dangerousAlias = false
  let modeProvided = false
  let legacyWorkspaceDirProvided = false
  const providedOptions = new Set<string>()

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (afterSeparator) {
      positionals.push(token)
      continue
    }
    if (token === '--') {
      positionalsBeforeSeparator = positionals.length
      afterSeparator = true
      continue
    }

    const [name, inline] = splitLongOption(token)
    if (token.startsWith('-') && token !== '-') providedOptions.add(name)
    if (LEGACY_SERVER_ONLY_OPTIONS.has(name)) {
      throw new UsageError(`unsupported option for ${command}: ${name}`)
    }
    if (UNSUPPORTED_OPTIONS.has(name)) {
      throw new UsageError(`unsupported option: ${name}`)
    }
    // These flags remain available to the legacy `run`/remote-server paths,
    // but are not part of the public P0 exec surface. Reject them before
    // parsing values so help/version can never turn a debug flag into a
    // successful invocation.
    if (command === 'exec' && EXEC_UNSUPPORTED_LEGACY_OPTIONS.has(name)) {
      throw new UsageError(`unsupported option for exec: ${name}`)
    }

    switch (name) {
      case '-h':
      case '--help':
        args.kind = 'help'
        continue
      case '-V':
      case '--version':
        args.kind = 'version'
        continue
      case '--workspace': {
        if (legacyWorkspaceDirProvided) throw new UsageError('--workspace conflicts with --workspace-dir')
        ;[args.workspace, i] = takeValue(tokens, i, inline, name)
        continue
      }
      case '-C':
      case '--cd': {
        if (legacyWorkspaceDirProvided) throw new UsageError(`${name} conflicts with --workspace-dir`)
        ;[args.workingDirectory, i] = takeValue(tokens, i, inline, name)
        continue
      }
      case '--provider': {
        ;[args.provider, i] = takeValue(tokens, i, inline, name)
        continue
      }
      case '-m':
      case '--model': {
        ;[args.model, i] = takeValue(tokens, i, inline, name)
        continue
      }
      case '--api-key': {
        ;[args.apiKey, i] = takeValue(tokens, i, inline, name)
        continue
      }
      case '--base-url': {
        ;[args.baseUrl, i] = takeValue(tokens, i, inline, name)
        continue
      }
      case '--json':
        if (inline !== undefined) throw new UsageError('--json does not take a value')
        args.json = true
        continue
      case '--yolo':
        if (inline !== undefined) throw new UsageError('--yolo does not take a value')
        yolo = true
        args.permissionMode = 'allow-all'
        continue
      case '--dangerously-bypass-approvals-and-sandbox':
        if (inline !== undefined) throw new UsageError(`${name} does not take a value`)
        dangerousAlias = true
        args.permissionMode = 'allow-all'
        continue
      case '--ephemeral':
        rejectInlineValue(inline, name)
        args.ephemeral = true
        continue
      case '--no-cleanup':
        rejectInlineValue(inline, name)
        args.noCleanup = true
        continue
      case '--last':
        rejectInlineValue(inline, name)
        args.last = true
        continue
      case '--color': {
        const [value, next] = takeValue(tokens, i, inline, name)
        if (value !== 'always' && value !== 'never' && value !== 'auto') {
          throw new UsageError(`invalid --color value: ${value}`)
        }
        args.color = value
        i = next
        continue
      }
      case '-o':
      case '--output-last-message': {
        ;[args.outputLastMessage, i] = takeValue(tokens, i, inline, name)
        continue
      }
      case '--source': {
        let value: string
        ;[value, i] = takeValue(tokens, i, inline, name)
        args.sources.push(value)
        continue
      }
      case '--mode': {
        const [value, next] = takeValue(tokens, i, inline, name)
        if (value !== 'safe' && value !== 'ask' && value !== 'allow-all') {
          throw new UsageError(`invalid --mode value: ${value}`)
        }
        args.permissionMode = value
        modeProvided = true
        i = next
        continue
      }
      case '--output-format': {
        const [value, next] = takeValue(tokens, i, inline, name)
        if (value !== 'text' && value !== 'stream-json') {
          throw new UsageError(`invalid --output-format value: ${value}`)
        }
        args.outputFormat = value
        i = next
        continue
      }
      case '--disable-spinner':
      case '--no-spinner':
        rejectInlineValue(inline, name)
        args.noSpinner = true
        continue
      case '--stdin':
        rejectInlineValue(inline, name)
        args.forceStdin = true
        continue
      case '--verbose':
      case '-v':
        rejectInlineValue(inline, name)
        args.verbose = true
        continue
      case '--server-entry': {
        ;[args.serverEntry, i] = takeValue(tokens, i, inline, name)
        continue
      }
      case '--timeout': {
        const [value, next] = takeValue(tokens, i, inline, name)
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`invalid --timeout value: ${value}`)
        args.startupTimeout = Math.trunc(parsed)
        i = next
        continue
      }
      case '--workspace-dir': {
        const [value, next] = takeValue(tokens, i, inline, name)
        if (args.workspace || args.workingDirectory) {
          throw new UsageError('--workspace-dir conflicts with --workspace or -C')
        }
        // Compatibility with the former run flag: use an already registered
        // workspace as configuration and its directory as the execution cwd.
        // It intentionally no longer registers or writes a workspace.
        args.workspace = value
        args.workingDirectory = value
        legacyWorkspaceDirProvided = true
        i = next
        continue
      }
      case '--send-timeout': {
        const [value, next] = takeValue(tokens, i, inline, name)
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new UsageError(`invalid --send-timeout value: ${value}`)
        }
        args.sendTimeout = Math.trunc(parsed)
        i = next
        continue
      }
      default:
        if (token.startsWith('-') && token !== '-') throw new UsageError(`unknown option: ${token}`)
        positionals.push(token)
    }
  }

  if (yolo && dangerousAlias) {
    throw new UsageError('conflicting options: --yolo and --dangerously-bypass-approvals-and-sandbox')
  }
  if (command === 'run' && args.ephemeral) throw new UsageError('unsupported option for run: --ephemeral')
  if (command === 'exec' && args.noCleanup) throw new UsageError('unsupported option for exec: --no-cleanup')
  if (command === 'exec' && args.outputFormat !== 'text') {
    throw new UsageError('unsupported option for exec: --output-format')
  }
  if (command === 'exec' && args.sources.length > 0) throw new UsageError('unsupported option for exec: --source')
  if (command === 'exec' && modeProvided) throw new UsageError('unsupported option for exec: --mode')
  if (command === 'exec' && args.forceStdin) throw new UsageError('unsupported option for exec: --stdin')
  if (command === 'exec' && args.sendTimeout) {
    throw new UsageError('unsupported option for exec: --send-timeout (exec has no total execution timeout)')
  }

  // Help/version must not bypass command-specific validation. In particular,
  // `exec sessions --api-key secret --help` is still an invalid management
  // command, rather than a successful help invocation that silently accepts
  // an invocation credential.
  const requestedTerminalKind = args.kind === 'help' || args.kind === 'version'
    ? args.kind
    : undefined

  if (command === 'run') {
    if (requestedTerminalKind) return args
    if (args.last) throw new UsageError('unsupported option for run: --last')
    args.prompt = positionals.join(' ')
    return args
  }

  // Continue parsing exec subcommands even when a terminal help/version flag
  // was supplied. The requested terminal behavior is dispatched only after a
  // recognised management subcommand has passed its option whitelist.
  args.kind = 'exec'

  const hasReservedLocator = positionalsBeforeSeparator === undefined || positionalsBeforeSeparator > 0

  if (hasReservedLocator && positionals[0] === 'review') {
    throw new UsageError('unsupported subcommand: review')
  }

  if (hasReservedLocator && positionals[0] === 'resume') {
    args.kind = 'resume'
    positionals.shift()
    if (args.last) {
      const possibleLocatorIsBeforeSeparator = positionalsBeforeSeparator === undefined
        || positionalsBeforeSeparator > 1
      if (
        possibleLocatorIsBeforeSeparator
        && positionals[0]
        && /^[0-9a-f-]{36}$/i.test(positionals[0])
      ) {
        throw new UsageError('resume accepts either <thread_id> or --last, not both')
      }
    } else {
      if (positionalsBeforeSeparator !== undefined && positionalsBeforeSeparator < 2) {
        throw new UsageError('missing thread_id for exec resume')
      }
      const threadId = positionals.shift()
      if (!threadId) throw new UsageError('missing thread_id for exec resume')
      args.threadId = threadId
    }
  } else if (hasReservedLocator && positionals[0] === 'sessions') {
    args.kind = 'sessions'
    positionals.shift()
  } else if (hasReservedLocator && positionals[0] === 'delete') {
    args.kind = 'delete'
    positionals.shift()
    if (positionalsBeforeSeparator !== undefined && positionalsBeforeSeparator < 2) {
      throw new UsageError('missing thread_id for exec delete')
    }
    args.threadId = positionals.shift()
    if (!args.threadId) throw new UsageError('missing thread_id for exec delete')
  } else if (hasReservedLocator && positionals[0] === 'help') {
    args.kind = 'help'
    positionals.shift()
  }

  if (args.kind === 'exec' && args.last) {
    throw new UsageError('--last is only valid with exec resume')
  }

  if (args.kind === 'sessions' || args.kind === 'delete') {
    if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`)
    const allowedOptions = args.kind === 'sessions'
      ? new Set(['--workspace', '-C', '--cd', '--json', '--color', '-h', '--help', '-V', '--version'])
      : new Set(['--json', '--color', '-h', '--help', '-V', '--version'])
    const unsupportedOption = [...providedOptions]
      .find(option => !allowedOptions.has(option))
    if (unsupportedOption) {
      throw new UsageError(`unsupported option for exec ${args.kind}: ${unsupportedOption}`)
    }
    if (requestedTerminalKind) {
      return { ...args, kind: requestedTerminalKind }
    }
    return args
  }

  if (requestedTerminalKind) return { ...args, kind: requestedTerminalKind }

  if (positionals.length > 1) {
    throw new UsageError(`exec accepts one prompt argument; unexpected argument: ${positionals[1]}`)
  }
  args.prompt = positionals[0]
  return args
}

export async function readExecutionPrompt(prompt: string | undefined, forceStdin = false): Promise<string> {
  const stdinIsTty = process.stdin.isTTY === true
  const mustRead = prompt === undefined || prompt === '-'
  const shouldAppend = !mustRead && (forceStdin || !stdinIsTty)
  let stdinText = ''

  if (mustRead || shouldAppend) {
    const chunks: Uint8Array[] = []
    for await (const chunk of Bun.stdin.stream()) chunks.push(chunk)
    const bytes = chunks.reduce((size, chunk) => size + chunk.byteLength, 0)
    const merged = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    stdinText = new TextDecoder().decode(merged)
  }

  if (mustRead) return stdinText
  if (stdinText.length === 0) return prompt ?? ''
  return `${prompt}\n\n<stdin>\n${stdinText}\n</stdin>`
}
