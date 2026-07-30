import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { constants as osConstants, homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  loadStoredConfigReadonly,
  type LlmConnection,
  type Workspace,
} from '@polo-ai/shared/config'
import { CliRpcClient } from './client.ts'
import {
  acquireCliThreadLease,
  cleanupStaleEphemeralThreads,
  cloneCliThreadEphemeral,
  createCliThread,
  deleteCliThread,
  isCliThreadActive,
  listCliThreads,
  locateCliThread,
  updateCliThread,
  type CliThreadRecord,
  type CliThreadStatus,
} from './cli-thread-store.ts'
import { ExecEventAdapter, type InternalSessionEvent } from './exec-event-adapter.ts'
import {
  UsageError,
  readExecutionPrompt,
  type ExecutionArgs,
} from './execution-parser.ts'
import { spawnServer, type SpawnedServer } from './server-spawner.ts'

interface ConfigurationScope {
  id: string
  workspace?: Workspace
  path: string
}

interface TurnResult {
  status: CliThreadStatus
  finalMessage: string
  error?: Error
  signal?: NodeJS.Signals
}

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
}

function configRoot(): string {
  return resolve(process.env.POLO_AI_CONFIG_DIR || join(homedir(), '.polo-ai'))
}

async function ensureDirectory(path: string, usage = false): Promise<string> {
  try {
    const canonical = await realpath(path)
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new Error('not a directory')
    return canonical
  } catch {
    const error = new (usage ? UsageError : Error)(`directory does not exist: ${path}`)
    throw error
  }
}

async function resolveConfigurationScope(explicit?: string): Promise<ConfigurationScope> {
  const config = loadStoredConfigReadonly()
  const workspaces = config?.workspaces ?? []
  if (explicit) {
    const canonicalExplicit = isAbsolute(explicit)
      ? await realpath(explicit).catch(() => explicit)
      : explicit
    const workspace = workspaces.find(candidate =>
      candidate.id === explicit
      || candidate.name.toLowerCase() === explicit.toLowerCase()
      || candidate.rootPath === canonicalExplicit
    )
    if (!workspace) throw new Error(`configuration workspace not found: ${explicit}`)
    return {
      id: workspace.id,
      workspace,
      path: await ensureDirectory(workspace.rootPath),
    }
  }

  const active = workspaces.find(workspace => workspace.id === config?.activeWorkspaceId)
  if (active) {
    return {
      id: active.id,
      workspace: active,
      path: await ensureDirectory(active.rootPath),
    }
  }

  return { id: 'global', path: configRoot() }
}

async function scopeFromThread(record: CliThreadRecord, explicit?: string): Promise<ConfigurationScope> {
  if (explicit) return resolveConfigurationScope(explicit)
  if (!record.metadata.configurationWorkspaceId || record.metadata.configurationScopeId === 'global') {
    const path = await ensureDirectory(record.metadata.configurationWorkspacePath)
    return { id: 'global', path }
  }
  const workspace = loadStoredConfigReadonly()?.workspaces.find(candidate =>
    candidate.id === record.metadata.configurationWorkspaceId
  )
  if (!workspace) {
    throw new Error(
      `configuration workspace no longer exists: ${record.metadata.configurationWorkspaceId}; use --workspace to override`,
    )
  }
  const path = await ensureDirectory(workspace.rootPath)
  return {
    id: workspace.id,
    path,
    workspace: { ...workspace, rootPath: path },
  }
}

function runtimeWorkspace(scope: ConfigurationScope): Workspace {
  if (scope.workspace) return { ...scope.workspace, rootPath: scope.path }
  return {
    id: 'global',
    name: 'Global',
    slug: 'global',
    rootPath: scope.path,
    createdAt: 0,
  }
}

const GLOBAL_SNAPSHOT_ENTRIES = new Set([
  'sources',
  'skills',
  'statuses',
  'labels',
  '.claude-plugin',
])

async function makePrivateTree(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    throw new Error(`configuration snapshot contains an unresolved symlink: ${path}`)
  }
  if (process.platform !== 'win32') await chmod(path, info.isDirectory() ? 0o700 : 0o600)
  if (!info.isDirectory()) return
  for (const entry of await readdir(path)) await makePrivateTree(join(path, entry))
}

