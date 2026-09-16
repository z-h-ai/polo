import { afterEach, describe, expect, it } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS, type FileAttachment } from '@polo-ai/shared/protocol'
import { RootedSessionStorage } from '@polo-ai/shared/sessions'
import type { StoredAttachment } from '@polo-ai/core/types'
import type { RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { registerFilesHandlers } from './files.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

function registerStoreHandler(input: {
  storage: RootedSessionStorage
  workspaceRoot: string
  sessionId: string
}) {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
  const server = {
    handle(channel: string, handler: (...args: any[]) => Promise<unknown>) {
      handlers.set(channel, handler)
    },
  } as unknown as RpcServer
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  }
  const deps = {
    sessionStorage: input.storage,
    sessionManager: {
      getWorkspaces: () => [{
        id: 'workspace-1',
        name: 'Workspace',
        rootPath: input.workspaceRoot,
      }],
      getSessionPath: (sessionId: string) =>
        sessionId === input.sessionId
          ? input.storage.getSessionPath(input.workspaceRoot, sessionId)
          : null,
    },
    platform: {
      appRootPath: input.workspaceRoot,
      resourcesPath: input.workspaceRoot,
      isPackaged: false,
      appVersion: 'test',
      isDebugMode: false,
      logger,
      imageProcessor: {
        async getMetadata() {
          return null
        },
        async process() {
          return Buffer.from('private-thumbnail')
        },
      },
    },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerFilesHandlers(server, deps)
  const handler = handlers.get(RPC_CHANNELS.file.STORE_ATTACHMENT)
  if (!handler) throw new Error('STORE_ATTACHMENT handler was not registered')
  return (attachment: FileAttachment) => handler(
    { clientId: 'client-1', workspaceId: 'workspace-1' },
    input.sessionId,
    attachment,
  ) as Promise<StoredAttachment>
}

describe('files RPC attachment storage boundary', () => {
  it('rejects an attachments directory replaced by a symlink', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'polo-files-rpc-symlink-'))
    tempDirs.push(temp)
    const controlledRoot = join(temp, 'cli-sessions')
    const sessionsRoot = join(controlledRoot, 'scope', 'executions', 'thread', 'sessions')
    const outside = join(temp, 'outside')
    const storage = new RootedSessionStorage(sessionsRoot, { controlledRoot })
    const sessionId = 'session-1'
    const workspaceRoot = join(temp, 'configuration-snapshot')
    storage.ensureSession(workspaceRoot, sessionId)
    await rm(storage.getAttachmentsPath(workspaceRoot, sessionId), {
      recursive: true,
      force: true,
    })
    await mkdir(outside)
    await Bun.write(join(outside, '.keep'), '')
    await symlink(outside, storage.getAttachmentsPath(workspaceRoot, sessionId), 'dir')
    const store = registerStoreHandler({ storage, workspaceRoot, sessionId })

    await expect(store({
      type: 'text',
      path: '/user-selected/note.txt',
      name: 'note.txt',
      mimeType: 'text/plain',
      size: 5,
      text: 'hello',
    })).rejects.toThrow('symlink')
    expect(await readdir(outside)).toEqual(['.keep'])
  })

  it('writes attachments and generated sidecars with private modes', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'polo-files-rpc-mode-'))
    tempDirs.push(temp)
    const controlledRoot = join(temp, 'cli-sessions')
    const sessionsRoot = join(controlledRoot, 'scope', 'executions', 'thread', 'sessions')
    const storage = new RootedSessionStorage(sessionsRoot, { controlledRoot })
    const sessionId = 'session-1'
    const workspaceRoot = join(temp, 'configuration-snapshot')
    storage.ensureSession(workspaceRoot, sessionId)
    const store = registerStoreHandler({ storage, workspaceRoot, sessionId })

    const stored = await store({
      type: 'text',
      path: '/user-selected/note.txt',
      name: 'note.txt',
      mimeType: 'text/plain',
      size: 5,
      text: 'hello',
    })

    expect(stored.storedPath).toStartWith(storage.getAttachmentsPath(workspaceRoot, sessionId))
    expect(stored.thumbnailPath).toBeTruthy()
    if (process.platform !== 'win32') {
      expect((await stat(storage.getAttachmentsPath(workspaceRoot, sessionId))).mode & 0o777)
        .toBe(0o700)
      expect((await stat(stored.storedPath)).mode & 0o777).toBe(0o600)
      expect((await stat(stored.thumbnailPath!)).mode & 0o777).toBe(0o600)
    }
  })
})
