import { afterAll, describe, expect, it } from 'bun:test'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  id: '11111111-1111-4111-8111-111111111111',
  name: '22222222-2222-4222-8222-22222222abcd',
  slug: 'workspace-one',
  rootPath: join(temporaryRoot, 'workspace-one'),
  createdAt: Date.now(),
}
const workspaceTwo: Workspace = {
  id: '22222222-2222-4222-8222-22222222abcd',
  name: 'Workspace Two',
  slug: 'workspace-two',
  rootPath: join(temporaryRoot, 'workspace-two'),
  createdAt: Date.now(),
}
const workspaceCaseCollision: Workspace = {
  id: '33333333-3333-4333-8333-333333333333',
  name: workspaceTwo.id.toUpperCase(),
  slug: 'workspace-case-collision',
  rootPath: join(temporaryRoot, 'workspace-case-collision'),
  createdAt: Date.now(),
}
await mkdir(workspaceOne.rootPath)
await mkdir(workspaceTwo.rootPath)
await mkdir(workspaceCaseCollision.rootPath)
let workspaceOrder = [workspaceOne, workspaceTwo, workspaceCaseCollision]

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
    getWorkspaces: () => workspaceOrder,
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
    const installResult = await install(ctx, {
      ...installInput,
      workspaceId: workspaceTwo.id,
    })
    expect(installResult).toMatchObject({
      success: false,
      errorCode: 'workspace_context_mismatch',
    })
    expect(installResult).not.toHaveProperty('message')
    expect(await uninstall(ctx, {
      workspaceId: workspaceTwo.id,
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      slug: 'safe-skill',
    })).toMatchObject({
      success: false,
      errorCode: 'workspace_context_mismatch',
    })
  })

  it('resolves opaque IDs exactly despite name collisions and workspace order', async () => {
    const getTarget = handlers.get(RPC_CHANNELS.creatorSkills.GET_TARGET)!
    const collisionContext = {
      ...ctx,
      workspaceId: workspaceTwo.id,
    }
    const orders = [
      [workspaceOne, workspaceCaseCollision, workspaceTwo],
      [workspaceCaseCollision, workspaceTwo, workspaceOne],
      [workspaceTwo, workspaceOne, workspaceCaseCollision],
    ]

    for (const order of orders) {
      workspaceOrder = order
      expect(await getTarget(collisionContext, {
        workspaceId: workspaceTwo.id,
      })).toMatchObject({
        success: true,
        workspaceId: workspaceTwo.id,
        name: workspaceTwo.name,
        path: workspaceTwo.rootPath,
      })
    }
    expect(await getTarget(collisionContext, {
      workspaceId: workspaceTwo.id.toUpperCase(),
    })).toEqual({
      success: false,
      errorCode: 'workspace_context_mismatch',
    })
    workspaceOrder = [workspaceOne, workspaceTwo, workspaceCaseCollision]
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
      const installResult = await install(ctx, installInput)
      expect(installResult).toMatchObject({
        success: false,
        errorCode: 'workspace_read_only',
      })
      expect(installResult).not.toHaveProperty('message')
      const uninstallResult = await uninstall(ctx, {
        workspaceId: workspaceOne.id,
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        slug: 'safe-skill',
      })
      expect(uninstallResult).toMatchObject({
        success: false,
        errorCode: 'workspace_read_only',
      })
      expect(uninstallResult).not.toHaveProperty('message')
    } finally {
      await chmod(workspaceOne.rootPath, 0o755)
    }
  })

  it('strictly rejects unsafe delete slugs before touching the workspace', async () => {
    const deleteSkill = handlers.get(RPC_CHANNELS.skills.DELETE)!
    const sentinel = join(workspaceOne.rootPath, 'workspace-sentinel.txt')
    await writeFile(sentinel, 'keep')
    const invalidSlugs = [
      '..',
      '../outside',
      temporaryRoot,
      '..\\outside',
      '../\\outside',
    ]

    for (const skillSlug of invalidSlugs) {
      await expect(deleteSkill(ctx, {
        workspaceId: workspaceOne.id,
        skillSlug,
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      expect(await access(workspaceOne.rootPath).then(() => true, () => false)).toBe(true)
      expect(await access(sentinel).then(() => true, () => false)).toBe(true)
    }

    await expect(deleteSkill(ctx, {
      workspaceId: workspaceOne.id,
      skillSlug: 'safe-skill',
      unexpected: true,
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(await access(workspaceOne.rootPath).then(() => true, () => false)).toBe(true)
    expect(await access(sentinel).then(() => true, () => false)).toBe(true)
  })

  it('never accepts an absolute Creator Skill backup path from the renderer', async () => {
    const deleteBackups = handlers.get(RPC_CHANNELS.creatorSkills.DELETE_BACKUPS)!
    const sentinel = join(workspaceOne.rootPath, 'backup-boundary-sentinel.txt')
    await writeFile(sentinel, 'keep')

    expect(await deleteBackups(ctx, {
      workspaceId: workspaceOne.id,
      path: temporaryRoot,
    })).toEqual({
      success: false,
      errorCode: 'VALIDATION_ERROR',
    })
    expect(await deleteBackups(ctx, {
      workspaceId: workspaceOne.id,
      backup: {
        slug: '..',
        backupId: '2026-07-30T00-00-00-000Z',
      },
    })).toEqual({
      success: false,
      errorCode: 'VALIDATION_ERROR',
    })
    expect(await access(workspaceOne.rootPath).then(() => true, () => false)).toBe(true)
    expect(await access(sentinel).then(() => true, () => false)).toBe(true)
  })
})
