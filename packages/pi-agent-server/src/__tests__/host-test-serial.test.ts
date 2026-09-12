import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostTestSerialTestHooks, type HostTestSerialSeamEvent, type LockOwner } from './host-test-serial.ts'

// Deterministic child IPC/barrier proof for the hard-link serial lock protocol (R14 §5.4).
// Every schedule runs in real child processes. Children emit JSON-line IPC events on stdout and
// block synchronously (Atomics.wait) on parent-created marker files, so the parent observes the
// matching IPC event before releasing a paused child — no sleep-based race guessing. The parent
// aggregates enter/exit IPC to assert maxConcurrent === 1, joins every child (signalling
// stragglers first), surfaces nonzero exits and stderr, and only then removes the isolated root.

const SERIAL_HELPER = join(import.meta.dir, 'host-test-serial.ts')
const DEAD_PID = 999999999

interface ChildEvent extends Record<string, unknown> {
  type: string
  hook?: string
  token?: string | null
  link?: number
  unlink?: number
  message?: string
}
interface ChildRecord {
  role: string
  proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  events: ChildEvent[]
  stderrText: Promise<string>
  exitCode: number | null
}
let workRoot = ''
let lockRoot = ''
let childPath = ''
const records: ChildRecord[] = []
const timeline: Array<ChildEvent & { role: string }> = []

function childScript(): string {
  return [
    `const { join } = require('node:path')`,
    `const fs = require('node:fs')`,
    `const [serialHelper, lockRoot, role, work] = process.argv.slice(2)`,
    `const main = async () => {`,
    `  const m = await import(serialHelper)`,
    `  const hooks = m.hostTestSerialTestHooks`,
    `  const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n')`,
    `  const pauseOnceAt = { 'pause-candidate': ['candidate:before-publish'], 'pause-dead-read': ['reclaim:after-dead-read'], 'late-release': ['release:after-token-check'] }[role] ?? []`,
    `  const pausedOnce = new Set()`,
    `  hooks.setLockRoot(lockRoot)`,
    `  hooks.setSeamListener((event) => {`,
    `    send({ type: 'seam', hook: event.hook, token: event.token })`,
    `    if (event.hook === 'lock:enter') send({ type: 'entered', token: event.token })`,
    `    if (event.hook === 'lock:exit') send({ type: 'exited', token: event.token })`,
    `    if (pauseOnceAt.includes(event.hook) && !pausedOnce.has(event.hook)) {`,
    `      pausedOnce.add(event.hook)`,
    `      send({ type: 'proof-not-entered', hook: event.hook })`,
    `      send({ type: 'paused', hook: event.hook })`,
    `      const marker = join(work, 'resume-' + event.hook)`,
    `      const deadline = Date.now() + 60000`,
    `      while (!fs.existsSync(marker)) {`,
    `        if (Date.now() > deadline) { send({ type: 'error', message: 'barrier timeout: ' + marker }); process.exit(3) }`,
    `        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)`,
    `      }`,
    `      send({ type: 'resumed', hook: event.hook })`,
    `    }`,
    `  })`,
    `  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))`,
    `  const waitMarker = async (name) => {`,
    `    const marker = join(work, name)`,
    `    const deadline = Date.now() + 30000`,
    `    while (!fs.existsSync(marker)) {`,
    `      if (Date.now() > deadline) throw new Error('marker timeout: ' + marker)`,
    `      await sleep(5)`,
    `    }`,
    `  }`,
    `  const ownerToken = () => {`,
    `    const owner = hooks.readOwnerFrom(hooks.currentPath())`,
    `    return owner === null ? null : owner.token`,
    `  }`,
    `  try {`,
    `    if (role === 'late-release') {`,
    `      hooks.releaseWithToken('T')`,
    `      send({ type: 'late-release-return' })`,
    `    } else {`,
    `      await m.acquireHostTestSerialLock(30000)`,
    `      const token = ownerToken()`,
    `      send({ type: 'holding', token })`,
    `      await waitMarker('go-release-' + token)`,
    `      m.releaseHostTestSerialLock()`,
    `    }`,
    `    const counters = hooks.counters()`,
    `    send({ type: 'counters', link: counters.linkCalls, unlink: counters.unlinkCalls })`,
    `    process.exit(0)`,
    `  } catch (error) {`,
    `    send({ type: 'error', message: String(error && error.stack ? error.stack : error) })`,
    `    process.exit(1)`,
    `  }`,
    `}`,
    `main()`,
  ].join('\n')
}

