import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireCliThreadLease,
  cleanupStaleEphemeralThreads,
  createCliThread,
  deleteCliThread,
  listCliThreads,
  locateCliThread,
  updateCliThread,
} from './cli-thread-store.ts'

let root = ''
let previousConfigDir: string | undefined

beforeEach(async () => {
  previousConfigDir = process.env.POLO_AI_CONFIG_DIR
  root = await mkdtemp(join(tmpdir(), 'polo-cli-thread-test-'))
  process.env.POLO_AI_CONFIG_DIR = root
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.POLO_AI_CONFIG_DIR
  else process.env.POLO_AI_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
})

async function createExecThread() {
  return createCliThread({
    origin: 'cli-exec',
    configurationScopeId: 'workspace-1',
    configurationWorkspaceId: 'workspace-1',
    configurationWorkspacePath: root,
    workingDirectory: root,
    persistence: 'persistent',
    connection: {
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: 'https://example.test',
    },
  })
}

describe('CLI Thread store', () => {
  it('creates a private Thread tree without persisting secrets', async () => {
    const record = await createExecThread()
    await updateCliThread(record, { mainSessionId: 'session-1', status: 'completed' })

    expect((await locateCliThread(record.metadata.threadId))?.directory).toBe(record.directory)
    expect((await listCliThreads()).map(item => item.metadata.threadId)).toContain(record.metadata.threadId)

    const metadataText = await readFile(join(record.directory, 'thread.json'), 'utf-8')
    expect(metadataText).not.toContain('api-key')
    expect(JSON.parse(metadataText)).toMatchObject({
      origin: 'cli-exec',
      mainSessionId: 'session-1',
      status: 'completed',
    })

    if (process.platform !== 'win32') {
      expect((await stat(record.directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(record.directory, 'thread.json'))).mode & 0o777).toBe(0o600)
    }
  })

  it('enforces a single active lease and releases idempotently', async () => {
    const record = await createExecThread()
    const lease = await acquireCliThreadLease(record)
    await expect(acquireCliThreadLease(record)).rejects.toThrow('already active')
    await lease.release()
    await lease.release()
    const next = await acquireCliThreadLease(record)
    await next.release()
  })

  it('deletes by atomically moving the whole Thread boundary', async () => {
    const record = await createExecThread()
    await deleteCliThread(record)
    expect(await locateCliThread(record.metadata.threadId)).toBeNull()
  })

  it('only reclaims expired ephemeral Threads with dead owners', async () => {
    const ephemeral = await createCliThread({
      origin: 'cli-exec',
      configurationScopeId: 'workspace-1',
      configurationWorkspacePath: root,
      workingDirectory: root,
      persistence: 'ephemeral',
    })
    const persistent = await createExecThread()
    const oldHeartbeat = Date.now() - 11 * 60_000
    for (const record of [ephemeral, persistent]) {
      await writeFile(record.ownerFile, JSON.stringify({
        leaseId: crypto.randomUUID(),
        cliPid: 2_147_483_647,
        cliStartedAt: oldHeartbeat,
        serverPid: 2_147_483_646,
        serverStartedAt: oldHeartbeat,
        heartbeatAt: oldHeartbeat,
      }))
    }

    expect(await cleanupStaleEphemeralThreads()).toBe(1)
    expect(await locateCliThread(ephemeral.metadata.threadId)).toBeNull()
    expect(await locateCliThread(persistent.metadata.threadId)).not.toBeNull()
  })
})
