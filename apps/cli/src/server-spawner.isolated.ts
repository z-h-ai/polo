import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeElectronRuntimeDiscovery } from '@polo-ai/shared/runtime-discovery'
import { CliRpcClient } from './client'
import {
  findServerEntry,
  resolveBunExecutable,
  spawnServer,
  type SpawnedServer,
} from './server-spawner'
import { connectForRun, parseArgs } from './index'

const roots: string[] = []
const activeServers: SpawnedServer[] = []
const originalServerEntry = process.env.POLO_AI_SERVER_ENTRY
const originalBun = process.env.POLO_AI_BUN
const originalConfigDir = process.env.POLO_AI_CONFIG_DIR
const originalDiscoveryFile = process.env.POLO_AI_RUNTIME_DISCOVERY_FILE
const originalServerUrl = process.env.POLO_AI_SERVER_URL
const originalServerToken = process.env.POLO_AI_SERVER_TOKEN

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map(server => server.stop().catch(() => {})))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalServerEntry === undefined) delete process.env.POLO_AI_SERVER_ENTRY
  else process.env.POLO_AI_SERVER_ENTRY = originalServerEntry
  if (originalBun === undefined) delete process.env.POLO_AI_BUN
  else process.env.POLO_AI_BUN = originalBun
  if (originalConfigDir === undefined) delete process.env.POLO_AI_CONFIG_DIR
  else process.env.POLO_AI_CONFIG_DIR = originalConfigDir
  if (originalDiscoveryFile === undefined) delete process.env.POLO_AI_RUNTIME_DISCOVERY_FILE
  else process.env.POLO_AI_RUNTIME_DISCOVERY_FILE = originalDiscoveryFile
  if (originalServerUrl === undefined) delete process.env.POLO_AI_SERVER_URL
  else process.env.POLO_AI_SERVER_URL = originalServerUrl
  if (originalServerToken === undefined) delete process.env.POLO_AI_SERVER_TOKEN
  else process.env.POLO_AI_SERVER_TOKEN = originalServerToken
})

async function prepareSharedConfig(): Promise<{ configDir: string; globalLock: string }> {
  const root = join(tmpdir(), `polo-server-spawner-${crypto.randomUUID()}`)
  const configDir = join(root, 'user-config')
  const globalLock = join(configDir, '.server.lock')
  roots.push(root)
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    llmConnections: [{
      slug: 'shared-test',
      name: 'Shared test connection',
      providerType: 'pi_compat',
      authType: 'api_key',
      baseUrl: 'http://127.0.0.1:1',
      customEndpoint: { api: 'openai-completions' },
      createdAt: Date.now(),
    }],
    defaultLlmConnection: 'shared-test',
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  }))
  const { SecureStorageBackend } = await import(
    '../../../packages/shared/src/credentials/backends/secure-storage'
  )
  const credentialStore = new SecureStorageBackend({ credentialsDir: configDir })
  await credentialStore.set(
    { type: 'llm_api_key', connectionSlug: 'shared-test' },
    { value: 'sk-shared-test-credential' },
  )
  // Simulate the long-lived Electron server owning the historical global lock.
  writeFileSync(globalLock, JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
  }))
  process.env.POLO_AI_CONFIG_DIR = configDir
  delete process.env.POLO_AI_SERVER_URL
  delete process.env.POLO_AI_SERVER_TOKEN
  return { configDir, globalLock }
}

const sourceServerEntry = resolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  'packages',
  'server',
  'src',
  'index.ts',
)

