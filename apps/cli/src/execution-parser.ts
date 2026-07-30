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

const VALUE_OPTIONS = new Set([
  '--workspace',
  '-C',
  '--cd',
  '--provider',
  '-m',
  '--model',
  '--api-key',
  '--base-url',
  '--color',
  '-o',
  '--output-last-message',
  '--source',
  '--mode',
  '--output-format',
  '--server-entry',
  '--timeout',
  '--workspace-dir',
  '--send-timeout',
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

export function findExecutionCommandIndex(argv: string[]): number {
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    const [name, inline] = splitLongOption(token)
    if (VALUE_OPTIONS.has(name)) {
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
  let yolo = false
  let dangerousAlias = false
  let modeProvided = false
  let legacyWorkspaceDirProvided = false

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (afterSeparator) {
      positionals.push(token)
      continue
    }
    if (token === '--') {
      afterSeparator = true
      continue
    }

    const [name, inline] = splitLongOption(token)
    if (UNSUPPORTED_OPTIONS.has(name)) {
      throw new UsageError(`unsupported option: ${name}`)
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

  if (args.kind === 'help' || args.kind === 'version') return args

  if (command === 'run') {
    if (args.last) throw new UsageError('unsupported option for run: --last')
    args.prompt = positionals.join(' ')
    return args
  }

  if (!afterSeparator && positionals[0] === 'review') {
    throw new UsageError('unsupported subcommand: review')
  }

  if (!afterSeparator && positionals[0] === 'resume') {
    args.kind = 'resume'
    positionals.shift()
    if (args.last) {
      if (positionals[0] && /^[0-9a-f-]{36}$/i.test(positionals[0])) {
        throw new UsageError('resume accepts either <thread_id> or --last, not both')
      }
    } else {
      const threadId = positionals.shift()
      if (!threadId) throw new UsageError('missing thread_id for exec resume')
      args.threadId = threadId
    }
  } else if (!afterSeparator && positionals[0] === 'sessions') {
    args.kind = 'sessions'
    positionals.shift()
  } else if (!afterSeparator && positionals[0] === 'delete') {
    args.kind = 'delete'
    positionals.shift()
    args.threadId = positionals.shift()
    if (!args.threadId) throw new UsageError('missing thread_id for exec delete')
  } else if (!afterSeparator && positionals[0] === 'help') {
    args.kind = 'help'
    positionals.shift()
  }

  if (args.kind === 'exec' && args.last) {
    throw new UsageError('--last is only valid with exec resume')
  }

  if (args.kind === 'sessions' || args.kind === 'delete') {
    if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`)
    if (args.ephemeral || args.outputLastMessage) {
      throw new UsageError(`unsupported option for exec ${args.kind}`)
    }
    return args
  }

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
