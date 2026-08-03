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
import {
  getCredentialManager,
  type StoredCredential,
} from '@polo-ai/shared/credentials'
import { RootedSessionStorage, type SessionHeader } from '@polo-ai/shared/sessions'
import { CliRpcClient } from './client.ts'
import {
  acquireCliThreadLease,
  cleanupStaleEphemeralThreads,
  cloneCliThreadEphemeral,
  createCliThread,
  deleteCliThread,
  getCliSessionsRoot,
  isCliThreadActive,
  listCliThreads,
  locateCliThread,
  repairAbandonedCliThread,
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
import { PROVIDER_ENV_KEYS } from './provider-env.ts'
import { spawnServer, type SpawnedServer } from './server-spawner.ts'
import { stderrErrorLine, stderrLabel, stripAnsi } from './terminal-output.ts'

export interface ConfigurationScope {
  id: string
  workspace?: Workspace
  path: string
}

export interface TurnResult {
  status: CliThreadStatus
  finalMessage: string
  error?: Error
  signal?: NodeJS.Signals
}

function configRoot(): string {
  return resolve(process.env.POLO_AI_CONFIG_DIR || join(homedir(), '.polo-ai'))
}

const SENSITIVE_BASE_URL_QUERY =
  /^(?:api[-_]?key|access[-_]?token|auth(?:orization)?|bearer|credential|oauth[-_]?token|password|secret|token)$/i

export function normalizeCredentialFreeBaseUrl(value: string): string {
  const trimmed = value.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('base URL must be a valid absolute URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('base URL must use http or https')
  }
  if (parsed.username || parsed.password) {
    throw new Error('base URL must not contain userinfo credentials')
  }
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_BASE_URL_QUERY.test(key)) {
      throw new Error(`base URL must not contain sensitive query parameter: ${key}`)
    }
  }
  if (parsed.hash) {
    throw new Error('base URL must not contain a fragment')
  }
  return trimmed
}

function normalizeInvocationBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return normalizeCredentialFreeBaseUrl(value)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

async function ensureDirectory(
  path: string,
  options: { throwUsageError?: boolean } = {},
): Promise<string> {
  try {
    const canonical = await realpath(path)
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new Error('not a directory')
    return canonical
  } catch {
    const error = new (options.throwUsageError ? UsageError : Error)(
      `directory does not exist: ${path}`,
    )
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

const CONFIGURATION_SNAPSHOT_ENTRIES = new Set([
  'config.json',
  'sources',
  'skills',
  'statuses',
  'labels',
  '.claude-plugin',
  'permissions.json',
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

export async function createConfigurationSnapshot(
  record: CliThreadRecord,
  scope: ConfigurationScope,
): Promise<string> {
  const snapshotRoot = join(record.directory, 'config-snapshot')
  await rm(snapshotRoot, { recursive: true, force: true })
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 })

  try {
    const entries = await readdir(scope.path, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && scope.id === 'global') return []
      throw error
    })
    for (const entry of entries) {
      // A CLI Thread only needs the immutable configuration inputs consumed by
      // the agent runtime. Copying arbitrary workspace state would persist
      // unrelated automation, messaging, history, or retry-queue secrets.
      if (!CONFIGURATION_SNAPSHOT_ENTRIES.has(entry.name)) continue
      // Global config.json contains application state and connection metadata;
      // the CLI runtime receives its selected connection through the invocation
      // bootstrap and gets a minimal global workspace manifest below.
      if (scope.id === 'global' && entry.name === 'config.json') continue
      await cp(join(scope.path, entry.name), join(snapshotRoot, entry.name), {
        recursive: true,
        force: false,
        errorOnExist: true,
        // Never follow configuration symlinks while building a persistent
        // Thread. makePrivateTree rejects any copied link before the runtime
        // can observe the snapshot, preventing links from importing files
        // outside the selected configuration scope.
        dereference: false,
        filter: source => {
          const name = basename(source)
          return name !== '.credential-cache.json'
            && name !== 'credentials.enc'
            && name !== 'credentials.json'
            && name !== '.env'
        },
      })
    }

    // Validate the copied scope before writing any seeded files through paths
    // it supplied. In particular, a workspace-controlled `permissions`
    // symlink must not redirect the app-level default copy outside the Thread.
    await makePrivateTree(snapshotRoot)

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

    // CLI-first startup cannot rely on Electron having initialized the config
    // root. Seed the private snapshot from the bundled, read-only defaults.
    const bundledResource = (name: string): string | undefined => {
      const bundledRoot = process.env.POLO_AI_BUNDLED_ASSETS_ROOT
      const candidates = [
        // Packaged launchers set the root of the assembled distribution;
        // bundled assets live directly under <root>/resources.
        ...(bundledRoot ? [join(bundledRoot, 'resources', name)] : []),
        // Preserve source-tree support for callers that provide repository
        // root rather than the Electron app/resources directory.
        ...(bundledRoot ? [join(bundledRoot, 'apps', 'electron', 'resources', name)] : []),
        join(import.meta.dir, '..', '..', '..', 'apps', 'electron', 'resources', name),
      ]
      return candidates.find(candidate => Bun.file(candidate).size > 0)
    }
    const bundledDefaults = bundledResource('config-defaults.json')
    if (!bundledDefaults) throw new Error('bundled config-defaults.json is unavailable')
    await cp(bundledDefaults, join(snapshotRoot, 'config-defaults.json'), { force: true })

    // Safe exec must use the same invocation-start app-level permissions that
    // Electron currently uses, even when the selected configuration scope is
    // a workspace. Fall back to the bundled defaults only on a fresh install.
    const appPermissions = join(configRoot(), 'permissions', 'default.json')
    const bundledPermissions = bundledResource(join('permissions', 'default.json'))
    const permissionsSource = Bun.file(appPermissions).size > 0
      ? appPermissions
      : bundledPermissions
    if (!permissionsSource) throw new Error('default permissions are unavailable')
    const permissionsDirectory = join(snapshotRoot, 'permissions')
    await mkdir(permissionsDirectory, { recursive: true, mode: 0o700 })
    await rm(join(permissionsDirectory, 'default.json'), { force: true })
    await cp(permissionsSource, join(permissionsDirectory, 'default.json'), {
      force: false,
      errorOnExist: true,
      dereference: false,
    })

    await makePrivateTree(snapshotRoot)
    return snapshotRoot
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function resolveInvocationApiKey(args: ExecutionArgs, provider?: string): string | undefined {
  if (args.apiKey) return args.apiKey
  if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY
  if (!provider) return undefined
  const envKey = PROVIDER_ENV_KEYS[provider]
  return envKey ? process.env[envKey] : undefined
}

function canonicalConnectionBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const parsed = new URL(normalizeCredentialFreeBaseUrl(value))
  parsed.hash = ''
  parsed.searchParams.sort()
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  }
  return parsed.toString()
}