describe('packaged server resolution', () => {
  it('resolves the sibling packaged server artifact', () => {
    delete process.env.POLO_AI_SERVER_ENTRY
    const root = join(tmpdir(), `polo-server-resolve-${crypto.randomUUID()}`)
    roots.push(root)
    const cliDir = join(root, 'dist', 'cli')
    const server = join(root, 'dist', 'server', 'polo-server.js')
    mkdirSync(join(root, 'dist', 'server'), { recursive: true })
    mkdirSync(cliDir, { recursive: true })
    writeFileSync(server, '')

    expect(findServerEntry(cliDir)).toBe(server)
  })

  it('uses and validates an explicit packaged server entry', () => {
    const root = join(tmpdir(), `polo-server-env-${crypto.randomUUID()}`)
    roots.push(root)
    mkdirSync(root, { recursive: true })
    const server = join(root, 'server.js')
    writeFileSync(server, '')
    process.env.POLO_AI_SERVER_ENTRY = server
    expect(findServerEntry(root)).toBe(server)

    process.env.POLO_AI_SERVER_ENTRY = join(root, 'missing.js')
    expect(() => findServerEntry(root)).toThrow('not found')
  })

  it('prefers the bundled Bun path from the launcher', () => {
    process.env.POLO_AI_BUN = '/opt/Polo AI/vendor/bun/bun'
    expect(resolveBunExecutable()).toBe('/opt/Polo AI/vendor/bun/bun')
  })

  it('runs two temporary servers with private locks while sharing user config', async () => {
    const { configDir, globalLock } = await prepareSharedConfig()

    const first = await spawnServer({
      serverEntry: sourceServerEntry,
      startupTimeout: 60_000,
      quiet: true,
    })
    activeServers.push(first)
    const second = await spawnServer({
      serverEntry: sourceServerEntry,
      startupTimeout: 60_000,
      quiet: true,
    })
    activeServers.push(second)

    expect(new URL(first.url).port).not.toBe(new URL(second.url).port)
    expect(first.token).not.toBe(second.token)
    expect(first.runtimeDir).not.toBe(second.runtimeDir)
    expect(existsSync(join(first.runtimeDir, '.server.lock'))).toBe(true)
    expect(existsSync(join(second.runtimeDir, '.server.lock'))).toBe(true)
    expect(existsSync(join(first.runtimeDir, 'config.json'))).toBe(false)
    expect(existsSync(join(second.runtimeDir, 'credentials.enc'))).toBe(false)
    expect(existsSync(join(configDir, 'config.json'))).toBe(true)
    expect(existsSync(globalLock)).toBe(true)

    const secondClient = new CliRpcClient(second.url, {
      token: second.token,
      expectedServerVersion: '0.10.0',
    })
    await secondClient.connect()
    const sharedConnections = await secondClient.invoke(
      'LLM_Connection:listWithStatus',
    ) as Array<{ slug: string; isAuthenticated: boolean }>
    expect(sharedConnections).toContainEqual(expect.objectContaining({
      slug: 'shared-test',
      isAuthenticated: true,
    }))

    await first.stop()
    expect(existsSync(first.runtimeDir)).toBe(false)
    expect(existsSync(second.runtimeDir)).toBe(true)
    expect(secondClient.isConnected).toBe(true)

    secondClient.destroy()
    await second.stop()
    expect(existsSync(second.runtimeDir)).toBe(false)
    expect(existsSync(globalLock)).toBe(true)
  }, 120_000)

  it('falls back from stale discovery despite an Electron-owned global lock', async () => {
    const { globalLock } = await prepareSharedConfig()
    const runtimeRoot = join(tmpdir(), `polo-runtime-${crypto.randomUUID()}`)
    const runtimeFile = join(runtimeRoot, 'electron.json')
    roots.push(runtimeRoot)
    process.env.POLO_AI_RUNTIME_DISCOVERY_FILE = runtimeFile

    const deadServer = Bun.serve({
      port: 0,
      fetch: () => new Response('unused'),
    })
    const deadUrl = `ws://127.0.0.1:${deadServer.port}`
    deadServer.stop(true)
    writeElectronRuntimeDiscovery({
      pid: process.pid,
      url: deadUrl,
      token: 'unreachable-token-0123456789',
      version: '0.10.0',
    })

    const args = parseArgs([
      'bun', 'index.ts',
      '--server-entry', sourceServerEntry,
      '--timeout', '500',
      'run', 'hello',
    ])
    const connection = await connectForRun(args)

    expect(connection.source).toBe('temporary')
    expect(existsSync(runtimeFile)).toBe(false)
    expect(existsSync(globalLock)).toBe(true)
    expect(connection.client.isConnected).toBe(true)

    connection.client.destroy()
    await connection.stop?.()
  }, 120_000)
})
