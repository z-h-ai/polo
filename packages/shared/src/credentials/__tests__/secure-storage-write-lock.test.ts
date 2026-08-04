import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireCredentialWriteLock,
  SecureStorageBackend,
} from '../backends/secure-storage.ts'
import { getProcessBirthIdentity } from '../../utils/process-identity.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('SecureStorageBackend shared writer lock', () => {
  it('merges updates from three independent writer processes', async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), 'polo-credential-process-lock-'))
    tempDirs.push(credentialsDir)
    const worker = join(import.meta.dir, 'fixtures', 'secure-storage-write-worker.ts')
    const writers = ['first', 'second', 'third'].map(slug => Bun.spawn([
      process.execPath,
      worker,
      credentialsDir,
      slug,
      `${slug}-secret`,
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
    }))

    const exits = await Promise.all(writers.map(async writer => ({
      code: await writer.exited,
      stderr: await new Response(writer.stderr).text(),
    })))
    expect(exits).toEqual([
      { code: 0, stderr: '' },
      { code: 0, stderr: '' },
      { code: 0, stderr: '' },
    ])

    const verifier = new SecureStorageBackend({ credentialsDir })
    for (const slug of ['first', 'second', 'third']) {
      expect(await verifier.get({ type: 'llm_api_key', connectionSlug: slug })).toMatchObject({
        value: `${slug}-secret`,
      })
    }
  })

  it('merges concurrent identity updates instead of overwriting the store', async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), 'polo-credential-lock-'))
    tempDirs.push(credentialsDir)
    const first = new SecureStorageBackend({ credentialsDir })
    const second = new SecureStorageBackend({ credentialsDir })
    const third = new SecureStorageBackend({ credentialsDir })

    await Promise.all([
      first.set(
        { type: 'llm_api_key', connectionSlug: 'api' },
        { value: 'api-secret' },
      ),
      second.set(
        { type: 'llm_oauth', connectionSlug: 'oauth' },
        { value: 'access-token', refreshToken: 'refresh-token' },
      ),
      third.set(
        { type: 'source_bearer', workspaceId: 'workspace', sourceId: 'source' },
        { value: 'source-secret' },
      ),
    ])

    const verifier = new SecureStorageBackend({ credentialsDir })
    expect(await verifier.get({ type: 'llm_api_key', connectionSlug: 'api' })).toMatchObject({
      value: 'api-secret',
    })
    expect(await verifier.get({ type: 'llm_oauth', connectionSlug: 'oauth' })).toMatchObject({
      value: 'access-token',
      refreshToken: 'refresh-token',
    })
    expect(await verifier.get({
      type: 'source_bearer',
      workspaceId: 'workspace',
      sourceId: 'source',
    })).toMatchObject({
      value: 'source-secret',
    })
  })

  it('never steals an old-looking lock from a live owner', async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), 'polo-live-credential-lock-'))
    tempDirs.push(credentialsDir)
    const lockDirectory = join(credentialsDir, '.credentials.write.lock')
    const processIdentity = getProcessBirthIdentity(process.pid)
    expect(processIdentity).toBeTruthy()
    mkdirSync(lockDirectory, { mode: 0o700 })
    writeFileSync(join(lockDirectory, 'owner.json'), JSON.stringify({
      version: 1,
      lockId: crypto.randomUUID(),
      pid: process.pid,
      processIdentity,
      createdAt: 1,
      heartbeatAt: 1,
    }))

    const backend = new SecureStorageBackend({
      credentialsDir,
      writeLockOptions: { timeoutMs: 80, retryMs: 10, ownerGraceMs: 1 },
    })
    await expect(backend.set(
      { type: 'llm_api_key', connectionSlug: 'blocked' },
      { value: 'must-not-write' },
    )).rejects.toThrow('Timed out acquiring shared credential write lock')
    expect(readFileSync(join(lockDirectory, 'owner.json'), 'utf8')).toContain(processIdentity!)
  })

  it('takes over a lock only after its process identity is gone', async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), 'polo-dead-credential-lock-'))
    tempDirs.push(credentialsDir)
    const lockDirectory = join(credentialsDir, '.credentials.write.lock')
    mkdirSync(lockDirectory, { mode: 0o700 })
    writeFileSync(join(lockDirectory, 'owner.json'), JSON.stringify({
      version: 1,
      lockId: crypto.randomUUID(),
      pid: 2_147_483_647,
      processIdentity: 'dead-process-identity',
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
    }))

    const backend = new SecureStorageBackend({ credentialsDir })
    await backend.set(
      { type: 'llm_api_key', connectionSlug: 'recovered' },
      { value: 'safe-after-takeover' },
    )
    expect(await backend.get({ type: 'llm_api_key', connectionSlug: 'recovered' })).toMatchObject({
      value: 'safe-after-takeover',
    })
    expect(readdirSync(credentialsDir)).not.toContain('.credentials.write.lock')
  })

  it('does not let a displaced owner release a newer lock', async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), 'polo-late-lock-release-'))
    tempDirs.push(credentialsDir)
    const lockDirectory = join(credentialsDir, '.credentials.write.lock')
    const displacedDirectory = join(credentialsDir, '.credentials.write.lock.displaced')
    const first = await acquireCredentialWriteLock(lockDirectory, { heartbeatMs: 60_000 })
    renameSync(lockDirectory, displacedDirectory)
    const second = await acquireCredentialWriteLock(lockDirectory, { heartbeatMs: 60_000 })

    await first.release()
    const current = JSON.parse(readFileSync(lockDirectory, 'utf8'))
    expect(current.lockId).toBe(second.owner.lockId)

    await second.release()
    rmSync(displacedDirectory, { recursive: true, force: true })
  })

  it('preserves the previous credential file when atomic replacement fails', async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), 'polo-credential-atomic-'))
    tempDirs.push(credentialsDir)
    const identity = { type: 'llm_oauth' as const, connectionSlug: 'oauth' }
    await new SecureStorageBackend({ credentialsDir }).set(identity, {
      value: 'old-access-token',
      refreshToken: 'old-refresh-token',
    })
    const before = readFileSync(join(credentialsDir, 'credentials.enc'))
    const failing = new SecureStorageBackend({
      credentialsDir,
      beforeAtomicRename: () => { throw new Error('injected rename failure') },
    })

    await expect(failing.set(identity, {
      value: 'new-access-token',
      refreshToken: 'new-refresh-token',
    })).rejects.toThrow('injected rename failure')

    expect(readFileSync(join(credentialsDir, 'credentials.enc'))).toEqual(before)
    expect(readdirSync(credentialsDir).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(await failing.get(identity)).toMatchObject({
      value: 'old-access-token',
      refreshToken: 'old-refresh-token',
    })
    expect(await new SecureStorageBackend({ credentialsDir }).get(identity)).toMatchObject({
      value: 'old-access-token',
      refreshToken: 'old-refresh-token',
    })
  })

  it('publishes a complete claim atomically before entering the critical section', async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), 'polo-atomic-lock-claim-'))
    tempDirs.push(credentialsDir)
    const lockPath = join(credentialsDir, '.credentials.write.lock')
    let unblockPublish!: () => void
    let announceClaim!: () => void
    const claimReady = new Promise<void>(resolve => { announceClaim = resolve })
    const publishGate = new Promise<void>(resolve => { unblockPublish = resolve })
    let paused = false

    const firstPromise = acquireCredentialWriteLock(lockPath, {
      timeoutMs: 1_000,
      retryMs: 5,
      heartbeatMs: 60_000,
      beforePublish: async () => {
        if (paused) return
        paused = true
        announceClaim()
        await publishGate
      },
    })
    await claimReady

    const second = await acquireCredentialWriteLock(lockPath, {
      timeoutMs: 1_000,
      retryMs: 5,
      heartbeatMs: 60_000,
    })
    let firstAcquired = false
    void firstPromise.then(() => { firstAcquired = true })
    unblockPublish()
    await Bun.sleep(30)
    expect(firstAcquired).toBe(false)

    await second.release()
    const first = await firstPromise
    expect(first.owner.lockId).not.toBe(second.owner.lockId)
    await first.release()
  })

  it('fails closed for a legacy ownerless lock instead of reclaiming it by mtime', async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), 'polo-ownerless-lock-'))
    tempDirs.push(credentialsDir)
    const lockPath = join(credentialsDir, '.credentials.write.lock')
    mkdirSync(lockPath, { mode: 0o700 })

    await expect(acquireCredentialWriteLock(lockPath, {
      timeoutMs: 50,
      retryMs: 5,
      ownerGraceMs: 0,
    })).rejects.toThrow('Timed out acquiring shared credential write lock')
    expect(readdirSync(credentialsDir)).toContain('.credentials.write.lock')
  })

  it('supports credential mutations in a real Node runtime without global Bun', async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), 'polo-node-credential-lock-'))
    tempDirs.push(credentialsDir)
    const worker = join(import.meta.dir, 'fixtures', 'secure-storage-node-worker.ts')
    const child = Bun.spawn([
      'node',
      '--experimental-strip-types',
      worker,
      credentialsDir,
    ], { stdout: 'pipe', stderr: 'pipe' })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(JSON.parse(stdout)).toEqual({
      hasBun: false,
      afterCas: 'node-rotated',
      deleted: true,
    })
  })

  it('prevents a stale OAuth refresher from overwriting or deleting a rotated identity', async () => {
    const credentialsDir = mkdtempSync(join(tmpdir(), 'polo-credential-cas-'))
    tempDirs.push(credentialsDir)
    const identity = { type: 'llm_oauth' as const, connectionSlug: 'oauth' }
    const stale = new SecureStorageBackend({ credentialsDir })
    const winner = new SecureStorageBackend({ credentialsDir })
    await stale.set(identity, {
      value: 'old-access-token',
      refreshToken: 'old-refresh-token',
    })

    expect(await winner.compareAndSwap(
      identity,
      { value: 'old-access-token', refreshToken: 'old-refresh-token' },
      { value: 'winner-access-token', refreshToken: 'winner-refresh-token' },
    )).toMatchObject({ updated: true })

    const staleWrite = await stale.compareAndSwap(
      identity,
      { value: 'old-access-token', refreshToken: 'old-refresh-token' },
      { value: 'stale-access-token', refreshToken: 'stale-refresh-token' },
    )
    expect(staleWrite).toMatchObject({
      updated: false,
      current: { value: 'winner-access-token', refreshToken: 'winner-refresh-token' },
    })
    const staleDelete = await stale.compareAndSwap(
      identity,
      { value: 'old-access-token', refreshToken: 'old-refresh-token' },
      null,
    )
    expect(staleDelete.updated).toBe(false)
    expect(await new SecureStorageBackend({ credentialsDir }).get(identity)).toMatchObject({
      value: 'winner-access-token',
      refreshToken: 'winner-refresh-token',
    })
  })
})