function connectionMatchesInvocationIdentity(
  connection: LlmConnection,
  args: Pick<ExecutionArgs, 'provider' | 'baseUrl'>,
): boolean {
  if (args.provider) {
    const providers = new Set([
      connection.providerType,
      connection.type,
      connection.piAuthProvider,
    ].filter((value): value is string => !!value))
    if (!providers.has(args.provider)) return false
  }
  if (args.baseUrl) {
    if (
      canonicalConnectionBaseUrl(connection.baseUrl)
      !== canonicalConnectionBaseUrl(args.baseUrl)
    ) {
      return false
    }
  }
  return true
}

async function resolveInvocationCredential(
  args: ExecutionArgs,
  provider: string | undefined,
  identity: LlmConnection | undefined,
  includeStoredIdentity: boolean,
): Promise<StoredCredential | undefined> {
  const invocation = resolveInvocationApiKey(args, provider)
  if (invocation) return { value: invocation }
  if (!identity || !includeStoredIdentity) return undefined
  const manager = getCredentialManager()
  if (identity.authType === 'oauth') {
    const oauth = await manager.getLlmOAuth(identity.slug)
    return oauth
      ? {
          value: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          expiresAt: oauth.expiresAt,
          idToken: oauth.idToken,
        }
      : undefined
  }
  const apiKey = await manager.getLlmApiKey(identity.slug)
  return apiKey ? { value: apiKey } : undefined
}

