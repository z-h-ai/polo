import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

const roots: string[] = []
const children = new Set<ChildProcess>()
const workerPath = join(import.meta.dir, 'fixtures', 'file-lock-worker.ts')

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'polo-file-lock-race-'))
  roots.push(root)
  return root
}

function eventPath(root: string, label: string, event: string): string {
  return join(root, `${label}.${event}`)
}

function startWorker(
  root: string,
  lockDir: string,
  label: string,
  options: {
    pauseBeforePublish?: boolean
    pauseBeforeRecoveryPublish?: boolean
    pauseRecovery?: boolean
    pauseAfterQuarantine?: boolean
    criticalGuard?: string
  } = {},
): ChildProcess {
  const child = spawn(process.execPath, ['run', workerPath], {
    env: {
      ...process.env,
      POLO_LOCK_DIR: lockDir,
      POLO_LOCK_LABEL: label,
      POLO_LOCK_ENTERED: eventPath(root, label, 'entered'),
      POLO_LOCK_EXITED: eventPath(root, label, 'exited'),
      POLO_LOCK_RELEASE: eventPath(root, label, 'release'),
      ...(options.pauseBeforePublish
        ? {
            POLO_LOCK_BEFORE_PUBLISH: eventPath(root, label, 'before-publish'),
            POLO_LOCK_RELEASE_PUBLISH: eventPath(root, label, 'release-publish'),
          }
        : {}),
      ...(options.pauseRecovery
        ? {
            POLO_LOCK_RECOVERY: eventPath(root, label, 'recovery'),
            POLO_LOCK_RELEASE_RECOVERY: eventPath(root, label, 'release-recovery'),
          }
        : {}),
      ...(options.pauseBeforeRecoveryPublish
        ? {
            POLO_LOCK_BEFORE_RECOVERY_PUBLISH: eventPath(root, label, 'before-recovery-publish'),
            POLO_LOCK_RELEASE_RECOVERY_PUBLISH: eventPath(root, label, 'release-recovery-publish'),
          }
        : {}),
      ...(options.pauseAfterQuarantine
        ? {
            POLO_LOCK_QUARANTINED: eventPath(root, label, 'quarantined'),
            POLO_LOCK_RELEASE_QUARANTINE: eventPath(root, label, 'release-quarantine'),
          }
        : {}),
      ...(options.criticalGuard
        ? { POLO_LOCK_CRITICAL_GUARD: options.criticalGuard }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

async function waitForPath(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`)
    await Bun.sleep(5)
  }
}

async function waitForEither(
  first: string,
  second: string,
  timeoutMs = 5_000,
): Promise<'first' | 'second'> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (existsSync(first)) return 'first'
    if (existsSync(second)) return 'second'
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${first} or ${second}`)
    }
    await Bun.sleep(5)
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode
  return await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for lock worker')), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
}

function release(root: string, label: string, event = 'release'): void {
  writeFileSync(eventPath(root, label, event), '')
}

function lockArtifacts(root: string, lockDir: string): string[] {
  const lockName = basename(lockDir)
  return readdirSync(root).filter(name =>
    name === lockName
    || name.includes(`${lockName}.recovery.`)
    || name.includes(`${lockName}.stale.`)
    || name.includes(`${lockName}.pending.`),
  )
}

async function assertTwoContendersSerialize(
  root: string,
  lockDir: string,
  criticalGuard: string,
  prefix: string,
): Promise<void> {
  const firstLabel = `${prefix}-one`
  const secondLabel = `${prefix}-two`
  const first = startWorker(root, lockDir, firstLabel, { criticalGuard })
  const second = startWorker(root, lockDir, secondLabel, { criticalGuard })
  const enteredFirst = eventPath(root, firstLabel, 'entered')
  const enteredSecond = eventPath(root, secondLabel, 'entered')
  const winner = await waitForEither(enteredFirst, enteredSecond)
  const winnerLabel = winner === 'first' ? firstLabel : secondLabel
  const waitingLabel = winner === 'first' ? secondLabel : firstLabel
  expect(existsSync(eventPath(root, waitingLabel, 'entered'))).toBe(false)

  release(root, winnerLabel)
  await waitForPath(eventPath(root, winnerLabel, 'exited'))
  await waitForPath(eventPath(root, waitingLabel, 'entered'))
  release(root, waitingLabel)
  await waitForPath(eventPath(root, waitingLabel, 'exited'))
  expect(await waitForExit(first)).toBe(0)
  expect(await waitForExit(second)).toBe(0)
  expect(existsSync(criticalGuard)).toBe(false)
}

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL')
  await Promise.all([...children].map(child => waitForExit(child).catch(() => null)))
  children.clear()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('cross-process file lock races', () => {
  it('never publishes an ownerless canonical lock while publication is paused', async () => {
    const root = makeRoot()
    const lockDir = join(root, '.config.transaction.lock')
    const paused = startWorker(root, lockDir, 'paused', { pauseBeforePublish: true })

    await waitForPath(eventPath(root, 'paused', 'before-publish'))
    await Bun.sleep(2_100)
    expect(existsSync(lockDir)).toBe(false)

    const preparedName = readdirSync(root).find(name =>
      name.includes('.config.transaction.lock.pending.'),
    )
    expect(preparedName).toBeTruthy()
    const preparedOwner = JSON.parse(
      readFileSync(join(root, preparedName!, 'owner.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(preparedOwner).toEqual(expect.objectContaining({
      schemaVersion: 1,
      pid: paused.pid,
      nonce: expect.any(String),
      processStartFingerprint: expect.any(String),
    }))

    const contender = startWorker(root, lockDir, 'contender')
    await waitForPath(eventPath(root, 'contender', 'entered'))
    release(root, 'paused', 'release-publish')
    await Bun.sleep(100)
    expect(existsSync(eventPath(root, 'paused', 'entered'))).toBe(false)

    release(root, 'contender')
    await waitForPath(eventPath(root, 'contender', 'exited'))
    expect(await waitForExit(contender)).toBe(0)
    await waitForPath(eventPath(root, 'paused', 'entered'))
    release(root, 'paused')
    expect(await waitForExit(paused)).toBe(0)
    expect(lockArtifacts(root, lockDir)).toEqual([])
  })

  it('serializes a stale-lock recovery and a new contender after owner death', async () => {
    const root = makeRoot()
    const lockDir = join(root, '.credentials.transaction.lock')
    const criticalGuard = join(root, 'critical.guard')
    const owner = startWorker(root, lockDir, 'owner')
    await waitForPath(eventPath(root, 'owner', 'entered'))

    const recoverer = startWorker(root, lockDir, 'recoverer', {
      pauseRecovery: true,
      criticalGuard,
    })
    await Bun.sleep(100)
    expect(existsSync(eventPath(root, 'recoverer', 'recovery'))).toBe(false)

    owner.kill('SIGKILL')
    await waitForExit(owner)
    await waitForPath(eventPath(root, 'recoverer', 'recovery'))

    const contender = startWorker(root, lockDir, 'new-contender', { criticalGuard })
    await Bun.sleep(100)
    expect(existsSync(eventPath(root, 'recoverer', 'entered'))).toBe(false)
    expect(existsSync(eventPath(root, 'new-contender', 'entered'))).toBe(false)

    release(root, 'recoverer', 'release-recovery')
    const first = await waitForEither(
      eventPath(root, 'recoverer', 'entered'),
      eventPath(root, 'new-contender', 'entered'),
    )
    const firstLabel = first === 'first' ? 'recoverer' : 'new-contender'
    const secondLabel = first === 'first' ? 'new-contender' : 'recoverer'
    expect(existsSync(eventPath(root, secondLabel, 'entered'))).toBe(false)

    release(root, firstLabel)
    await waitForPath(eventPath(root, firstLabel, 'exited'))
    await waitForPath(eventPath(root, secondLabel, 'entered'))
    release(root, secondLabel)
    await waitForPath(eventPath(root, secondLabel, 'exited'))

    expect(await waitForExit(recoverer)).toBe(0)
    expect(await waitForExit(contender)).toBe(0)
    expect(existsSync(criticalGuard)).toBe(false)
    expect(lockArtifacts(root, lockDir)).toEqual([])
  })

  it('cleans an abandoned prepared owner after a pre-publication crash', async () => {
    const root = makeRoot()
    const lockDir = join(root, '.config.transaction.lock')
    const crashed = startWorker(root, lockDir, 'crashed', { pauseBeforePublish: true })
    await waitForPath(eventPath(root, 'crashed', 'before-publish'))
    crashed.kill('SIGKILL')
    await waitForExit(crashed)

    const recovery = startWorker(root, lockDir, 'cleanup')
    await waitForPath(eventPath(root, 'cleanup', 'entered'))
    release(root, 'cleanup')
    expect(await waitForExit(recovery)).toBe(0)
    expect(lockArtifacts(root, lockDir)).toEqual([])
  })

  it('cleans a recovery claim prepared directory after the recoverer is killed before publish', async () => {
    const root = makeRoot()
    const lockDir = join(root, '.config.transaction.lock')
    const criticalGuard = join(root, 'critical.guard')
    const owner = startWorker(root, lockDir, 'owner-before-claim')
    await waitForPath(eventPath(root, 'owner-before-claim', 'entered'))

    const recoverer = startWorker(root, lockDir, 'recoverer-before-claim', {
      pauseBeforeRecoveryPublish: true,
    })
    owner.kill('SIGKILL')
    await waitForExit(owner)
    await waitForPath(eventPath(root, 'recoverer-before-claim', 'before-recovery-publish'))
    expect(readdirSync(root).some(name =>
      name.startsWith('..config.transaction.lock.recovery.')
      && name.includes('.pending.'),
    )).toBe(true)

    recoverer.kill('SIGKILL')
    await waitForExit(recoverer)
    await assertTwoContendersSerialize(root, lockDir, criticalGuard, 'post-prepared-crash')
    expect(lockArtifacts(root, lockDir)).toEqual([])
  })

  it('cleans a stale quarantine after the recoverer is killed after the canonical move', async () => {
    const root = makeRoot()
    const lockDir = join(root, '.credentials.transaction.lock')
    const criticalGuard = join(root, 'critical.guard')
    const owner = startWorker(root, lockDir, 'owner-before-quarantine')
    await waitForPath(eventPath(root, 'owner-before-quarantine', 'entered'))

    const recoverer = startWorker(root, lockDir, 'recoverer-after-quarantine', {
      pauseAfterQuarantine: true,
    })
    owner.kill('SIGKILL')
    await waitForExit(owner)
    await waitForPath(eventPath(root, 'recoverer-after-quarantine', 'quarantined'))
    expect(existsSync(lockDir)).toBe(false)
    expect(readdirSync(root).some(name =>
      name.startsWith('.credentials.transaction.lock.stale.'),
    )).toBe(true)

    recoverer.kill('SIGKILL')
    await waitForExit(recoverer)
    await assertTwoContendersSerialize(root, lockDir, criticalGuard, 'post-quarantine-crash')
    expect(lockArtifacts(root, lockDir)).toEqual([])
  })
})
