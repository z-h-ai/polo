import { afterAll, describe, expect, it, mock } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Workspace } from '@polo-ai/core/types'
import type {
  HandlerFn,
  RequestContext,
  RpcServer,
} from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

const temporaryRoot = await mkdtemp(join(tmpdir(), 'creator-skill-rpc-'))
const workspaceOne: Workspace = {
  id: 'workspace-one',
  name: 'Workspace One',
  slug: 'workspace-one',
  rootPath: join(temporaryRoot, 'workspace-one'),
  createdAt: Date.now(),
}
const workspaceTwo: Workspace = {
  id: 'workspace-two',
  name: 'Workspace Two',
  slug: 'workspace-two',
  rootPath: join(temporaryRoot, 'workspace-two'),
  createdAt: Date.now(),
}
await mkdir(workspaceOne.rootPath)
await mkdir(workspaceTwo.rootPath)

mock.module('@polo-ai/shared/config', () => ({
  getWorkspaceByNameOrId: (id: string) => (
    [workspaceOne, workspaceTwo].find(workspace => (
      workspace.id === id || workspace.name === id
    )) ?? null
  ),
}))

const [{ RPC_CHANNELS }, { registerSkillsHandlers }] = await Promise.all([
  import('@polo-ai/shared/protocol'),
  import('./skills'),
])

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
const deps = {
  sessionManager: {
    getWorkspaces: () => [],
  },
  oauthFlowStore: {},
  platform: {
    appRootPath: temporaryRoot,
    resourcesPath: temporaryRoot,
    isPackaged: false,
    appVersion: 'test',
    isDebugMode: true,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    imageProcessor: {
      async getMetadata() {
        return null
      },
      async process() {
        return Buffer.from('')
      },
    },
  },
} as unknown as HandlerDeps
registerSkillsHandlers(server, deps)

const ctx: RequestContext = {
  clientId: 'client-one',
  workspaceId: workspaceOne.id,
  webContentsId: null,
  signal: new AbortController().signal,
}

const installInput = {
  workspaceId: workspaceOne.id,
  operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  grant: {
    artifactId: 'artifact-one',
    organizationId: 'organization-one',
    slug: 'safe-skill',
    version: '1.0.0',
    url: 'https://download.example.test/skill.zip',
    expiresAt: '2030-01-01T00:00:00.000Z',
    archiveChecksum: 'a'.repeat(64),
    contentDigest: 'b'.repeat(64),
    manifest: [],
    validationPolicy: {
      version: '1',
      maxArchiveBytes: 20 * 1024 * 1024,
      maxFileCount: 200,
      maxFileBytes: 5 * 1024 * 1024,
      maxExpandedBytes: 50 * 1024 * 1024,
    },
  },
}

afterAll(async () => {
  await chmod(workspaceOne.rootPath, 0o755).catch(() => {})
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe('Creator Skill workspace RPC boundary', () => {
  it('binds target and mutations to the connection workspace', async () => {
    const getTarget = handlers.get(RPC_CHANNELS.creatorSkills.GET_TARGET)!
    const install = handlers.get(RPC_CHANNELS.creatorSkills.INSTALL)!
    const uninstall = handlers.get(RPC_CHANNELS.creatorSkills.UNINSTALL)!

    expect(await getTarget(ctx, { workspaceId: workspaceTwo.id })).toEqual({
      success: false,
      errorCode: 'workspace_context_mismatch',
    })
    expect(await install(ctx, {
      ...installInput,
      workspaceId: workspaceTwo.id,
    })).toMatchObject({
      success: false,
      errorCode: 'workspace_context_mismatch',
    })
    expect(await uninstall(ctx, {
      workspaceId: workspaceTwo.id,
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      slug: 'safe-skill',
    })).toMatchObject({
      success: false,
      errorCode: 'workspace_context_mismatch',
    })
  })

  it('reports actual writability and rejects mutations for a read-only workspace', async () => {
    const getTarget = handlers.get(RPC_CHANNELS.creatorSkills.GET_TARGET)!
    const install = handlers.get(RPC_CHANNELS.creatorSkills.INSTALL)!
    const uninstall = handlers.get(RPC_CHANNELS.creatorSkills.UNINSTALL)!

    await chmod(workspaceOne.rootPath, 0o555)
    try {
      expect(await getTarget(ctx, { workspaceId: workspaceOne.id })).toMatchObject({
        success: true,
        writable: false,
      })
      expect(await install(ctx, installInput)).toMatchObject({
        success: false,
        errorCode: 'workspace_read_only',
      })
      expect(await uninstall(ctx, {
        workspaceId: workspaceOne.id,
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        slug: 'safe-skill',
      })).toMatchObject({
        success: false,
        errorCode: 'workspace_read_only',
      })
    } finally {
      await chmod(workspaceOne.rootPath, 0o755)
    }
  })
})
