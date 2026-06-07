import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { HandlerFn, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'

const LLM_RPC_MODULE = pathToFileURL(join(import.meta.dir, 'llm-connections.ts')).href

const removedChannels = [
  RPC_CHANNELS.llmConnections.LIST_WITH_STATUS,
  RPC_CHANNELS.llmConnections.GET_API_KEY,
  RPC_CHANNELS.llmConnections.SAVE,
  RPC_CHANNELS.llmConnections.DELETE,
  RPC_CHANNELS.llmConnections.TEST,
  RPC_CHANNELS.llmConnections.SET_DEFAULT,
  RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT,
  RPC_CHANNELS.llmConnections.REFRESH_MODELS,
  RPC_CHANNELS.settings.SETUP_LLM_CONNECTION,
  RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP,
  RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS,
  RPC_CHANNELS.chatgpt.GET_AUTH_STATUS,
  RPC_CHANNELS.chatgpt.LOGOUT,
  RPC_CHANNELS.copilot.START_OAUTH,
  RPC_CHANNELS.copilot.CANCEL_OAUTH,
  RPC_CHANNELS.copilot.GET_AUTH_STATUS,
  RPC_CHANNELS.copilot.LOGOUT,
] as const

function makeConnection(slug: string) {
  return {
    slug,
    name: slug === 'anthropic-admin' ? 'Anthropic Admin' : 'OpenAI Admin',
    providerType: slug === 'anthropic-admin' ? 'anthropic' : 'pi',
    authType: 'api_key',
    createdAt: Date.now(),
    models: slug === 'anthropic-admin' ? ['claude-sonnet-4-6'] : ['pi/gpt-5'],
    defaultModel: slug === 'anthropic-admin' ? 'claude-sonnet-4-6' : 'pi/gpt-5',
  }
}

function setupConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'polo-ai-llm-rpc-'))
  const workspaceRoot = join(configDir, 'workspaces', 'admin-workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify({
      id: 'ws-config-1',
      name: 'Admin Workspace',
      slug: 'admin-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2),
    'utf-8',
  )
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      workspaces: [{ id: 'ws-1', name: 'Admin Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      defaultLlmConnection: 'anthropic-admin',
      llmConnections: [
        makeConnection('anthropic-admin'),
        makeConnection('openai-admin'),
      ],
    }, null, 2),
    'utf-8',
  )
  return configDir
}

async function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() {
      return false
    },
    findClientsWithCapability() {
      return []
    },
  }
  const deps: HandlerDeps = {
    sessionManager: {
      reinitializeAuth: async () => {},
      refreshConnectionRuntime: async () => {},
    } as Partial<HandlerDeps['sessionManager']> as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  }

  const mod = await import(LLM_RPC_MODULE)
  mod.registerLlmConnectionsHandlers(server, deps)

  return { handlers, handledChannels: mod.HANDLED_CHANNELS as readonly string[] }
}

function runReadHandlersInIsolatedProcess(configDir: string) {
  const script = `
    const { RPC_CHANNELS } = await import('@polo-ai/shared/protocol')
    const mod = await import(${JSON.stringify(LLM_RPC_MODULE)})
    const handlers = new Map()
    const server = {
      handle(channel, handler) { handlers.set(channel, handler) },
      push() {},
      async invokeClient() { return undefined },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    }
    const deps = {
      sessionManager: {},
      platform: {
        appRootPath: '/',
        resourcesPath: '/',
        isPackaged: false,
        appVersion: '0.0.0-test',
        isDebugMode: true,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        imageProcessor: {
          async getMetadata() { return null },
          async process() { return Buffer.from('') },
        },
      },
    }
    mod.registerLlmConnectionsHandlers(server, deps)
    const ctx = {
      clientId: 'client-1',
      workspaceId: 'ws-1',
      webContentsId: 1,
      userId: 'user-1',
      username: 'admin',
      userRole: 'admin',
      userJwt: 'jwt',
    }
    const list = await handlers.get(RPC_CHANNELS.llmConnections.LIST)(ctx)
    const get = await handlers.get(RPC_CHANNELS.llmConnections.GET)(ctx, 'openai-admin')
    console.log(JSON.stringify({ list, get }))
  `
  const result = Bun.spawnSync([process.execPath, '--eval', script], {
    env: { ...process.env, POLO_AI_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`read handler subprocess failed:\n${result.stderr.toString()}`)
  }
  return JSON.parse(result.stdout.toString())
}

describe('registerLlmConnectionsHandlers', () => {
  it('registers only LIST and GET handlers', async () => {
    const { handlers, handledChannels } = await createHarness()

    expect(handledChannels).toEqual([
      RPC_CHANNELS.llmConnections.LIST,
      RPC_CHANNELS.llmConnections.GET,
    ])
    expect([...handlers.keys()].sort()).toEqual([
      RPC_CHANNELS.llmConnections.GET,
      RPC_CHANNELS.llmConnections.LIST,
    ].sort())
    for (const channel of removedChannels) {
      expect(handlers.has(channel), channel).toBe(false)
    }
  })

  it('LIST and GET read Admin-sourced connections from StoredConfig', async () => {
    const result = runReadHandlersInIsolatedProcess(setupConfigDir())

    expect(result.list).toMatchObject([
      { slug: 'anthropic-admin', name: 'Anthropic Admin' },
      { slug: 'openai-admin', name: 'OpenAI Admin' },
    ])
    expect(result.get).toMatchObject({
      slug: 'openai-admin',
      name: 'OpenAI Admin',
    })
  })
})