function makeInvocationConnection(input: {
  slug: string
  provider: string
  baseUrl?: string
  model?: string
  providerType?: LlmConnection['providerType']
  authType?: LlmConnection['authType']
  customEndpoint?: LlmConnection['customEndpoint']
}): LlmConnection {
  const customEndpoint = input.customEndpoint ?? (input.baseUrl
    ? { api: input.provider === 'anthropic' ? 'anthropic-messages' as const : 'openai-completions' as const }
    : undefined)
  return {
    slug: input.slug,
    name: `${input.provider} (CLI invocation)`,
    providerType: input.providerType
      ?? (input.baseUrl ? 'pi_compat' : input.provider === 'anthropic' ? 'anthropic' : 'pi'),
    authType: input.authType ?? 'api_key',
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

export async function resolveConnection(
  args: ExecutionArgs,
  record: CliThreadRecord,
  scope: ConfigurationScope,
): Promise<{
  connection?: LlmConnection
  apiKey?: string
  credential?: StoredCredential
  model?: string
}> {
  const config = loadStoredConfigReadonly()
  const workspaceDefault = await loadWorkspaceConnectionDefault(scope)
  const defaultSlug = workspaceDefault || config?.defaultLlmConnection
  const defaultConnection = config?.llmConnections?.find(connection => connection.slug === defaultSlug)
    ?? config?.llmConnections?.[0]
  const saved = record.metadata.connection
  const configuredConnections = config?.llmConnections ?? []
  const orderedConnections = defaultConnection
    ? [
        defaultConnection,
        ...configuredConnections.filter(connection => connection.slug !== defaultConnection.slug),
      ]
    : configuredConnections
  const hasExplicitIdentity = !!(args.provider || args.baseUrl)
  const explicitIdentity = hasExplicitIdentity
    ? orderedConnections.find(connection =>
        connectionMatchesInvocationIdentity(connection, args)
      )
    : undefined
  const savedIdentity = saved?.slug
    ? configuredConnections.find(connection => connection.slug === saved.slug)
    : undefined
  const selectedConnection = explicitIdentity
    ?? (!hasExplicitIdentity ? savedIdentity ?? defaultConnection : undefined)
  const provider = args.provider
    ?? (!hasExplicitIdentity ? saved?.provider : undefined)
    ?? selectedConnection?.piAuthProvider
    ?? selectedConnection?.providerType
  const baseUrlCandidate = args.baseUrl
    ?? (!hasExplicitIdentity ? saved?.baseUrl : undefined)
    ?? selectedConnection?.baseUrl
  const baseUrl = baseUrlCandidate
    ? normalizeCredentialFreeBaseUrl(baseUrlCandidate)
    : undefined
  const model = args.model
    ?? (!hasExplicitIdentity ? saved?.model : undefined)
    ?? selectedConnection?.defaultModel
  const hasExplicitConnectionOverride = !!(args.provider || args.baseUrl)
  // A Thread's persisted non-secret snapshot precedes mutable current
  // defaults, even when a config connection with the same slug still exists.
  const needsSavedSyntheticConnection = !hasExplicitConnectionOverride && !!saved
  const needsSyntheticConnection = (hasExplicitConnectionOverride && !explicitIdentity)
    || needsSavedSyntheticConnection
    || (!selectedConnection && !!args.apiKey)
  if (!needsSyntheticConnection && selectedConnection) {
    const connection = {
      ...selectedConnection,
      baseUrl,
      defaultModel: model,
    }
    const credential = await resolveInvocationCredential(
      args,
      connection.piAuthProvider ?? connection.providerType,
      selectedConnection,
      hasExplicitIdentity,
    )
    return {
      connection,
      apiKey: credential?.value,
      credential,
      model,
    }
  }
  if (!needsSyntheticConnection) return { model }

  const effectiveProvider = provider || 'anthropic'
  const slug = saved?.slug || `cli-${record.metadata.threadId}`
  const retainSavedConnectionShape = !!saved && !hasExplicitConnectionOverride
  const credential = await resolveInvocationCredential(
    args,
    effectiveProvider,
    savedIdentity,
    hasExplicitIdentity,
  )
  return {
    connection: makeInvocationConnection({
      slug,
      provider: effectiveProvider,
      baseUrl,
      model,
      providerType: retainSavedConnectionShape ? saved.connectionType : undefined,
      authType: retainSavedConnectionShape ? saved.authType : undefined,
      customEndpoint: retainSavedConnectionShape ? saved.customEndpoint : undefined,
    }),
    apiKey: credential?.value,
    credential,
    model,
  }
}

function credentialSecretValues(
  credential: StoredCredential | undefined,
): Array<string | undefined> {
  if (!credential) return []
  return [
    credential.value,
    credential.refreshToken,
    credential.clientSecret,
    credential.idToken,
    credential.awsSessionToken,
  ]
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

const NON_INTERRUPT_SIGNALS = new Set([
  'SIGCHLD',
  'SIGCONT',
  'SIGURG',
  'SIGWINCH',
])

export function getCatchableInterruptSignals(): NodeJS.Signals[] {
  return (Object.keys(osConstants.signals) as NodeJS.Signals[])
    .filter(signal =>
      signal.startsWith('SIG')
      && signal !== 'SIGKILL'
      && signal !== 'SIGSTOP'
      && !NON_INTERRUPT_SIGNALS.has(signal),
    )
}

function formatError(error: unknown, adapter?: ExecEventAdapter): string {
  const message = error instanceof Error ? error.message : String(error)
  return adapter ? adapter.redact(message) : message
}

export async function waitForTurn(
  client: CliRpcClient,
  sessionId: string,
  prompt: string,
  args: ExecutionArgs,
  adapter: ExecEventAdapter,
  options: {
    lifecycleFailure?: Promise<Error>
    interrupted?: Promise<NodeJS.Signals>
  } = {},
): Promise<TurnResult> {
  let finalMessage = ''
  let pendingText = ''
  let sawFinalTextComplete = false
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
      pendingText += delta
      if (args.kind === 'run' && args.outputFormat !== 'stream-json') {
        process.stdout.write(stripAnsi(delta))
      }
      return
    }
    if (event.type === 'text_complete') {
      if (event.isIntermediate) {
        pendingText = ''
      } else {
        finalMessage = typeof event.text === 'string' ? event.text : pendingText
        pendingText = ''
        sawFinalTextComplete = true
      }
      return
    }
    if (event.type === 'tool_start' && args.kind === 'run' && args.outputFormat !== 'stream-json') {
      process.stdout.write(stripAnsi(
        `\n[tool: ${event.toolName || 'tool'}${event.toolIntent ? ` — ${event.toolIntent}` : ''}]\n`,
      ))
      return
    }
    if (event.type === 'tool_result' && args.kind === 'run' && args.outputFormat !== 'stream-json') {
      const output = stripAnsi(String(event.result ?? ''))
      if (output) {
        process.stdout.write(`${output.length > 200 ? `${output.slice(0, 200)}...` : output}\n`)
      }
      return
    }
    if (event.type === 'complete') {
      finish({
        status: 'completed',
        finalMessage: sawFinalTextComplete ? finalMessage : pendingText,
      })
    }
    if (event.type === 'interrupted') finish({ status: 'interrupted', finalMessage: '' })
    if (event.type === 'error') {
      finish({
        status: 'failed',
        finalMessage: '',
        error: new Error(formatError(event.error ?? 'execution failed', adapter)),
      })
    }
    if (event.type === 'typed_error') {
      const typed = event.error && typeof event.error === 'object'
        ? event.error as { message?: string; title?: string; code?: string }
        : undefined
      finish({
        status: 'failed',
        finalMessage: '',
        error: new Error(formatError(
          typed?.message || typed?.title || typed?.code || 'provider execution failed',
          adapter,
        )),
      })
    }
  })

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

  try {
    await client.invoke('sessions:sendMessage', sessionId, prompt)
    const failed = (error: Error): TurnResult => {
      void client.invoke('sessions:cancel', sessionId, true).catch(() => {})
      return { status: 'failed', finalMessage: '', error }
    }
    const competitors: Array<Promise<TurnResult>> = [
      resultPromise,
      client.waitForDisconnect().then(failed),
    ]
    if (options.lifecycleFailure) {
      competitors.push(options.lifecycleFailure.then(failed))
    }
    if (options.interrupted) {
      competitors.push(options.interrupted.then(signal => {
        void client.invoke('sessions:cancel', sessionId, true).catch(() => {})
        return { status: 'interrupted', finalMessage: '', signal }
      }))
    }
    return await Promise.race(competitors)
  } catch (error) {
    return { status: 'failed', finalMessage: '', error: error instanceof Error ? error : new Error(String(error)) }
  } finally {
    if (turnTimeout) clearTimeout(turnTimeout)
    unsubscribe()
  }
}