function spawnChild(role: string): ChildRecord {
  const proc = Bun.spawn([process.execPath, childPath, SERIAL_HELPER, lockRoot, role, workRoot], { stdout: 'pipe', stderr: 'pipe' })
  const record: ChildRecord = { role, proc, events: [], stderrText: new Response(proc.stderr as ReadableStream).text().catch(() => ''), exitCode: null }
  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line.length > 0) {
            let parsed: ChildEvent
            try {
              parsed = JSON.parse(line) as ChildEvent
            } catch {
              parsed = { type: 'raw', line }
            }
            const seq = timeline.length
            timeline.push({ ...parsed, role, seq })
            record.events.push({ ...parsed, seq })
          }
          newline = buffer.indexOf('\n')
        }
      }
    } catch {
      // Reader ends when the child is terminated by afterEach cleanup.
    }
  })()
  void proc.exited.then((code) => {
    record.exitCode = code
  })
  records.push(record)
  return record
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
function eventsOf(record: ChildRecord): ChildEvent[] {
  return record.events
}
async function waitForEvent(record: ChildRecord, predicate: (event: ChildEvent) => boolean, timeoutMs = 30000): Promise<ChildEvent> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = record.events.find(predicate)
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`waitForEvent timeout: ${record.role}`)
    await sleep(10)
  }
}
async function assertNeverEnters(record: ChildRecord, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    if (record.events.some((event) => event.type === 'entered')) throw new Error(`${record.role} entered while locked out`)
    await sleep(20)
  }
}
function resume(record: ChildRecord, hook: string): void {
  writeFileSync(join(workRoot, `resume-${hook}`), '')
}
function currentToken(): string | null {
  const owner = hostTestSerialTestHooks.readOwnerFrom(hostTestSerialTestHooks.currentPath())
  return owner === null ? null : owner.token
}
function presetOwner(pid: number, token: string): void {
  const hooks = hostTestSerialTestHooks
  const candidate = hooks.prepareCandidateFile(lockRoot, pid, token)
  if (!hooks.publishCandidateFile(candidate, lockRoot)) throw new Error(`preset ${token} failed: current already exists`)
}
function maxConcurrentFromTimeline(): number {
  let live = 0
  let max = 0
  for (const event of timeline) {
    if (event.type === 'entered') {
      live += 1
      if (live > max) max = live
    } else if (event.type === 'exited') {
      live -= 1
    }
  }
  return max
}
beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'serial-lock-proof-'))
  lockRoot = join(workRoot, 'locks')
  mkdirSync(lockRoot, { recursive: true })
  hostTestSerialTestHooks.setLockRoot(lockRoot)
  childPath = join(workRoot, 'serial-child.ts')
  writeFileSync(childPath, childScript())
  records.length = 0
  timeline.length = 0
})

afterEach(async () => {
  const failures: string[] = []
  try {
    hostTestSerialTestHooks.resetOps()
    hostTestSerialTestHooks.setSeamListener(null)
    hostTestSerialTestHooks.resetCounters()
    // Join discipline (R14 §5.4): signal or terminate stragglers first, await EVERY exited
    // promise, surface nonzero exits and stderr, and only then remove the isolated root.
    for (const record of records) {
      if (record.exitCode === null) {
        try {
          record.proc.kill()
        } catch {
          // already gone
        }
      }
    }
    for (const record of records) {
      const joined = await Promise.race([record.proc.exited.then(() => true), sleep(10_000).then(() => false)])
      if (!joined) failures.push(`${record.role}: child did not exit after terminate`)
      else if (record.exitCode !== 0) failures.push(`${record.role}: nonzero exit ${String(record.exitCode)}`)
      const stderr = await record.stderrText
      if (stderr.trim().length > 0) failures.push(`${record.role}: stderr: ${stderr.slice(0, 400)}`)
    }
    if (timeline.some((event) => event.type === 'error')) failures.push(`child error event: ${JSON.stringify(timeline.find((event) => event.type === 'error'))}`)
  } finally {
    records.length = 0
    timeline.length = 0
    if (workRoot.length > 0) rmSync(workRoot, { recursive: true, force: true })
    hostTestSerialTestHooks.restoreDefaultLockRoot()
  }
  if (failures.length > 0) throw new Error(failures.join('; '))
})