async function createConfigurationSnapshot(
  record: CliThreadRecord,
  scope: ConfigurationScope,
): Promise<string> {
  const snapshotRoot = join(record.directory, 'config-snapshot')
  await rm(snapshotRoot, { recursive: true, force: true })
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 })

  const entries = await readdir(scope.path, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'sessions') continue
    if (scope.id === 'global' && !GLOBAL_SNAPSHOT_ENTRIES.has(entry.name)) continue
    await cp(join(scope.path, entry.name), join(snapshotRoot, entry.name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: true,
      filter: source => {
        const name = basename(source)
        return name !== '.credential-cache.json'
          && name !== 'credentials.enc'
          && name !== 'credentials.json'
          && name !== '.env'
      },
    })
  }

  if (scope.id === 'global') {
    const now = Date.now()
    await writeFile(join(snapshotRoot, 'config.json'), JSON.stringify({
      id: 'global',
      name: 'Global',
      slug: 'global',
      createdAt: now,
      updatedAt: now,
    }, null, 2), { mode: 0o600 })
  }
  await makePrivateTree(snapshotRoot)
  return snapshotRoot
}

function resolveInvocationApiKey(args: ExecutionArgs, provider?: string): string | undefined {
  if (args.apiKey) return args.apiKey
  if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY
  if (!provider) return undefined
  const envKey = PROVIDER_ENV_KEYS[provider]
  return envKey ? process.env[envKey] : undefined
}

function makeInvocationConnection(input: {
  slug: string
  provider: string
  baseUrl?: string
  model?: string
}): LlmConnection {
  const customEndpoint = input.baseUrl
    ? { api: input.provider === 'anthropic' ? 'anthropic-messages' as const : 'openai-completions' as const }
    : undefined
  return {
    slug: input.slug,
    name: `${input.provider} (CLI invocation)`,
    providerType: input.baseUrl ? 'pi_compat' : input.provider === 'anthropic' ? 'anthropic' : 'pi',
    authType: 'api_key',
    piAuthProvider: input.provider,
    baseUrl: input.baseUrl,
    customEndpoint,
    defaultModel: input.model,
    models: input.model ? [input.model] : undefined,
    createdAt: Date.now(),
  }
}

async function loadWorkspaceConnectionDefault(scope: ConfigurationScope): Promise<string | undefined> {
  if (scope.id === 'global') return undefined
  try {
    const config = JSON.parse(await readFile(join(scope.path, 'config.json'), 'utf-8')) as {
      defaults?: { defaultLlmConnection?: string }
    }
    return config.defaults?.defaultLlmConnection
  } catch {
    return undefined
  }
}

async function resolveConnection(
  args: ExecutionArgs,
  record: CliThreadRecord,
  scope: ConfigurationScope,
): Promise<{ connection?: LlmConnection; apiKey?: string; model?: string }> {
  const config = loadStoredConfigReadonly()
  const workspaceDefault = await loadWorkspaceConnectionDefault(scope)
  const defaultSlug = workspaceDefault || config?.defaultLlmConnection
  const defaultConnection = config?.llmConnections?.find(connection => connection.slug === defaultSlug)
    ?? config?.llmConnections?.[0]
  const provider = args.provider
  const baseUrl = args.baseUrl
  const model = args.model ?? defaultConnection?.defaultModel
  const selectedConnection = defaultConnection
  const needsSyntheticConnection = !!(args.provider || args.baseUrl || args.apiKey)
  if (!needsSyntheticConnection && selectedConnection) {
    const connection = { ...selectedConnection }
    return {
      connection,
      apiKey: resolveInvocationApiKey(args, connection.piAuthProvider),
      model,
    }
  }
  if (!needsSyntheticConnection) return { model }

  const effectiveProvider = provider || selectedConnection?.piAuthProvider || 'anthropic'
  const slug = `cli-${record.metadata.threadId}`
  return {
    connection: makeInvocationConnection({
      slug,
      provider: effectiveProvider,
      baseUrl,
      model,
    }),
    apiKey: resolveInvocationApiKey(args, effectiveProvider),
    model,
  }
}

