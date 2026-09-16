import { describe, it, expect, afterEach, mock, beforeEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { writeElectronRuntimeDiscovery } from '@polo-ai/shared/runtime-discovery'
import type { ErrorCode } from '@polo-ai/shared/protocol'
import {
  serializeEnvelope,
  deserializeEnvelope,
} from '@polo-ai/server-core/transport'
import type { SpawnedServer } from './server-spawner.ts'

// ---------------------------------------------------------------------------
// Mock WS server for run command tests
// ---------------------------------------------------------------------------

interface MockServerOptions {
  /** Token published in runtime discovery for this server. */
  token?: string
  /** What LLM_Connection:list returns */
  connections?: unknown[]
  /** What workspaces:get returns */
  workspaces?: unknown[]
  /** Version returned by the WebSocket handshake */
  serverVersion?: string
  /** Simulate a legacy/custom server that predates versioned handshakes. */
  omitServerVersion?: boolean
  /** RPC errors returned after a successful handshake, keyed by channel. */
  requestErrors?: Record<string, { code: ErrorCode; message: string }>
  /** Called when this server receives a handshake, before replying. */
  onHandshake?: () => void
  /** Reject the handshake instead of acknowledging it. */
  handshakeError?: { code: ErrorCode; message: string }
}

interface MockServer {
  url: string
  token: string
  close: () => void
  /** Channels invoked by the client, in order */
  invokedChannels: string[]
  /** Arguments passed to sessions:create */
  createSessionArgs?: unknown[]
  /** All invocation args, keyed by channel */
  invokeArgs: Record<string, unknown[][]>
}

function pushSessionEvents(
  ws: any,
  sessionId: string,
  events: Array<Record<string, unknown>>,
): void {
  setTimeout(() => {
    for (const ev of events) {
      ws.send(serializeEnvelope({
        id: crypto.randomUUID(),
        type: 'event',
        channel: 'session:event',
        args: [{ sessionId, ...ev }],
      }))
    }
  }, 10)
}

function createMockServer(opts?: MockServerOptions): MockServer {
  const token = opts?.token ?? 'test-token-0123456789'
  const invokedChannels: string[] = []
  const invokeArgs: Record<string, unknown[][]> = {}
  let createSessionArgs: unknown[] | undefined
  const connections = opts?.connections ?? []
  const workspaces = opts?.workspaces ?? [{ id: 'ws-1', name: 'Test Workspace' }]

  const server = Bun.serve({
    port: 0,
    fetch(req, svr) {
      if (svr.upgrade(req)) return undefined
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
        const envelope = deserializeEnvelope(raw)

        if (envelope.type === 'handshake') {
          opts?.onHandshake?.()
          if (opts?.handshakeError) {
            ws.send(serializeEnvelope({
              id: crypto.randomUUID(),
              type: 'error',
              error: opts.handshakeError,
            }))
            return
          }
          const acknowledgment = {
            id: crypto.randomUUID(),
            type: 'handshake_ack',
            clientId: 'run-test-client',
            protocolVersion: '1.0',
            ...(!opts?.omitServerVersion
              ? { serverVersion: opts?.serverVersion ?? '0.10.0' }
              : {}),
          } as const
          ws.send(serializeEnvelope(acknowledgment))
          return
        }

        if (envelope.type === 'request') {
          const ch = envelope.channel!
          invokedChannels.push(ch)
          if (!invokeArgs[ch]) invokeArgs[ch] = []
          invokeArgs[ch].push(envelope.args ?? [])

          const requestError = opts?.requestErrors?.[ch]
          if (requestError) {
            ws.send(serializeEnvelope({
              id: envelope.id,
              type: 'response',
              channel: ch,
              error: requestError,
            }))
            return
          }

          let result: unknown
          switch (ch) {
            case 'workspaces:get':
              result = workspaces
              break
            case 'workspaces:create':
              result = { id: 'ws-1', name: 'ci-workspace' }
              break
            case 'window:switchWorkspace':
              result = { ok: true }
              break
            case 'LLM_Connection:list':
              result = connections
              break
            case 'LLM_Connection:save':
              result = { ok: true }
              break
            case 'settings:setupLlmConnection':
              result = { ok: true }
              break
            case 'LLM_Connection:setDefault':
              result = { ok: true }
              break
            case 'sessions:create':
              createSessionArgs = envelope.args
              result = { id: 'run-session-1', name: 'run-test' }
              break
            case 'sessions:sendMessage': {
              ws.send(serializeEnvelope({
                id: envelope.id,
                type: 'response',
                channel: ch,
                result: { started: true },
              }))
              pushSessionEvents(ws, 'run-session-1', [
                { type: 'text_delta', delta: 'Hello ' },
                { type: 'text_delta', delta: 'World' },
                { type: 'complete' },
              ])
              return // already sent response
            }
            case 'sessions:delete':
              result = { deleted: true }
              break
            case 'sessions:cancel':
              result = { cancelled: true }
              break
            default:
              result = null
          }

          ws.send(serializeEnvelope({
            id: envelope.id,
            type: 'response',
            channel: ch,
            result,
          }))
        }
      },
    },
  })

  return {
    url: `ws://localhost:${server.port}`,
    token,
    close: () => server.stop(),
    invokedChannels,
    invokeArgs,
    get createSessionArgs() { return createSessionArgs },
  }
}