describe('host test serial lock: deterministic child IPC proof (R14 §5.4)', () => {
  it('schedule a: candidate race — paused publisher loses to EEXIST, never unlinks the successor, and cannot enter before the holder exits', async () => {
    const a = spawnChild('pause-candidate')
    await waitForEvent(a, (event) => event.type === 'paused' && event.hook === 'candidate:before-publish')
    expect(currentToken()).toBeNull()
    const b = spawnChild('hold')
    const bEntered = await waitForEvent(b, (event) => event.type === 'entered')
    const tokenB = bEntered.token!
    expect(currentToken()).toBe(tokenB)
    await assertNeverEnters(a, 500)
    // Resume A: its publish must lose atomically to B's canonical, its candidate cleanup is
    // bounded to its own candidate, and its retry must keep waiting while B holds.
    resume(a, 'candidate:before-publish')
    const countASeams = (): number => eventsOf(a).filter((event) => event.type === 'seam' && event.hook === 'candidate:before-publish').length
    const deadline = Date.now() + 30_000
    while (countASeams() < 2 && Date.now() < deadline) await sleep(10)
    expect(countASeams()).toBeGreaterThanOrEqual(2) // A observed the EEXIST loss and is retrying
    await assertNeverEnters(a, 400)
    expect(currentToken()).toBe(tokenB) // A did not unlink or replace the successor
    // B exits; only then may A acquire the next generation.
    writeFileSync(join(workRoot, `go-release-${tokenB}`), '')
    const bExited = await waitForEvent(b, (event) => event.type === 'exited')
    const aEntered = await waitForEvent(a, (event) => event.type === 'entered')
    expect(Number(aEntered.seq)).toBeGreaterThan(Number(bExited.seq))
    writeFileSync(join(workRoot, `go-release-${aEntered.token}`), '')
    await waitForEvent(a, (event) => event.type === 'exited')
    expect(maxConcurrentFromTimeline()).toBe(1)
    expect(existsSync(join(lockRoot, `retired.${tokenB}`))).toBe(true)
    expect(existsSync(join(lockRoot, `retired.${String(aEntered.token)}`))).toBe(true)
    expect(currentToken()).toBeNull()
  }, 60000)

  it('schedule b: dual reclaimer — one retires dead T behind Q(T); the resumed peer gets EEXIST with zero unlink and takes the next generation', async () => {
    presetOwner(DEAD_PID, 'T')
    const b = spawnChild('pause-dead-read')
    await waitForEvent(b, (event) => event.type === 'proof-not-entered' && event.hook === 'reclaim:after-dead-read')
    const a = spawnChild('hold')
    const aEntered = await waitForEvent(a, (event) => event.type === 'entered')
    const tokenTA = aEntered.token!
    expect(currentToken()).toBe(tokenTA)
    // Parent has B's not-entered IPC proof before releasing TA.
    expect(eventsOf(b).some((event) => event.type === 'entered')).toBe(false)
    resume(b, 'reclaim:after-dead-read')
    // B's stale Q(T) link must hit EEXIST: retired:before-link fires, canonical stays TA.
    await waitForEvent(b, (event) => event.type === 'seam' && event.hook === 'retired:before-link' && event.token === 'T')
    await sleep(300)
    expect(currentToken()).toBe(tokenTA) // zero unlink by the EEXIST loser
    expect(existsSync(join(lockRoot, 'retired.T'))).toBe(true)
    // Now TA release is allowed; B acquires the next generation.
    writeFileSync(join(workRoot, `go-release-${tokenTA}`), '')
    await waitForEvent(a, (event) => event.type === 'exited')
    const bEntered = await waitForEvent(b, (event) => event.type === 'entered')
    expect(bEntered.token).not.toBe('T')
    writeFileSync(join(workRoot, `go-release-${String(bEntered.token)}`), '')
    await waitForEvent(b, (event) => event.type === 'exited')
    expect(maxConcurrentFromTimeline()).toBe(1)
    expect(currentToken()).toBeNull()
    expect(existsSync(join(lockRoot, 'retired.T'))).toBe(true)
  }, 60000)

  it('schedule c: immediate stale release after the successor — refused at token mismatch with linkCalls=0 and unlinkCalls=0', () => {
    const hooks = hostTestSerialTestHooks
    presetOwner(process.pid, 'LIVE-1')
    expect(currentToken()).toBe('LIVE-1')
    hooks.resetCounters()
    hooks.releaseWithToken('STALE-T')
    expect(hooks.counters()).toMatchObject({ linkCalls: 0, unlinkCalls: 0 })
    expect(currentToken()).toBe('LIVE-1')
    expect(existsSync(hooks.retiredBarrier('STALE-T'))).toBe(false)
  })

  it('schedule d: paused stale release — resumed after retirement and successor publish, the old release hits the Q(T) EEXIST barrier with unlinkCalls=0', async () => {
    const hooks = hostTestSerialTestHooks
    presetOwner(DEAD_PID, 'T')
    const child = spawnChild('late-release')
    await waitForEvent(child, (event) => event.type === 'paused' && event.hook === 'release:after-token-check')
    // The old release passed the token check; the parent now retires T and publishes the successor.
    const deadOwner: LockOwner = { schema: 1, pid: DEAD_PID, token: 'T' }
    hooks.reclaimStale(deadOwner)
    expect(existsSync(hooks.currentPath())).toBe(false)
    expect(existsSync(hooks.retiredBarrier('T'))).toBe(true)
    presetOwner(process.pid, 'LIVE-2')
    expect(currentToken()).toBe('LIVE-2')
    hooks.resetCounters()
    resume(child, 'release:after-token-check')
    await waitForEvent(child, (event) => event.type === 'late-release-return')
    const counters = await waitForEvent(child, (event) => event.type === 'counters')
    expect(counters.link).toBe(1) // exactly the refused Q(T) attempt
    expect(counters.unlink).toBe(0)
    expect(currentToken()).toBe('LIVE-2') // successor survives
    expect(existsSync(hooks.retiredBarrier('T'))).toBe(true)
  }, 60000)

  it('same-process enter/exit seams bracket a real acquire/release cycle', async () => {
    const hooks = hostTestSerialTestHooks
    const seams: HostTestSerialSeamEvent[] = []
    hooks.setSeamListener((event) => seams.push(event))
    const { acquireHostTestSerialLock, releaseHostTestSerialLock } = await import('./host-test-serial.ts')
    await acquireHostTestSerialLock(10_000)
    releaseHostTestSerialLock()
    expect(seams.map((event) => event.hook)).toEqual(['candidate:before-publish', 'lock:enter', 'release:after-token-check', 'retired:before-link', 'lock:exit'])
    expect(seams[0].token).toBe(seams[1].token)
    expect(currentToken()).toBeNull()
  })
})