async function atomicWriteLastMessage(path: string, message: string): Promise<void> {
  const target = resolve(path)
  const parent = dirname(target)
  const parentInfo = await stat(parent)
  if (!parentInfo.isDirectory()) throw new Error(`output directory is not a directory: ${parent}`)
  const temp = join(parent, `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(message, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (process.platform !== 'win32') await chmod(temp, 0o600)
    await rename(temp, target)
    if (process.platform !== 'win32') await chmod(target, 0o600)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  const number = osConstants.signals[signal]
  return 128 + (number || 0)
}

function formatError(error: unknown, adapter?: ExecEventAdapter): string {
  const message = error instanceof Error ? error.message : String(error)
  return adapter ? adapter.redact(message) : message
}

async function waitForTurn(
  client: CliRpcClient,
  sessionId: string,
  prompt: string,
  args: ExecutionArgs,
  adapter: ExecEventAdapter,
): Promise<TurnResult> {
  let finalMessage = ''
  let settled = false
  let settle!: (result: TurnResult) => void
  const resultPromise = new Promise<TurnResult>(resolveResult => {
    settle = resolveResult
  })

  const finish = (result: TurnResult) => {
    if (settled) return
    settled = true
    settle(result)
  }

  const unsubscribe = client.on('session:event', (value: unknown) => {
    const event = value as InternalSessionEvent
    if (event.sessionId !== sessionId) return
    adapter.accept(event)

    if (args.kind === 'run' && args.outputFormat === 'stream-json') {
      process.stdout.write(`${JSON.stringify(event)}\n`)
    }
    if (event.type === 'text_delta') {
      const delta = String(event.delta ?? '')
      finalMessage += delta
      if (args.kind === 'run' && args.outputFormat !== 'stream-json') process.stdout.write(delta)
      return
    }
    if (event.type === 'tool_start' && args.kind === 'run' && args.outputFormat !== 'stream-json') {
      process.stdout.write(`\n[tool: ${event.toolName || 'tool'}${event.toolIntent ? ` — ${event.toolIntent}` : ''}]\n`)
      return
    }
    if (event.type === 'tool_result' && args.kind === 'run' && args.outputFormat !== 'stream-json') {
      const output = String(event.result ?? '')
      if (output) process.stdout.write(`${output.length > 200 ? `${output.slice(0, 200)}...` : output}\n`)
      return
    }
    if (event.type === 'complete') finish({ status: 'completed', finalMessage })
    if (event.type === 'interrupted') finish({ status: 'interrupted', finalMessage: '' })
    if (event.type === 'error') {
      finish({
        status: 'failed',
        finalMessage: '',
        error: new Error(formatError(event.error ?? 'execution failed', adapter)),
      })
    }
  })

  const installedSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  let receivedSignal: NodeJS.Signals | undefined
  const turnTimeout = args.kind === 'run' && args.sendTimeout
    ? setTimeout(() => {
        void client.invoke('sessions:cancel', sessionId, true).catch(() => {})
        finish({
          status: 'failed',
          finalMessage: '',
          error: new Error(`Send timeout (${args.sendTimeout}ms)`),
        })
      }, args.sendTimeout)
    : undefined
  turnTimeout?.unref()
  const signalHandler = (signal: NodeJS.Signals) => {
    if (receivedSignal) return
    receivedSignal = signal
    void client.invoke('sessions:cancel', sessionId, true).catch(() => {})
    finish({ status: 'interrupted', finalMessage: '', signal })
  }
  for (const signal of installedSignals) process.on(signal, signalHandler)

  try {
    await client.invoke('sessions:sendMessage', sessionId, prompt)
    return await resultPromise
  } catch (error) {
    return { status: 'failed', finalMessage: '', error: error instanceof Error ? error : new Error(String(error)) }
  } finally {
    if (turnTimeout) clearTimeout(turnTimeout)
    unsubscribe()
    for (const signal of installedSignals) process.off(signal, signalHandler)
  }
}

async function resolveResumeRecord(args: ExecutionArgs): Promise<CliThreadRecord> {
  if (args.last) {
    const scope = await resolveConfigurationScope(args.workspace)
    const workingDirectory = await ensureDirectory(args.workingDirectory || process.cwd(), !!args.workingDirectory)
    let record: CliThreadRecord | undefined
    for (const candidate of await listCliThreads()) {
      if (
        candidate.metadata.origin === 'cli-exec'
        && candidate.metadata.persistence === 'persistent'
        && candidate.metadata.configurationScopeId === scope.id
        && candidate.metadata.workingDirectory === workingDirectory
        && !(await isCliThreadActive(candidate))
      ) {
        record = candidate
        break
      }
    }
    if (!record) throw new Error('no resumable CLI exec Thread found for this workspace and directory')
    return record
  }

  const record = args.threadId ? await locateCliThread(args.threadId) : null
  if (!record) throw new Error(`CLI Thread not found: ${args.threadId}`)
  if (record.metadata.origin !== 'cli-exec' || record.metadata.persistence !== 'persistent') {
    throw new Error(`Thread ${record.metadata.threadId} is not a resumable cli-exec Thread`)
  }
  return record
}

async function createOrResolveExecution(
  args: ExecutionArgs,
): Promise<{ record: CliThreadRecord; scope: ConfigurationScope; workingDirectory: string }> {
  if (args.kind === 'resume') {
    const original = await resolveResumeRecord(args)
    let record = original
    if (args.ephemeral) {
      const sourceLease = await acquireCliThreadLease(original)
      try {
        record = await cloneCliThreadEphemeral(original)
      } finally {
        await sourceLease.release()
      }
    }
    const scope = await scopeFromThread(original, args.workspace)
    const workingDirectory = await ensureDirectory(
      args.workingDirectory || original.metadata.workingDirectory,
      !!args.workingDirectory,
    )
    return { record, scope, workingDirectory }
  }

  const scope = await resolveConfigurationScope(args.workspace)
  const workingDirectory = await ensureDirectory(
    args.workingDirectory || process.cwd(),
    !!args.workingDirectory,
  )
  const record = await createCliThread({
    origin: args.kind === 'run' ? 'cli-run' : 'cli-exec',
    configurationScopeId: scope.id,
    configurationWorkspaceId: scope.workspace?.id,
    configurationWorkspacePath: scope.path,
    workingDirectory,
    persistence: args.kind === 'run'
      ? args.noCleanup ? 'persistent' : 'ephemeral'
      : args.ephemeral ? 'ephemeral' : 'persistent',
    connection: args.provider || args.model || args.baseUrl
      ? {
          provider: args.provider,
          model: args.model,
          baseUrl: args.baseUrl,
        }
      : undefined,
  })
  return { record, scope, workingDirectory }
}

async function executeTurn(args: ExecutionArgs, prompt: string): Promise<number> {
  await cleanupStaleEphemeralThreads().catch(() => {})
  const execution = await createOrResolveExecution(args)
  const { record, scope, workingDirectory } = execution
  const lease = await acquireCliThreadLease(record)
  const resolvedConnection = await resolveConnection(args, record, scope)
  if (resolvedConnection.connection) {
    await updateCliThread(record, {
      connection: {
        slug: resolvedConnection.connection.slug,
        provider: resolvedConnection.connection.piAuthProvider || 'anthropic',
        model: resolvedConnection.model,
        baseUrl: resolvedConnection.connection.baseUrl,
        connectionType: resolvedConnection.connection.providerType,
      },
    })
  }

  const adapter = new ExecEventAdapter({
    json: args.kind !== 'run' && args.json,
    secrets: [args.apiKey, resolvedConnection.apiKey],
  })

  let server: SpawnedServer | undefined
  let client: CliRpcClient | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let result: TurnResult = { status: 'failed', finalMessage: '', error: new Error('execution did not start') }
  let cleanupError: Error | undefined
  let outputWriteError: Error | undefined
  let protocolStarted = false

  try {
    const snapshotRoot = await createConfigurationSnapshot(record, scope)
    const workspace = { ...runtimeWorkspace(scope), rootPath: snapshotRoot }
    server = await spawnServer({
      serverEntry: args.serverEntry,
      startupTimeout: args.startupTimeout,
      quiet: !args.verbose,
      env: {
        POLO_AI_RUNTIME_PROFILE: 'cli-one-shot',
        POLO_AI_CLI_RUNTIME_CONFIG: JSON.stringify({
          sessionsRoot: record.sessionsRoot,
          workspace,
          connection: resolvedConnection.connection,
        }),
        POLO_AI_CLI_API_KEY: resolvedConnection.apiKey || '',
        POLO_AI_CLI_OWNER_PID: String(process.pid),
        POLO_AI_CLI_OWNER_FILE: record.ownerFile,
        POLO_AI_CLI_LEASE_ID: lease.owner.leaseId,
      },
    })
    await lease.heartbeat({ pid: server.pid, startedAt: server.startedAt })
    heartbeatTimer = setInterval(() => {
      void lease.heartbeat().catch(error => {
        cleanupError = error instanceof Error ? error : new Error(String(error))
      })
    }, 2000)
    heartbeatTimer.unref()

    client = new CliRpcClient(server.url, {
      token: server.token,
      requestTimeout: args.startupTimeout,
      connectTimeout: args.startupTimeout,
      workspaceId: workspace.id,
    })
    await client.connect()

    let sessionId = record.metadata.mainSessionId
    if (!sessionId) {
      const created = await client.invoke('sessions:create', workspace.id, {
        permissionMode: args.permissionMode,
        enabledSourceSlugs: args.sources.length > 0 ? args.sources : undefined,
        workingDirectory,
        hidden: true,
        origin: args.kind === 'run' ? 'cli-run' : 'cli-exec',
        model: resolvedConnection.model,
        llmConnection: resolvedConnection.connection?.slug,
      }) as { id: string }
      sessionId = created.id
      await updateCliThread(record, { mainSessionId: sessionId })
    } else {
      await client.invoke('sessions:command', sessionId, {
        type: 'updateWorkingDirectory',
        dir: workingDirectory,
      })
      await client.invoke('sessions:command', sessionId, {
        type: 'setPermissionMode',
        mode: args.permissionMode,
      })
      if (resolvedConnection.model || resolvedConnection.connection) {
        await client.invoke(
          'session:setModel',
          sessionId,
          workspace.id,
          resolvedConnection.model || null,
          resolvedConnection.connection?.slug,
        )
      }
    }

    if (args.kind !== 'run') {
      adapter.start(record.metadata.threadId)
      protocolStarted = true
    }
    result = await waitForTurn(client, sessionId, prompt, args, adapter)
    if (result.status === 'completed' && args.kind !== 'run') {
      adapter.agentMessage(result.finalMessage)
    }
  } catch (error) {
    result = {
      status: 'failed',
      finalMessage: '',
      error: error instanceof Error ? error : new Error(String(error)),
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    client?.destroy()
    if (server) {
      try {
        await server.stop()
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error))
      }
    }

    if (cleanupError) {
      result = { status: 'failed', finalMessage: '', error: cleanupError }
    }

    try {
      await updateCliThread(record, {
        status: result.status,
        lastUsedAt: Date.now(),
        workingDirectory,
        configurationWorkspaceId: scope.workspace?.id,
        configurationWorkspacePath: scope.path,
      })
      if (result.status === 'completed' && args.outputLastMessage) {
        await atomicWriteLastMessage(args.outputLastMessage, result.finalMessage)
      }
    } catch (error) {
      outputWriteError = error instanceof Error ? error : new Error(String(error))
      result = { status: 'failed', finalMessage: '', error: outputWriteError }
      await updateCliThread(record, { status: 'failed', lastUsedAt: Date.now() }).catch(() => {})
    }

    try {
      await lease.release()
      if (record.metadata.persistence === 'ephemeral') await deleteCliThread(record)
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error))
      result = { status: 'failed', finalMessage: '', error: cleanupError }
    }
  }

  if (args.kind === 'run') {
    if (result.status === 'completed' && args.outputFormat !== 'stream-json') process.stdout.write('\n')
    if (result.status !== 'completed' && result.error) {
      process.stderr.write(`Error: ${formatError(result.error, adapter)}\n`)
    }
    if (args.noCleanup) {
      process.stderr.write(`thread_id: ${record.metadata.threadId}\nthread_dir: ${record.directory}\n`)
    }
  } else if (protocolStarted) {
    if (result.status === 'completed') {
      adapter.completed()
    } else {
      adapter.failed(result.error || `execution ${result.status}`, result.signal)
    }
  } else if (result.error) {
    process.stderr.write(`Error: ${formatError(result.error, adapter)}\n`)
  }

  if (args.kind !== 'run' && !args.json && result.status === 'completed') {
    process.stdout.write(`${result.finalMessage}\n`)
  }
  if (args.kind !== 'run' && !args.json && result.status !== 'completed' && result.error) {
    process.stderr.write(`Error: ${formatError(result.error, adapter)}\n`)
  }

  if (result.signal) return signalExitCode(result.signal)
  return result.status === 'completed' ? 0 : 1
}

function printExecutionHelp(kind: 'run' | 'exec'): void {
  if (kind === 'run') {
    process.stdout.write(`Usage: polo run [OPTIONS] [PROMPT...]

Run a streaming Polo CLI session in an isolated ephemeral Thread.

Options:
  --workspace <id>       Configuration workspace
  -C, --cd <dir>         Execution directory
  --source <slug>        Enable a source (repeatable)
  --mode <mode>          safe, ask, or allow-all (default: allow-all)
  --output-format <fmt>  text or stream-json
  --no-cleanup           Retain the debug Thread under the CLI root
  --workspace-dir <dir>  Compatibility: registered workspace plus cwd
  --send-timeout <ms>    Legacy run turn timeout (default: 300000)
  --stdin                Read stdin even when a prompt is present
  --provider/--model/--api-key/--base-url
  -h, --help             Show help
  -V, --version          Show version
`)
    return
  }
  process.stdout.write(`Usage: polo exec [OPTIONS] [PROMPT]
       polo exec resume <thread_id> [PROMPT]
       polo exec resume --last [PROMPT]
       polo exec sessions
       polo exec delete <thread_id>

Execute non-interactively in an isolated CLI Thread.

Options:
  --workspace <id>       Configuration workspace
  -C, --cd <dir>         Execution directory
  --yolo                  Use Polo allow-all permission mode
  --dangerously-bypass-approvals-and-sandbox
  --json                  Emit stable JSONL events
  -m, --model <id>        Invocation-only model
  --provider <name>       Invocation-only provider
  --api-key <key>         Invocation-only credential
  --base-url <url>        Invocation-only endpoint
  --ephemeral             Delete the temporary Thread after cleanup
  --color <mode>          always, never, or auto (stderr only)
  -o, --output-last-message <file>
  -h, --help              Show help
  -V, --version           Show version
`)
}

async function listSessionsCommand(args: ExecutionArgs): Promise<number> {
  const scope = await resolveConfigurationScope(args.workspace)
  const workingDirectory = await ensureDirectory(
    args.workingDirectory || process.cwd(),
    !!args.workingDirectory,
  )
  const records = (await listCliThreads()).filter(record =>
    record.metadata.origin === 'cli-exec'
    && record.metadata.persistence === 'persistent'
    && record.metadata.configurationScopeId === scope.id
    && record.metadata.workingDirectory === workingDirectory
  )
  if (args.json) {
    for (const record of records) process.stdout.write(`${JSON.stringify(record.metadata)}\n`)
    return 0
  }
  for (const record of records) {
    const metadata = record.metadata
    process.stdout.write(
      `${metadata.threadId}\t${metadata.status || 'unknown'}\t${new Date(metadata.createdAt).toISOString()}\t${new Date(metadata.lastUsedAt).toISOString()}\t${metadata.workingDirectory}\n`,
    )
  }
  return 0
}

async function deleteSessionCommand(args: ExecutionArgs): Promise<number> {
  const record = args.threadId ? await locateCliThread(args.threadId) : null
  if (!record || record.metadata.origin !== 'cli-exec') {
    process.stderr.write(`Error: CLI exec Thread not found: ${args.threadId}\n`)
    return 1
  }
  try {
    await deleteCliThread(record)
    if (args.json) process.stdout.write(`${JSON.stringify({ deleted: record.metadata.threadId })}\n`)
    else process.stdout.write(`${record.metadata.threadId}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`Error: ${formatError(error)}\n`)
    return 1
  }
}

export async function runExecutionCommand(args: ExecutionArgs): Promise<number> {
  if (args.kind === 'version') {
    const pkg = await import('../package.json')
    process.stdout.write(`${pkg.version ?? pkg.default?.version ?? 'unknown'}\n`)
    return 0
  }
  if (args.kind === 'help') {
    printExecutionHelp(args.entryCommand)
    return 0
  }
  if (args.kind === 'sessions') return listSessionsCommand(args)
  if (args.kind === 'delete') return deleteSessionCommand(args)

  const prompt = await readExecutionPrompt(args.prompt, args.forceStdin)
  if (!prompt.trim()) throw new UsageError('no prompt provided')
  return executeTurn(args, prompt)
}