async function resolveResumeRecord(args: ExecutionArgs): Promise<CliThreadRecord> {
  if (args.last) {
    const scope = await resolveConfigurationScope(args.workspace)
    const workingDirectory = await ensureDirectory(
      args.workingDirectory || process.cwd(),
      { throwUsageError: !!args.workingDirectory },
    )
    let record: CliThreadRecord | undefined
    for (const candidate of await listCliThreads()) {
      if (
        candidate.metadata.origin !== 'cli-exec'
        || candidate.metadata.persistence !== 'persistent'
        || candidate.metadata.configurationScopeId !== scope.id
        || candidate.metadata.workingDirectory !== workingDirectory
        || await isCliThreadActive(candidate)
      ) continue
      const summary = await readCliMainSessionSummary(candidate)
      if (summary.state !== 'ok') continue
      record = candidate
      break
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
    // Validate every user/config-derived path before creating an ephemeral
    // clone. A failed workspace or -C override must not leave an ownerless
    // temporary Thread behind.
    const scope = await scopeFromThread(original, args.workspace)
    const workingDirectory = await ensureDirectory(
      args.workingDirectory || original.metadata.workingDirectory,
      { throwUsageError: !!args.workingDirectory },
    )
    let record = original
    if (args.ephemeral) {
      const sourceLease = await acquireCliThreadLease(original, {
        purpose: 'clone-source',
      })
      try {
        record = await cloneCliThreadEphemeral(original)
      } finally {
        await sourceLease.release()
      }
    }
    return { record, scope, workingDirectory }
  }

  const scope = await resolveConfigurationScope(args.workspace)
  const workingDirectory = await ensureDirectory(
    args.workingDirectory || process.cwd(),
    { throwUsageError: !!args.workingDirectory },
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
          baseUrl: normalizeInvocationBaseUrl(args.baseUrl),
        }
      : undefined,
  })
  return { record, scope, workingDirectory }
}