describe('host test serial lock: owner-read discrimination and fail-closed I/O matrix', () => {
  it('classifies absent, malformed, valid, and io_error owner reads', () => {
    const hooks = hostTestSerialTestHooks
    expect(hooks.readOwnerRecord(join(lockRoot, 'absent'))).toMatchObject({ kind: 'absent' })
    writeFileSync(join(lockRoot, 'garbage'), 'not-json{')
    expect(hooks.readOwnerRecord(join(lockRoot, 'garbage'))).toMatchObject({ kind: 'malformed' })
    writeFileSync(join(lockRoot, 'bad-schema'), JSON.stringify({ schema: 2, pid: 1, token: 't' }))
    expect(hooks.readOwnerRecord(join(lockRoot, 'bad-schema'))).toMatchObject({ kind: 'malformed' })
    writeFileSync(join(lockRoot, 'bad-pid'), JSON.stringify({ schema: 1, pid: 1.5, token: 't' }))
    expect(hooks.readOwnerRecord(join(lockRoot, 'bad-pid'))).toMatchObject({ kind: 'malformed' })
    const candidate = hooks.prepareCandidateFile(lockRoot, process.pid, 'VALID-1')
    expect(hooks.publishCandidateFile(candidate, lockRoot)).toBe(true)
    expect(hooks.readOwnerRecord(hooks.currentPath())).toMatchObject({ kind: 'valid', owner: { pid: process.pid, token: 'VALID-1' } })
    hooks.resetCounters()
    hooks.ops.read = () => {
      const error = new Error('denied') as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    }
    expect(hooks.readOwnerRecord(hooks.currentPath())).toMatchObject({ kind: 'io_error' })
  })

  it('surfaces EACCES on current as an explicit fail-closed I/O error, not a timeout', async () => {
    const hooks = hostTestSerialTestHooks
    const { acquireHostTestSerialLock } = await import('./host-test-serial.ts')
    presetOwner(process.pid, 'LIVE-1')
    hooks.ops.read = (path: string) => {
      if (path === hooks.currentPath()) {
        const error = new Error('denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return require('node:fs').readFileSync(path, 'utf8')
    }
    const started = Date.now()
    let message = ''
    try {
      await acquireHostTestSerialLock(30_000)
    } catch (error) {
      message = String((error as Error).message)
    }
    expect(message).toContain('fail-closed I/O')
    expect(Date.now() - started).toBeLessThan(20_000)
    hooks.resetOps()
    expect(currentToken()).toBe('LIVE-1')
  })

  it('treats malformed current as an unknown state: bounded timeout, never reclaimed, never deleted', async () => {
    const hooks = hostTestSerialTestHooks
    const { acquireHostTestSerialLock } = await import('./host-test-serial.ts')
    writeFileSync(hooks.currentPath(), 'garbage{')
    await expect(acquireHostTestSerialLock(250)).rejects.toThrow('timed out')
    expect(currentToken()).toBeNull() // still unparsable — not reclaimed, not deleted
    expect(existsSync(hooks.currentPath())).toBe(true)
    expect(existsSync(hooks.retiredBarrier('garbage'))).toBe(false)
  })

  it('treats EPERM liveness as alive/unknown: bounded timeout with no reclaim', async () => {
    const hooks = hostTestSerialTestHooks
    const { acquireHostTestSerialLock } = await import('./host-test-serial.ts')
    presetOwner(process.pid, 'LIVE-EPERM')
    hooks.ops.kill = (pid: number) => {
      const error = new Error('permission') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    }
    await expect(acquireHostTestSerialLock(250)).rejects.toThrow('timed out')
    expect(currentToken()).toBe('LIVE-EPERM')
    expect(existsSync(hooks.retiredBarrier('LIVE-EPERM'))).toBe(false)
  })

  it('release validation inode mismatch refuses with canonical and Q(token) retained and zero unlink', () => {
    const hooks = hostTestSerialTestHooks
    presetOwner(process.pid, 'LIVE-MISMATCH')
    hooks.resetCounters()
    hooks.ops.stat = (path: string) => {
      const real = require('node:fs').statSync(path)
      if (path === hooks.retiredBarrier('LIVE-MISMATCH')) return { dev: real.dev + 1, ino: real.ino }
      return { dev: real.dev, ino: real.ino }
    }
    hooks.releaseWithToken('LIVE-MISMATCH')
    expect(currentToken()).toBe('LIVE-MISMATCH')
    expect(existsSync(hooks.retiredBarrier('LIVE-MISMATCH'))).toBe(true)
    expect(hooks.counters()).toMatchObject({ unlinkCalls: 0 })
  })

  it('release validation I/O failure throws explicitly with canonical and Q(token) retained', () => {
    const hooks = hostTestSerialTestHooks
    presetOwner(process.pid, 'LIVE-IO')
    hooks.resetCounters()
    hooks.ops.stat = (path: string) => {
      if (path === hooks.retiredBarrier('LIVE-IO')) {
        const error = new Error('io') as NodeJS.ErrnoException
        error.code = 'EIO'
        throw error
      }
      const real = require('node:fs').statSync(path)
      return { dev: real.dev, ino: real.ino }
    }
    expect(() => hooks.releaseWithToken('LIVE-IO')).toThrow('release validation I/O failed')
    expect(currentToken()).toBe('LIVE-IO')
    expect(existsSync(hooks.retiredBarrier('LIVE-IO'))).toBe(true)
    expect(hooks.counters()).toMatchObject({ unlinkCalls: 0 })
  })

  it('reclaim validation inode mismatch fails explicitly with canonical and Q(T) retained', () => {
    const hooks = hostTestSerialTestHooks
    presetOwner(DEAD_PID, 'T-RACE')
    hooks.resetCounters()
    hooks.ops.stat = (path: string) => {
      const real = require('node:fs').statSync(path)
      if (path === hooks.retiredBarrier('T-RACE')) return { dev: real.dev, ino: real.ino + 1 }
      return { dev: real.dev, ino: real.ino }
    }
    expect(() => hooks.reclaimStale({ schema: 1, pid: DEAD_PID, token: 'T-RACE' })).toThrow('inode mismatch')
    expect(currentToken()).toBe('T-RACE')
    expect(existsSync(hooks.retiredBarrier('T-RACE'))).toBe(true)
    expect(hooks.counters()).toMatchObject({ unlinkCalls: 0 })
  })

  it('reclaim validation read I/O failure fails explicitly with canonical and Q(T) retained', () => {
    const hooks = hostTestSerialTestHooks
    presetOwner(DEAD_PID, 'T-IO')
    hooks.resetCounters()
    hooks.ops.read = (path: string) => {
      if (path === hooks.retiredBarrier('T-IO')) {
        const error = new Error('io') as NodeJS.ErrnoException
        error.code = 'EIO'
        throw error
      }
      return require('node:fs').readFileSync(path, 'utf8')
    }
    expect(() => hooks.reclaimStale({ schema: 1, pid: DEAD_PID, token: 'T-IO' })).toThrow('reclaim validation I/O failed')
    expect(currentToken()).toBe('T-IO')
    expect(existsSync(hooks.retiredBarrier('T-IO'))).toBe(true)
    expect(hooks.counters()).toMatchObject({ unlinkCalls: 0 })
  })

  it('candidate readback failure fails closed, cleans its own candidate, and surfaces explicitly', async () => {
    const hooks = hostTestSerialTestHooks
    const { acquireHostTestSerialLock } = await import('./host-test-serial.ts')
    hooks.ops.read = (path: string) => {
      if (path.includes('candidate.')) {
        const error = new Error('denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return require('node:fs').readFileSync(path, 'utf8')
    }
    await expect(acquireHostTestSerialLock(10_000)).rejects.toThrow('candidate read failed')
    expect(readdirSync(lockRoot).filter((name) => name.startsWith('candidate.'))).toEqual([])
  })

  it('candidate cleanup unlink failure propagates instead of being swallowed and retains the candidate', async () => {
    const hooks = hostTestSerialTestHooks
    const { acquireHostTestSerialLock } = await import('./host-test-serial.ts')
    presetOwner(process.pid, 'LIVE-HOLD')
    hooks.ops.unlink = (path: string) => {
      if (path.includes('candidate.')) {
        const error = new Error('denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      require('node:fs').unlinkSync(path)
    }
    await expect(acquireHostTestSerialLock(5_000)).rejects.toThrow()
    expect(readdirSync(lockRoot).filter((name) => name.startsWith('candidate.')).length).toBe(1)
    expect(currentToken()).toBe('LIVE-HOLD')
  })

  it('unsupported hard-link errors (EXDEV) surface explicitly instead of downgrading', async () => {
    const hooks = hostTestSerialTestHooks
    const { acquireHostTestSerialLock } = await import('./host-test-serial.ts')
    hooks.ops.link = () => {
      const error = new Error('cross-device') as NodeJS.ErrnoException
      error.code = 'EXDEV'
      throw error
    }
    let code = ''
    try {
      await acquireHostTestSerialLock(5_000)
    } catch (error) {
      code = String((error as NodeJS.ErrnoException).code)
    }
    expect(code).toBe('EXDEV')
    expect(currentToken()).toBeNull()
  })

  it('a live holder forces the bounded timeout without any reclaim', async () => {
    const hooks = hostTestSerialTestHooks
    const { acquireHostTestSerialLock } = await import('./host-test-serial.ts')
    presetOwner(process.pid, 'LIVE-TIMEOUT')
    await expect(acquireHostTestSerialLock(250)).rejects.toThrow('timed out')
    expect(currentToken()).toBe('LIVE-TIMEOUT')
    expect(existsSync(hooks.retiredBarrier('LIVE-TIMEOUT'))).toBe(false)
  })
})
