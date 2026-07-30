import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireCliThreadLease,
  cleanupStaleEphemeralThreads,
  createCliThread,
  deleteCliThread,
  getProcessBirthIdentity,
  isOwnerActive,
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

  it('keeps a fresh lease active but rejects a reused PID after lease expiry', () => {
    const actualIdentity = getProcessBirthIdentity(process.pid)
    expect(actualIdentity).toBeTruthy()
    const owner = {
      leaseId: crypto.randomUUID(),
      cliPid: process.pid,
      cliStartedAt: Date.now(),
      cliProcessIdentity: `${actualIdentity}-different-process`,
      serverPid: 0,
      serverStartedAt: 0,
      heartbeatAt: Date.now(),
    }
    expect(isOwnerActive(owner)).toBe(true)
    expect(isOwnerActive(
      { ...owner, heartbeatAt: Date.now() - 60_000 },
      Date.now(),
    )).toBe(false)
  })

  it('deletes by atomically moving the whole Thread boundary', async () => {
    const record = await createExecThread()
    await deleteCliThread(record)
    expect(await locateCliThread(record.metadata.threadId)).toBeNull()
  })

  it('rejects deletion while a dead process still has a fresh lease heartbeat', async () => {
    const record = await createExecThread()
    await writeFile(record.ownerFile, JSON.stringify({
      leaseId: crypto.randomUUID(),
      cliPid: 2_147_483_647,
      cliStartedAt: Date.now(),
      cliProcessIdentity: 'missing-cli',
      serverPid: 2_147_483_646,
      serverStartedAt: Date.now(),
      serverProcessIdentity: 'missing-runtime',
      heartbeatAt: Date.now(),
    }))

    await expect(deleteCliThread(record)).rejects.toThrow('active')
  })

  it('rejects a symlink Thread target before moving or deleting it', async () => {
    const record = await createExecThread()
    const outside = join(root, 'outside-target')
    await mkdir(outside)
    await rm(record.directory, { recursive: true, force: true })
    await symlink(outside, record.directory, 'dir')

    await expect(deleteCliThread(record)).rejects.toThrow('symlink')
    expect((await stat(outside)).isDirectory()).toBe(true)
  })

  it('rejects scope and executions ancestor symlinks before writing outside the CLI root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'polo-cli-thread-outside-'))
    try {
      const cliRoot = join(root, 'cli-sessions')
      await mkdir(cliRoot)
      await symlink(outside, join(cliRoot, 'workspace-1'), 'dir')

      await expect(createExecThread()).rejects.toThrow('symlink')
      expect(await readdir(outside)).toEqual([])

      await rm(join(cliRoot, 'workspace-1'))
      await mkdir(join(cliRoot, 'workspace-1'))
      await symlink(outside, join(cliRoot, 'workspace-1', 'executions'), 'dir')
      await expect(createExecThread()).rejects.toThrow('symlink')
      expect(await readdir(outside)).toEqual([])

      await rm(cliRoot, { recursive: true, force: true })
      await symlink(outside, cliRoot, 'dir')
      await expect(createExecThread()).rejects.toThrow('unsafe')
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('does not repair source metadata when taking over a stale clone-source lease', async () => {
    const record = await createExecThread()
    const lastUsedAt = Date.now() - 120_000
    await updateCliThread(record, { status: 'completed', lastUsedAt })
    await writeFile(record.ownerFile, JSON.stringify({
      leaseId: crypto.randomUUID(),
      cliPid: 2_147_483_647,
      cliStartedAt: lastUsedAt,
      cliProcessIdentity: 'missing-cli',
      serverPid: 2_147_483_646,
      serverStartedAt: lastUsedAt,
      serverProcessIdentity: 'missing-runtime',
      heartbeatAt: lastUsedAt,
    }))

    const lease = await acquireCliThreadLease(record, { purpose: 'clone-source' })
    await lease.release()

    const metadata = JSON.parse(
      await readFile(join(record.directory, 'thread.json'), 'utf-8'),
    )
    expect(metadata.status).toBe('completed')
    expect(metadata.lastUsedAt).toBe(lastUsedAt)
  })

  it('allows only one process to take over a stale lease under contention', async () => {
    const record = await createExecThread()
    const workerFixture = join(
      import.meta.dir,
      '__fixtures__',
      'lease-takeover-worker.ts',
    )

    for (let round = 0; round < 5; round++) {
      const staleAt = Date.now() - 60_000
      await writeFile(record.ownerFile, JSON.stringify({
        leaseId: crypto.randomUUID(),
        cliPid: 2_147_483_647,
        cliStartedAt: staleAt,
        cliProcessIdentity: 'missing-cli',
        serverPid: 2_147_483_646,
        serverStartedAt: staleAt,
        serverProcessIdentity: 'missing-runtime',
        heartbeatAt: staleAt,
      }))
      const barrier = join(root, `takeover-barrier-${round}`)
      await mkdir(barrier)
      const workers = Array.from({ length: 8 }, (_, index) =>
        Bun.spawn([
          'bun',
          'run',
          workerFixture,
          root,
          record.metadata.threadId,
          barrier,
          String(index),
        ], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, POLO_AI_CONFIG_DIR: root },
        }),
      )
      const readyDeadline = Date.now() + 10_000
      while ((await readdir(barrier)).filter(name => name.endsWith('.ready')).length < workers.length) {
        if (Date.now() >= readyDeadline) throw new Error('workers did not reach takeover barrier')
        await Bun.sleep(10)
      }
      await writeFile(join(barrier, 'start'), '')
      const results = await Promise.all(workers.map(async worker => {
        const [exitCode, stdout, stderr] = await Promise.all([
          worker.exited,
          new Response(worker.stdout).text(),
          new Response(worker.stderr).text(),
        ])
        expect(exitCode, stderr).toBe(0)
        return JSON.parse(stdout.trim()) as { status: string; leaseId?: string }
      }))
      expect(results.filter(result => result.status === 'acquired')).toHaveLength(1)
      expect(new Set(
        results.flatMap(result => result.leaseId ? [result.leaseId] : []),
      ).size).toBe(1)
    }
  }, 30_000)

  it('recovers an orphaned takeover lock only after its identity and safety window expire', async () => {
    const record = await createExecThread()
    const staleAt = Date.now() - 15 * 60_000
    await writeFile(join(record.directory, '.owner.takeover.lock'), JSON.stringify({
      takeoverId: crypto.randomUUID(),
      lockId: crypto.randomUUID(),
      operation: 'acquire',
      pid: 2_147_483_647,
      processIdentity: 'missing-takeover-owner',
      createdAt: staleAt,
    }))

    const lease = await acquireCliThreadLease(record)
    expect(lease.owner.leaseId).toBeTruthy()
    await lease.release()
  })

  it('reclaims an ownerless expired ephemeral Thread left in the pre-delete window', async () => {
    const record = await createCliThread({
      origin: 'cli-exec',
      configurationScopeId: 'workspace-1',
      configurationWorkspacePath: root,
      workingDirectory: root,
      persistence: 'ephemeral',
    })
    await updateCliThread(record, { lastUsedAt: Date.now() - 11 * 60_000 })

    expect(await cleanupStaleEphemeralThreads()).toBe(1)
    expect(await locateCliThread(record.metadata.threadId)).toBeNull()
  })

  it('only reclaims half-created directories proven ephemeral and preserves live or persistent creators', async () => {
    const executionsRoot = join(root, 'cli-sessions', 'workspace-1', 'executions')
    const ephemeralDirectory = join(executionsRoot, crypto.randomUUID())
    const activeDirectory = join(executionsRoot, crypto.randomUUID())
    const persistentDirectory = join(executionsRoot, crypto.randomUUID())
    const unknownDirectory = join(executionsRoot, crypto.randomUUID())
    await Promise.all([
      mkdir(join(ephemeralDirectory, 'sessions'), { recursive: true }),
      mkdir(join(activeDirectory, 'sessions'), { recursive: true }),
      mkdir(join(persistentDirectory, 'sessions'), { recursive: true }),
      mkdir(join(unknownDirectory, 'sessions'), { recursive: true }),
    ])
    const staleAt = new Date(Date.now() - 11 * 60_000)
    const processIdentity = getProcessBirthIdentity(process.pid)
    expect(processIdentity).toBeTruthy()
    const creatingMarker = {
      version: 1,
      origin: 'cli-exec',
      persistence: 'ephemeral',
      pid: 2_147_483_647,
      processIdentity: 'missing-creator',
      createdAt: staleAt.getTime(),
    }
    await Promise.all([
      writeFile(join(ephemeralDirectory, 'creating.json'), JSON.stringify(creatingMarker)),
      writeFile(join(activeDirectory, 'creating.json'), JSON.stringify({
        ...creatingMarker,
        pid: process.pid,
        processIdentity,
      })),
      writeFile(join(persistentDirectory, 'creating.json'), JSON.stringify({
        ...creatingMarker,
        origin: 'cli-run',
        persistence: 'persistent',
      })),
    ])
    await Promise.all([
      utimes(ephemeralDirectory, staleAt, staleAt),
      utimes(activeDirectory, staleAt, staleAt),
      utimes(persistentDirectory, staleAt, staleAt),
      utimes(unknownDirectory, staleAt, staleAt),
    ])

    expect(await listCliThreads()).toEqual([])
    expect(await cleanupStaleEphemeralThreads()).toBe(1)
    expect(await stat(ephemeralDirectory).then(() => true).catch(() => false)).toBe(false)
    expect(await stat(activeDirectory).then(() => true).catch(() => false)).toBe(true)
    expect(await stat(persistentDirectory).then(() => true).catch(() => false)).toBe(true)
    expect(await stat(unknownDirectory).then(() => true).catch(() => false)).toBe(true)
  })

  it('serializes delete and acquire so they can never both succeed', async () => {
    const workerFixture = join(
      import.meta.dir,
      '__fixtures__',
      'thread-state-race-worker.ts',
    )

    for (let round = 0; round < 30; round++) {
      const record = await createExecThread()
      const barrier = join(root, `state-race-barrier-${round}`)
      await mkdir(barrier)
      const workers = (['acquire', 'delete'] as const).map((action, index) =>
        Bun.spawn([
          'bun',
          'run',
          workerFixture,
          root,
          record.metadata.threadId,
          barrier,
          action,
          String(index),
        ], {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, POLO_AI_CONFIG_DIR: root },
        }),
      )
      const readyDeadline = Date.now() + 10_000
      while ((await readdir(barrier)).filter(name => name.endsWith('.ready')).length < 2) {
        if (Date.now() >= readyDeadline) throw new Error('workers did not reach state race barrier')
        await Bun.sleep(5)
      }
      await writeFile(join(barrier, 'start'), '')
      const results = await Promise.all(workers.map(async worker => {
        const [exitCode, stdout, stderr] = await Promise.all([
          worker.exited,
          new Response(worker.stdout).text(),
          new Response(worker.stderr).text(),
        ])
        expect(exitCode, stderr).toBe(0)
        return JSON.parse(stdout.trim()) as { action: string; status: string }
      }))
      expect(results.filter(result => result.status === 'succeeded')).toHaveLength(1)
    }
  }, 60_000)

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