export type ExecutionLifecycleStage =
  | 'thread:create'
  | 'snapshot'
  | 'spawnServer'
  | 'connect'
  | 'session:create'

export interface ExecuteTurnOptions {
  /**
   * Test-only dependency injection used by subprocess integration fixtures to
   * hold an exact lifecycle boundary while a real OS signal is delivered.
   */
  lifecycleStageHook?: (
    stage: ExecutionLifecycleStage,
    state: {
      threadId?: string
      directory?: string
      mainSessionId?: string
      persistence?: CliThreadRecord['metadata']['persistence']
    },
  ) => void | Promise<void>
}

export async function executeTurn(
  args: ExecutionArgs,
  prompt: string,
  options: ExecuteTurnOptions = {},
): Promise<number> {
  let record: CliThreadRecord | undefined
  let scope: ConfigurationScope | undefined
  let workingDirectory: string | undefined
  let lease: Awaited<ReturnType<typeof acquireCliThreadLease>> | undefined
  let adapter: ExecEventAdapter | undefined
  let server: SpawnedServer | undefined
  let client: CliRpcClient | undefined
  let currentSessionId: string | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let result: TurnResult = { status: 'failed', finalMessage: '', error: new Error('execution did not start') }
  let cleanupError: Error | undefined
  let outputWriteError: Error | undefined
  let protocolStarted = false
  let lifecycleState: 'initializing' | 'leased' | 'runtime' | 'cleaning' | 'cleaned' = 'initializing'
  let cleanupPromise: Promise<void> | undefined
  let threadDeleted = false
  let reportLifecycleFailure!: (error: Error) => void
  let lifecycleFailureReported = false
  const lifecycleFailure = new Promise<Error>(resolveFailure => {
    reportLifecycleFailure = (error) => {
      if (lifecycleFailureReported) return
      lifecycleFailureReported = true
      resolveFailure(error)
    }
  })
  const ownsNewThread = args.kind !== 'resume' || args.ephemeral

  let receivedSignal: NodeJS.Signals | undefined
  let resolveInterrupted!: (signal: NodeJS.Signals) => void
  const interrupted = new Promise<NodeJS.Signals>(resolveSignal => {
    resolveInterrupted = resolveSignal
  })
  const installedSignals: NodeJS.Signals[] = []

  const cancelActiveSession = async (): Promise<void> => {
    if (!client) return
    if (!currentSessionId) {
      // Break an in-flight connect/session:create request so startup signals
      // do not wait for the RPC timeout before entering cleanup.
      client.destroy()
      return
    }
    await client.invoke('sessions:cancel', currentSessionId, true).catch(() => {})
  }
  const applyReceivedSignal = (): void => {
    if (!receivedSignal || cleanupError) return
    result = {
      status: 'interrupted',
      finalMessage: '',
      signal: receivedSignal,
    }
  }
  const signalHandler = (signal: NodeJS.Signals): void => {
    if (receivedSignal) return
    receivedSignal = signal
    applyReceivedSignal()
    resolveInterrupted(signal)
    void cancelActiveSession()
  }
  const throwIfInterrupted = async (): Promise<void> => {
    if (!receivedSignal) return
    await cancelActiveSession()
    throw new Error(`execution interrupted by ${receivedSignal}`)
  }
  const completeStage = async (stage: ExecutionLifecycleStage): Promise<void> => {
    await options.lifecycleStageHook?.(stage, {
      threadId: record?.metadata.threadId,
      directory: record?.directory,
      mainSessionId: record?.metadata.mainSessionId,
      persistence: record?.metadata.persistence,
    })
    await throwIfInterrupted()
  }

  // Install process-wide handlers before the first await. They remain active
  // through runtime shutdown, persistence, retention and lease release.
  for (const signal of getCatchableInterruptSignals()) {
    try {
      process.on(signal, signalHandler)
      installedSignals.push(signal)
    } catch {
      // Signal availability differs by platform and Node/Bun runtime.
    }
  }

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      lifecycleState = 'cleaning'
      // Phase 1: stop accepting events and terminate the private runtime.
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      applyReceivedSignal()
      if (receivedSignal) await cancelActiveSession()
      if (server) {
        try {
          await server.stop()
        } catch (error) {
          const diagnostics = server.diagnostics()
          cleanupError = new Error(
            `${error instanceof Error ? error.message : String(error)}${diagnostics ? `\n${diagnostics}` : ''}`,
          )
        }
      }
      client?.destroy()

      if (cleanupError) {
        result = { status: 'failed', finalMessage: '', error: cleanupError }
      } else {
        applyReceivedSignal()
      }

      // Phase 2: persist the terminal Thread state and atomically publish -o.
      if (record && scope && workingDirectory && (lease || ownsNewThread)) {
        try {
          await updateCliThread(record, {
            status: result.status,
            lastUsedAt: Date.now(),
            ...(ownsNewThread
              ? {
                  workingDirectory,
                  configurationWorkspaceId: scope.workspace?.id,
                  configurationWorkspacePath: scope.path,
                }
              : {}),
          })
          applyReceivedSignal()
          if (
            receivedSignal
            && !cleanupError
            && record.metadata.status !== 'interrupted'
          ) {
            await updateCliThread(record, {
              status: 'interrupted',
              lastUsedAt: Date.now(),
            })
          }
          if (result.status === 'completed' && args.outputLastMessage) {
            await atomicWriteLastMessage(args.outputLastMessage, result.finalMessage)
          }
        } catch (error) {
          outputWriteError = error instanceof Error ? error : new Error(String(error))
          result = { status: 'failed', finalMessage: '', error: outputWriteError }
          await updateCliThread(record, { status: 'failed', lastUsedAt: Date.now() }).catch(() => {})
        }
      }

      // Phase 3: ephemeral retention enters deleting and moves to trash while
      // the final lease evidence is still durable. Persistent Threads release
      // ownership normally. Both paths are serialized by the Thread state lock.
      try {
        if (
          record
          && record.metadata.persistence === 'ephemeral'
          && (lease || ownsNewThread)
        ) {
          await deleteCliThread(record, {
            expectedLeaseId: lease?.owner.leaseId,
          })
          threadDeleted = true
        } else {
          await lease?.release()
        }
      } catch (error) {
        await lease?.release().catch(() => {})
        cleanupError = error instanceof Error ? error : new Error(String(error))
        result = { status: 'failed', finalMessage: '', error: cleanupError }
      }
      applyReceivedSignal()
      if (
        receivedSignal
        && !cleanupError
        && record
        && !threadDeleted
        && record.metadata.status !== 'interrupted'
      ) {
        try {
          await updateCliThread(record, {
            status: 'interrupted',
            lastUsedAt: Date.now(),
          })
        } catch (error) {
          cleanupError = error instanceof Error ? error : new Error(String(error))
          result = { status: 'failed', finalMessage: '', error: cleanupError }
        }
      }
      lifecycleState = 'cleaned'
    })()
    return cleanupPromise
  }

  try {
    await cleanupStaleEphemeralThreads().catch(() => {})
    await throwIfInterrupted()
    const execution = await createOrResolveExecution(args)
    record = execution.record
    scope = execution.scope
    workingDirectory = execution.workingDirectory
    await completeStage('thread:create')
    lease = await acquireCliThreadLease(record)
    lifecycleState = 'leased'
    await throwIfInterrupted()

    const resolvedConnection = await resolveConnection(args, record, scope)
    await throwIfInterrupted()
    // A normal resume borrows the original Thread and its saved connection.
    // Explicit invocation overrides configure only this runtime; persisting
    // them here would silently change every later no-argument resume. New
    // Threads (including resume --ephemeral clones) own their metadata and
    // may safely record the effective non-secret connection snapshot.
    if (resolvedConnection.connection && ownsNewThread) {
      await updateCliThread(record, {
        connection: {
          slug: resolvedConnection.connection.slug,
          provider: resolvedConnection.connection.piAuthProvider || 'anthropic',
          model: resolvedConnection.model,
          baseUrl: resolvedConnection.connection.baseUrl,
          connectionType: resolvedConnection.connection.providerType,
          authType: resolvedConnection.connection.authType,
          customEndpoint: resolvedConnection.connection.customEndpoint,
        },
      })
    }
    await throwIfInterrupted()
    adapter = new ExecEventAdapter({
      json: args.kind !== 'run' && args.json,
      secrets: [
        args.apiKey,
        ...credentialSecretValues(resolvedConnection.credential),
      ],
    })

    const snapshotRoot = await createConfigurationSnapshot(record, scope)
    await completeStage('snapshot')
    const workspace = { ...runtimeWorkspace(scope), rootPath: snapshotRoot }
    server = await spawnServer({
      serverEntry: args.serverEntry,
      startupTimeout: args.startupTimeout,
      quiet: !args.verbose,
      env: {
        POLO_AI_RUNTIME_PROFILE: 'cli-one-shot',
        POLO_AI_CONFIG_DIR: snapshotRoot,
        POLO_AI_SHARED_CREDENTIALS_DIR: configRoot(),
        HOME: snapshotRoot,
        USERPROFILE: snapshotRoot,
      },
      secrets: [
        args.apiKey,
        ...credentialSecretValues(resolvedConnection.credential),
      ],
      bootstrapPayload: {
        runtimeConfig: {
          sessionsRoot: record.sessionsRoot,
          controlledRoot: getCliSessionsRoot(),
          workspace,
          connection: resolvedConnection.connection,
        },
        credential: resolvedConnection.credential,
        owner: {
          pid: process.pid,
          ownerFile: record.ownerFile,
          leaseId: lease.owner.leaseId,
          processIdentity: lease.owner.cliProcessIdentity,
        },
      },
    })
    await completeStage('spawnServer')
    await lease.heartbeat({
      pid: server.pid,
      startedAt: server.startedAt,
      processIdentity: server.processIdentity,
    })
    await throwIfInterrupted()
    const activeLease = lease
    lifecycleState = 'runtime'
    heartbeatTimer = setInterval(() => {
      void activeLease.heartbeat().catch(error => {
        cleanupError = error instanceof Error ? error : new Error(String(error))
        reportLifecycleFailure(cleanupError)
        void client?.invoke('sessions:cancel', record?.metadata.mainSessionId, true)
          .catch(() => {})
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
    await completeStage('connect')

    let sessionId = record.metadata.mainSessionId
    currentSessionId = sessionId
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
      currentSessionId = sessionId
      await updateCliThread(record, { mainSessionId: sessionId })
      await completeStage('session:create')
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
      await throwIfInterrupted()
    }

    if (args.kind !== 'run') {
      adapter.start(record.metadata.threadId)
      protocolStarted = true
    }
    result = await waitForTurn(client, sessionId, prompt, args, adapter, {
      lifecycleFailure,
      interrupted,
    })
    applyReceivedSignal()
    if (result.status === 'completed' && args.kind !== 'run') {
      adapter.agentMessage(result.finalMessage)
    }
  } catch (error) {
    if (receivedSignal) {
      applyReceivedSignal()
    } else {
      result = {
        status: 'failed',
        finalMessage: '',
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  } finally {
    try {
      await cleanup()
    } finally {
      for (const signal of installedSignals) process.off(signal, signalHandler)
    }
  }

  if (args.kind === 'run') {
    if (result.status === 'completed' && args.outputFormat !== 'stream-json') process.stdout.write('\n')
    if (result.status !== 'completed' && result.error) {
      process.stderr.write(stderrErrorLine(formatError(result.error, adapter), args.color))
    }
    if (args.noCleanup) {
      if (record && !threadDeleted) {
        process.stderr.write(
          `${stderrLabel('thread_id:', args.color)} ${record.metadata.threadId}\n`
          + `${stderrLabel('thread_dir:', args.color)} ${stripAnsi(record.directory)}\n`,
        )
      }
    }
  } else if (protocolStarted) {
    // Phase 4: protocol completion is observable only after runtime shutdown,
    // persistence, output-file publication, retention, and lease release.
    if (result.status === 'completed') {
      adapter?.completed()
    } else {
      adapter?.failed(result.error || `execution ${result.status}`, result.signal)
    }
  } else if (result.error) {
    process.stderr.write(stderrErrorLine(formatError(result.error, adapter), args.color))
  }

  if (args.kind !== 'run' && !args.json && result.status === 'completed') {
    process.stdout.write(`${stripAnsi(result.finalMessage)}\n`)
  }
  if (
    args.kind !== 'run'
    && !args.json
    && protocolStarted
    && result.status !== 'completed'
    && result.error
  ) {
    process.stderr.write(stderrErrorLine(formatError(result.error, adapter), args.color))
  }

  if (result.signal) return signalExitCode(result.signal)
  void lifecycleState
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

export interface CliMainSessionSummary {
  state: 'ok' | 'missing' | 'corrupt'
  sessionId?: string
  name?: string
  messageCount?: number
  lastMessageAt?: number
  preview?: string
  model?: string
  llmConnection?: string
  reason?: string
}

export async function readCliMainSessionSummary(
  record: CliThreadRecord,
): Promise<CliMainSessionSummary> {
  const sessionId = record.metadata.mainSessionId
  if (!sessionId) {
    return { state: 'missing', reason: 'thread metadata has no mainSessionId' }
  }
  try {
    const storage = new RootedSessionStorage(record.sessionsRoot, {
      controlledRoot: getCliSessionsRoot(),
    })
    const sessionFile = storage.getSessionFilePath(
      record.metadata.configurationWorkspacePath,
      sessionId,
    )
    let content: string
    try {
      content = await readFile(sessionFile, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          state: 'missing',
          sessionId,
          reason: 'main session header is missing',
        }
      }
      throw error
    }
    const firstLine = content.split(/\r?\n/, 1)[0]
    if (!firstLine) throw new Error('empty session JSONL')
    const header = JSON.parse(firstLine) as Partial<SessionHeader>
    if (
      header.id !== sessionId
      || typeof header.messageCount !== 'number'
      || !Number.isFinite(header.messageCount)
    ) {
      throw new Error('invalid session header')
    }
    return {
      state: 'ok',
      sessionId,
      name: typeof header.name === 'string' ? header.name : undefined,
      messageCount: header.messageCount,
      lastMessageAt:
        typeof header.lastMessageAt === 'number' ? header.lastMessageAt : undefined,
      preview: typeof header.preview === 'string' ? header.preview : undefined,
      model: typeof header.model === 'string' ? header.model : undefined,
      llmConnection:
        typeof header.llmConnection === 'string' ? header.llmConnection : undefined,
    }
  } catch {
    return {
      state: 'corrupt',
      sessionId,
      reason: 'main session header is unreadable or invalid',
    }
  }
}

async function listSessionsCommand(args: ExecutionArgs): Promise<number> {
  const scope = await resolveConfigurationScope(args.workspace)
  const workingDirectory = await ensureDirectory(
    args.workingDirectory || process.cwd(),
    { throwUsageError: !!args.workingDirectory },
  )
  const records = (await listCliThreads()).filter(record =>
    record.metadata.origin === 'cli-exec'
    && record.metadata.persistence === 'persistent'
    && record.metadata.configurationScopeId === scope.id
    && record.metadata.workingDirectory === workingDirectory
  )
  for (const record of records) await repairAbandonedCliThread(record)
  if (args.json) {
    for (const record of records) {
      process.stdout.write(
        `${JSON.stringify({
          ...record.metadata,
          mainSession: await readCliMainSessionSummary(record),
        })}\n`,
      )
    }
    return 0
  }
  for (const record of records) {
    const metadata = record.metadata
    const mainSession = await readCliMainSessionSummary(record)
    process.stdout.write(
      stripAnsi(
        `${metadata.threadId}\t${metadata.status || 'unknown'}\t${new Date(metadata.createdAt).toISOString()}\t${new Date(metadata.lastUsedAt).toISOString()}\t${metadata.workingDirectory}\t${JSON.stringify(mainSession)}\n`,
      ),
    )
  }
  return 0
}

async function deleteSessionCommand(args: ExecutionArgs): Promise<number> {
  const record = args.threadId ? await locateCliThread(args.threadId) : null
  if (!record || record.metadata.origin !== 'cli-exec') {
    process.stderr.write(stderrErrorLine(`CLI exec Thread not found: ${args.threadId}`, args.color))
    return 1
  }
  try {
    await deleteCliThread(record)
    if (args.json) process.stdout.write(`${JSON.stringify({ deleted: record.metadata.threadId })}\n`)
    else process.stdout.write(`${record.metadata.threadId}\n`)
    return 0
  } catch (error) {
    process.stderr.write(stderrErrorLine(formatError(error), args.color))
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

  args = {
    ...args,
    baseUrl: normalizeInvocationBaseUrl(args.baseUrl),
  }
  const prompt = await readExecutionPrompt(args.prompt, args.forceStdin)
  if (!prompt.trim()) throw new UsageError('no prompt provided')
  return executeTurn(args, prompt)
}