// ---------------------------------------------------------------------------
// Mock spawnServer so cmdRun doesn't actually launch a child process
// ---------------------------------------------------------------------------

let mockWsServer: MockServer | null = null
mock.module('./server-spawner.ts', () => ({
  spawnServer: async (): Promise<SpawnedServer> => {
    if (!mockWsServer) throw new Error('mockWsServer not initialized')
    return {
      url: mockWsServer.url,
      token: mockWsServer.token,
      pid: process.pid,
      startedAt: Date.now(),
      processIdentity: `test-process:${process.pid}`,
      diagnostics: () => '',
      runtimeDir: join(tmpdir(), 'mock-polo-run-server'),
      stop: async () => {},
    }
  },
}))

// Import main AFTER mocking
const {
  connectForCommand,
  main,
  parseArgs,
  resolveRunWorkspace,
} = await import('./index.ts')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run command', () => {
  const roots: string[] = []
  let previousRuntimeFile: string | undefined
  let previousServerUrl: string | undefined
  let previousServerToken: string | undefined

  beforeEach(() => {
    previousRuntimeFile = process.env.POLO_AI_RUNTIME_DISCOVERY_FILE
    previousServerUrl = process.env.POLO_AI_SERVER_URL
    previousServerToken = process.env.POLO_AI_SERVER_TOKEN
    delete process.env.POLO_AI_SERVER_URL
    delete process.env.POLO_AI_SERVER_TOKEN
    const runtimeRoot = join(tmpdir(), `polo-run-runtime-${crypto.randomUUID()}`)
    roots.push(runtimeRoot)
    process.env.POLO_AI_RUNTIME_DISCOVERY_FILE = join(runtimeRoot, 'runtime', 'electron.json')
    mockWsServer = createMockServer()
  })

  afterEach(() => {
    mockWsServer?.close()
    mockWsServer = null
    if (previousRuntimeFile === undefined) {
      delete process.env.POLO_AI_RUNTIME_DISCOVERY_FILE
    } else {
      process.env.POLO_AI_RUNTIME_DISCOVERY_FILE = previousRuntimeFile
    }
    if (previousServerUrl === undefined) delete process.env.POLO_AI_SERVER_URL
    else process.env.POLO_AI_SERVER_URL = previousServerUrl
    if (previousServerToken === undefined) delete process.env.POLO_AI_SERVER_TOKEN
    else process.env.POLO_AI_SERVER_TOKEN = previousServerToken
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('parseArgs: run with --source accumulates sources', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--source', 'craft-kb',
      '--source', 'github',
      'run', 'do', 'stuff',
    ])
    expect(args.command).toBe('run')
    expect(args.sources).toEqual(['craft-kb', 'github'])
    expect(args.rest).toEqual(['do', 'stuff'])
  })

  it('parseArgs: --output-format stream-json', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--output-format', 'stream-json',
      'run', 'test',
    ])
    expect(args.outputFormat).toBe('stream-json')
  })

  it('parseArgs: --no-cleanup flag', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--no-cleanup',
      'run', 'test',
    ])
    expect(args.noCleanup).toBe(true)
  })

  it('keeps explicit remote resource commands independent of the installed App version', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({ omitServerVersion: true })
    const args = parseArgs([
      'bun', 'index.ts',
      '--url', mockWsServer.url,
      '--token', mockWsServer.token,
      'sessions',
    ])

    const client = await connectForCommand(args)
    expect(client.serverVersion).toBeNull()
    client.destroy()
  })

  it('preserves healthy discovery after a post-handshake handler error', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({
      requestErrors: {
        'missing:handler': {
          code: 'CHANNEL_NOT_FOUND',
          message: 'No handler for: missing:handler',
        },
      },
    })
    writeElectronRuntimeDiscovery({
      pid: process.pid,
      url: mockWsServer.url,
      token: mockWsServer.token,
      version: '0.10.0',
    })
    const runtimePath = process.env.POLO_AI_RUNTIME_DISCOVERY_FILE!
    const originalExit = process.exit
    let caught: unknown
    try {
      process.exit = ((code?: number) => {
        throw Object.assign(new Error(`process.exit(${code})`), { exitCode: code })
      }) as typeof process.exit
      await main([
        'bun', 'index.ts',
        'invoke', 'missing:handler',
      ])
    } catch (error) {
      caught = error
    } finally {
      process.exit = originalExit
    }

    expect((caught as { exitCode?: number })?.exitCode).toBe(1)
    expect(existsSync(runtimePath)).toBe(true)
  })

  it('does not delete an Electron replacement that races a handshake failure', async () => {
    const replacementServer = createMockServer({
      token: 'replacement-token-0123456789',
    })
    mockWsServer?.close()
    let replacementInstanceId = ''
    mockWsServer = createMockServer({
      token: 'stale-token-0123456789',
      handshakeError: {
        code: 'AUTH_FAILED',
        message: 'stale endpoint rejected the handshake',
      },
      onHandshake() {
        const replacement = writeElectronRuntimeDiscovery({
          pid: process.pid,
          url: replacementServer.url,
          token: replacementServer.token,
          version: '0.10.0',
          startedAt: '2026-07-30T12:00:01.000Z',
        })
        replacementInstanceId = replacement.record.instanceId
      },
    })
    writeElectronRuntimeDiscovery({
      pid: process.pid,
      url: mockWsServer.url,
      token: mockWsServer.token,
      version: '0.10.0',
      startedAt: '2026-07-30T12:00:00.000Z',
    })
    const args = parseArgs([
      'bun', 'index.ts',
      '--timeout', '500',
      'sessions',
    ])

    try {
      await expect(connectForCommand(args)).rejects.toThrow(
        'stale endpoint rejected the handshake',
      )
      const runtimePath = process.env.POLO_AI_RUNTIME_DISCOVERY_FILE!
      const replacement = await import('@polo-ai/shared/runtime-discovery')
        .then(({ readElectronRuntimeDiscovery }) =>
          readElectronRuntimeDiscovery({ path: runtimePath }))
      expect(replacement.status).toBe('available')
      if (replacement.status === 'available') {
        expect(replacement.record.instanceId).toBe(replacementInstanceId)
        expect(replacement.record.url).toBe(replacementServer.url)
        expect(replacement.record.token).toBe(replacementServer.token)
      }
    } finally {
      replacementServer.close()
    }
  })

  it('creates session with correct workspace and options', async () => {
    // We can't easily call cmdRun directly since it calls process.exit.
    // Instead, test the mock server interaction via CliRpcClient to verify
    // the channels and args that cmdRun would invoke.
    const { CliRpcClient } = await import('./client.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    // Simulate what cmdRun does: resolve workspace, create session
    const workspaces = await client.invoke('workspaces:get') as any[]
    expect(workspaces).toHaveLength(1)

    await client.invoke('window:switchWorkspace', workspaces[0].id)

    const session = await client.invoke('sessions:create', 'ws-1', {
      permissionMode: 'allow-all',
      enabledSourceSlugs: ['craft-kb'],
    }) as { id: string }
    expect(session.id).toBe('run-session-1')

    // Verify the create args
    expect(mockWsServer!.createSessionArgs).toEqual([
      'ws-1',
      { permissionMode: 'allow-all', enabledSourceSlugs: ['craft-kb'] },
    ])

    // Verify channel order
    expect(mockWsServer!.invokedChannels).toEqual([
      'workspaces:get',
      'window:switchWorkspace',
      'sessions:create',
    ])

    client.destroy()
  })

  it('streams text events from session', async () => {
    const { CliRpcClient } = await import('./client.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    // Subscribe and collect text deltas
    const deltas: string[] = []
    let completed = false

    const unsub = client.on('session:event', (event: unknown) => {
      const ev = event as { type: string; sessionId: string; delta?: string }
      if (ev.sessionId !== 'run-session-1') return
      if (ev.type === 'text_delta') deltas.push(ev.delta!)
      if (ev.type === 'complete') completed = true
    })

    await client.invoke('sessions:sendMessage', 'run-session-1', 'test')

    // Wait for events
    const deadline = Date.now() + 5_000
    while (!completed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }

    unsub()
    expect(completed).toBe(true)
    expect(deltas).toEqual(['Hello ', 'World'])

    client.destroy()
  })

  it('session delete is called in lifecycle', async () => {
    const { CliRpcClient } = await import('./client.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    await client.invoke('sessions:create', 'ws-1', { permissionMode: 'allow-all' })
    await client.invoke('sessions:delete', 'run-session-1')

    expect(mockWsServer!.invokedChannels).toContain('sessions:create')
    expect(mockWsServer!.invokedChannels).toContain('sessions:delete')

    client.destroy()
  })

  it('spawnServer mock returns expected url and token', async () => {
    const { spawnServer } = await import('./server-spawner.ts')
    const server = await spawnServer()

    expect(server.url).toBe(mockWsServer!.url)
    expect(server.token).toBe(mockWsServer!.token)
    expect(typeof server.stop).toBe('function')
  })

  it('parseArgs: --workspace-dir sets workspaceDir', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--workspace-dir', '/tmp/my-workspace',
      'run', 'hello',
    ])
    expect(args.workspaceDir).toBe('/tmp/my-workspace')
    expect(args.command).toBe('run')
  })

  it('parseArgs: workspaceDir defaults to undefined', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.workspaceDir).toBeUndefined()
  })

  it('registers the caller cwd for a fresh run without --workspace-dir', async () => {
    const freshWorkspace = join(
      tmpdir(),
      `polo-run-fresh-${crypto.randomUUID()}`,
      '项目 with spaces',
    )
    roots.push(join(freshWorkspace, '..'))
    mkdirSync(freshWorkspace, { recursive: true })

    const { CliRpcClient } = await import('./client.ts')
    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    const workspace = await resolveRunWorkspace(client, args, freshWorkspace)

    expect(workspace).toEqual({ id: 'ws-1', registeredPath: freshWorkspace })
    expect(mockWsServer!.invokeArgs['workspaces:create']![0]).toEqual([
      freshWorkspace,
      basename(freshWorkspace),
    ])
    expect(mockWsServer!.invokedChannels).toEqual([
      'workspaces:get',
      'workspaces:create',
      'window:switchWorkspace',
    ])

    client.destroy()
  })

  it('reuses an existing workspace registered for the caller cwd', async () => {
    const workspacePath = join(tmpdir(), `polo-run-existing-${crypto.randomUUID()}`)
    mockWsServer?.close()
    mockWsServer = createMockServer({
      workspaces: [{ id: 'existing-ws', name: 'Custom Name', rootPath: workspacePath }],
    })

    const { CliRpcClient } = await import('./client.ts')
    const client = new CliRpcClient(mockWsServer.url, {
      token: mockWsServer.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(await resolveRunWorkspace(client, args, workspacePath)).toEqual({
      id: 'existing-ws',
      registeredPath: workspacePath,
    })
    expect(mockWsServer.invokedChannels).toEqual([
      'workspaces:get',
      'window:switchWorkspace',
    ])
    expect(mockWsServer.invokedChannels).not.toContain('workspaces:create')

    client.destroy()
  })

  it('workspace:create returns ID used directly (no workspaces:get needed)', async () => {
    const { CliRpcClient } = await import('./client.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    // Simulate the workspace bootstrap path from cmdRun:
    // workspaces:create returns { id }, which is used directly
    const ws = (await client.invoke('workspaces:create', '/tmp/ws', 'ci-workspace')) as { id: string }
    expect(ws.id).toBe('ws-1')

    // Then switchWorkspace is called with the returned ID
    await client.invoke('window:switchWorkspace', ws.id)

    // Session is created with the bootstrapped workspace ID
    await client.invoke('sessions:create', ws.id, {
      permissionMode: 'allow-all',
      enabledSourceSlugs: ['craft-public'],
    })

    expect(mockWsServer!.invokedChannels).toEqual([
      'workspaces:create',
      'window:switchWorkspace',
      'sessions:create',
    ])
    expect(mockWsServer!.invokeArgs['workspaces:create']![0]).toEqual(['/tmp/ws', 'ci-workspace'])

    client.destroy()
  })

  it('LLM bootstrap calls save, setup, and setDefault when no connections exist', async () => {
    // Server returns empty connections list
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [] })

    const { CliRpcClient } = await import('./client.ts')
    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    // Simulate the LLM bootstrap path from cmdRun
    const connections = (await client.invoke('LLM_Connection:list')) as any[]
    expect(connections).toEqual([])

    await client.invoke('LLM_Connection:save', {
      slug: 'anthropic-api',
      name: 'Anthropic',
      providerType: 'anthropic',
      authType: 'api_key',
      createdAt: 123,
    })
    await client.invoke('settings:setupLlmConnection', {
      slug: 'anthropic-api',
      credential: 'sk-test-key',
    })
    await client.invoke('LLM_Connection:setDefault', 'anthropic-api')

    expect(mockWsServer!.invokedChannels).toEqual([
      'LLM_Connection:list',
      'LLM_Connection:save',
      'settings:setupLlmConnection',
      'LLM_Connection:setDefault',
    ])

    client.destroy()
  })

  it('LLM bootstrap is skipped when connections already exist', async () => {
    // Server returns existing connection
    mockWsServer?.close()
    mockWsServer = createMockServer({
      connections: [{ slug: 'existing', name: 'Existing' }],
    })

    const { CliRpcClient } = await import('./client.ts')
    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    // Simulate: check connections — they exist, so skip bootstrap
    const connections = (await client.invoke('LLM_Connection:list')) as any[]
    expect(connections).toHaveLength(1)

    // No further LLM calls should be needed
    expect(mockWsServer!.invokedChannels).toEqual(['LLM_Connection:list'])

    client.destroy()
  })
})
