import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostTestSerialTestHooks, type HostTestSerialSeamEvent, type LockOwner } from './host-test-serial.ts'

// Deterministic child IPC/barrier proof for the hard-link serial lock protocol (R14 §5.4, Fix R9
// issues 3/4/5). Every schedule — including the stale-release schedule — runs in real child
// processes. Children emit JSON-line IPC events on stdout and block synchronously (Atomics.wait)
// on parent-created marker files. Every hard-link attempt is acknowledged by a post-operation
// `link-outcome` IPC event carrying the exact atomic outcome and link/unlink counters, so the
// delivery of the confirmation is the barrier — no sleep-based negative inference anywhere. The
// parent aggregates enter/exit IPC to assert maxConcurrent === 1 and exact-unary retirement,
// joins every child before any cleanup, and retains the isolated root untouched if a child
// cannot be joined.

const SERIAL_HELPER = join(import.meta.dir, 'host-test-serial.ts')
const DEAD_PID = 999999999
// Fixed grammar-valid tokens for schedules that reference a specific tombstone by name.
const TOKEN_T = '00000000-0000-4000-8000-000000000001'
const TOKEN_STALE = '00000000-0000-4000-8000-000000000003'

interface ChildEvent extends Record<string, unknown> {
  type: string
  hook?: string
  token?: string | null
  outcome?: 'linked' | 'eexist'
  link?: number
  unlink?: number
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
    `const [serialHelper, lockRoot, role, work, releaseToken] = process.argv.slice(2)`,
    `const main = async () => {`,
    `  const m = await import(serialHelper)`,
    `  const hooks = m.hostTestSerialTestHooks`,
    `  const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n')`,
    `  const pauseOnceAt = { 'pause-candidate': ['candidate:before-publish'], 'pause-dead-read': ['reclaim:after-dead-read'], 'late-release': ['release:after-token-check'] }[role] ?? []`,
    `  const pausedOnce = new Set()`,
    `  hooks.setLockRoot(lockRoot)`,
    `  hooks.setSeamListener((event) => {`,
    `    send({ type: 'seam', hook: event.hook, token: event.token, outcome: event.outcome })`,
    `    if (event.hook === 'lock:enter') send({ type: 'entered', token: event.token })`,
    `    if (event.hook === 'lock:exit') send({ type: 'exited', token: event.token })`,
    `    if (event.outcome !== undefined) {`,
    `      const counters = hooks.counters()`,
    `      send({ type: 'link-outcome', hook: event.hook, token: event.token, outcome: event.outcome, link: counters.linkCalls, unlink: counters.unlinkCalls })`,
    `    }`,
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
    `    if (role === 'late-release' || role === 'stale-release') {`,
    `      hooks.releaseWithToken(releaseToken)`,
    `      send({ type: 'release-return', canonicalToken: ownerToken() })`,
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

function spawnChild(role: string, releaseToken?: string): ChildRecord {
  const argv = [process.execPath, childPath, SERIAL_HELPER, lockRoot, role, workRoot]
  if (releaseToken !== undefined) argv.push(releaseToken)
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
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
function linkOutcomes(token: string, outcome: 'linked' | 'eexist'): Array<ChildEvent & { role: string }> {
  return timeline.filter((event) => event.type === 'link-outcome' && event.token === token && event.outcome === outcome)
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
  try {
    hostTestSerialTestHooks.resetOps()
    hostTestSerialTestHooks.setSeamListener(null)
    hostTestSerialTestHooks.resetCounters()
    const failures: string[] = []
    // Join discipline (R14 §5.4, R9 issue 5): signal or terminate stragglers first, then verify
    // EVERY child exit before any cleanup decision.
    for (const record of records) {
      if (record.exitCode === null) {
        try {
          record.proc.kill()
        } catch {
          // already gone
        }
      }
    }
    let allJoined = true
    for (const record of records) {
      const joined = await Promise.race([record.proc.exited.then(() => true), sleep(10_000).then(() => false)])
      if (!joined) {
        allJoined = false
        failures.push(`${record.role}: child did not exit after terminate`)
      } else if (record.exitCode !== 0) {
        failures.push(`${record.role}: nonzero exit ${String(record.exitCode)}`)
      }
    }
    if (!allJoined) {
      // Retain the isolated root untouched as evidence: a still-live child must never observe a
      // deleted LOCK_ROOT. Global hook state is still restored below.
      throw new Error(failures.join('; '))
    }
    for (const record of records) {
      const stderr = await record.stderrText
      if (stderr.trim().length > 0) failures.push(`${record.role}: stderr: ${stderr.slice(0, 400)}`)
    }
    if (timeline.some((event) => event.type === 'error')) failures.push(`child error event: ${JSON.stringify(timeline.find((event) => event.type === 'error'))}`)
    records.length = 0
    timeline.length = 0
    if (workRoot.length > 0) rmSync(workRoot, { recursive: true, force: true })
    hostTestSerialTestHooks.restoreDefaultLockRoot()
    if (failures.length > 0) throw new Error(failures.join('; '))
  } catch (error) {
    records.length = 0
    timeline.length = 0
    hostTestSerialTestHooks.restoreDefaultLockRoot()
    throw error
  }
})

describe('host test serial lock: deterministic child IPC proof (R14 §5.4)', () => {
  it('schedule a: candidate race — post-EEXIST ack proves the paused publisher lost with zero unlink and event-ordered exclusion', async () => {
    const a = spawnChild('pause-candidate')
    await waitForEvent(a, (event) => event.type === 'proof-not-entered' && event.hook === 'candidate:before-publish')
    expect(eventsOf(a).some((event) => event.type === 'entered')).toBe(false)
    expect(currentToken()).toBeNull()
    const b = spawnChild('hold')
    const bEntered = await waitForEvent(b, (event) => event.type === 'entered')
    const tokenB = String(bEntered.token)
    expect(currentToken()).toBe(tokenB)
    // Resume A; its losing link attempt is acknowledged AFTER it returned, carrying exact counters.
    resume(a, 'candidate:before-publish')
    const aAck = await waitForEvent(a, (event) => event.type === 'link-outcome' && event.hook === 'candidate:after-link' && event.outcome === 'eexist')
    expect(aAck.link).toBe(1) // exactly the losing candidate publish attempt
    expect(aAck.unlink).toBe(0) // nothing unlinked at the loss moment — zero successor unlink
    expect(currentToken()).toBe(tokenB)
    expect(eventsOf(a).some((event) => event.type === 'entered')).toBe(false) // event-ordered exclusion
    // B exits; only then may A acquire the next generation (event-ordered, no timing window).
    writeFileSync(join(workRoot, `go-release-${tokenB}`), '')
    const bExited = await waitForEvent(b, (event) => event.type === 'exited')
    const aEntered = await waitForEvent(a, (event) => event.type === 'entered')
    expect(Number(aEntered.seq)).toBeGreaterThan(Number(bExited.seq))
    writeFileSync(join(workRoot, `go-release-${String(aEntered.token)}`), '')
    await waitForEvent(a, (event) => event.type === 'exited')
    expect(maxConcurrentFromTimeline()).toBe(1)
    expect(existsSync(join(lockRoot, `retired.${tokenB}`))).toBe(true)
    expect(existsSync(join(lockRoot, `retired.${String(aEntered.token)}`))).toBe(true)
    expect(currentToken()).toBeNull()
  }, 60000)

  it('schedule b: dual reclaimer — deterministic post-EEXIST ack, exact-unary retirement, zero successor unlink, next-generation acquisition', async () => {
    presetOwner(DEAD_PID, TOKEN_T)
    const b = spawnChild('pause-dead-read')
    await waitForEvent(b, (event) => event.type === 'proof-not-entered' && event.hook === 'reclaim:after-dead-read')
    const a = spawnChild('hold')
    const aEntered = await waitForEvent(a, (event) => event.type === 'entered')
    const tokenTA = String(aEntered.token)
    expect(currentToken()).toBe(tokenTA)
    // Parent has B's not-entered IPC proof before TA release.
    expect(eventsOf(b).some((event) => event.type === 'entered')).toBe(false)
    resume(b, 'reclaim:after-dead-read')
    // B's stale Q(T) link attempt is acknowledged AFTER it returned EEXIST — delivery is the barrier.
    const bAck = await waitForEvent(b, (event) => event.type === 'link-outcome' && event.hook === 'retired:after-link' && event.token === TOKEN_T && event.outcome === 'eexist')
    expect(bAck.link).toBe(2) // losing publish vs dead T + losing Q(T) barrier link
    expect(bAck.unlink).toBe(1) // only B's own candidate cleanup — never a successor
    expect(currentToken()).toBe(tokenTA) // TA survives the EEXIST loser
    expect(existsSync(join(lockRoot, `retired.${TOKEN_T}`))).toBe(true)
    // Exact-unary retirement: exactly one linked and one EEXIST-loser acknowledgement for T.
    expect(linkOutcomes(TOKEN_T, 'linked').length).toBe(1)
    expect(linkOutcomes(TOKEN_T, 'eexist').length).toBe(1)
    // Now TA release is allowed; B acquires the next generation.
    writeFileSync(join(workRoot, `go-release-${tokenTA}`), '')
    await waitForEvent(a, (event) => event.type === 'exited')
    const bEntered = await waitForEvent(b, (event) => event.type === 'entered')
    expect(bEntered.token).not.toBe(TOKEN_T)
    writeFileSync(join(workRoot, `go-release-${String(bEntered.token)}`), '')
    await waitForEvent(b, (event) => event.type === 'exited')
    expect(maxConcurrentFromTimeline()).toBe(1)
    expect(currentToken()).toBeNull()
    expect(existsSync(join(lockRoot, `retired.${TOKEN_T}`))).toBe(true)
  }, 60000)

  it('schedule c: immediate stale release runs in a real child — refused at token mismatch with linkCalls=0 and unlinkCalls=0', async () => {
    const hooks = hostTestSerialTestHooks
    const tokenLive = randomUUID()
    presetOwner(process.pid, tokenLive)
    expect(currentToken()).toBe(tokenLive)
    const child = spawnChild('stale-release', TOKEN_STALE)
    const releaseReturn = await waitForEvent(child, (event) => event.type === 'release-return')
    expect(releaseReturn.canonicalToken).toBe(tokenLive) // the child observed the mismatched canonical
    const counters = await waitForEvent(child, (event) => event.type === 'counters')
    expect(counters.link).toBe(0)
    expect(counters.unlink).toBe(0)
    expect(currentToken()).toBe(tokenLive) // successor survives the stale release
  }, 60000)

  it('schedule d: paused stale release — resumed after retirement and successor publish, the old release hits the Q(T) EEXIST barrier with unlinkCalls=0', async () => {
    const hooks = hostTestSerialTestHooks
    presetOwner(DEAD_PID, TOKEN_T)
    const child = spawnChild('late-release', TOKEN_T)
    await waitForEvent(child, (event) => event.type === 'paused' && event.hook === 'release:after-token-check')
    // The old release passed the token check; the parent now retires T and publishes the successor.
    const deadOwner: LockOwner = { schema: 1, pid: DEAD_PID, token: TOKEN_T }
    hooks.reclaimStale(deadOwner)
    expect(existsSync(hooks.currentPath())).toBe(false)
    expect(existsSync(hooks.retiredBarrier(TOKEN_T))).toBe(true)
    const tokenTA = randomUUID()
    presetOwner(process.pid, tokenTA)
    expect(currentToken()).toBe(tokenTA)
    resume(child, 'release:after-token-check')
    // Deterministic post-EEXIST acknowledgement before the counters.
    const ack = await waitForEvent(child, (event) => event.type === 'link-outcome' && event.hook === 'retired:after-link' && event.token === TOKEN_T && event.outcome === 'eexist')
    expect(ack.link).toBe(1) // exactly the refused Q(T) attempt
    expect(ack.unlink).toBe(0)
    const counters = await waitForEvent(child, (event) => event.type === 'counters')
    expect(counters.link).toBe(1)
    expect(counters.unlink).toBe(0)
    expect(currentToken()).toBe(tokenTA) // successor survives
    expect(existsSync(hooks.retiredBarrier(TOKEN_T))).toBe(true)
  }, 60000)

  it('same-process enter/exit seams bracket a real acquire/release cycle in production seam order', async () => {
    const hooks = hostTestSerialTestHooks
    const seams: HostTestSerialSeamEvent[] = []
    hooks.setSeamListener((event) => seams.push(event))
    const { acquireHostTestSerialLock, releaseHostTestSerialLock } = await import('./host-test-serial.ts')
    await acquireHostTestSerialLock(10_000)
    releaseHostTestSerialLock()
    expect(seams.map((event) => event.hook)).toEqual([
      'candidate:before-publish',
      'candidate:after-link',
      'lock:enter',
      'release:after-token-check',
      'retired:before-link',
      'retired:after-link',
      'lock:exit',
    ])
    expect(seams[2].token).toBe(seams[6].token)
    expect(currentToken()).toBeNull()
  })
})

describe('host test serial lock: owner-read discrimination and fail-closed I/O matrix', () => {
  it('classifies absent, malformed, path-escaping, and valid owner reads and contains derived paths', () => {
    const hooks = hostTestSerialTestHooks
    expect(hooks.readOwnerRecord(join(lockRoot, 'absent'))).toMatchObject({ kind: 'absent' })
    writeFileSync(join(lockRoot, 'garbage'), 'not-json{')
    expect(hooks.readOwnerRecord(join(lockRoot, 'garbage'))).toMatchObject({ kind: 'malformed' })
    writeFileSync(join(lockRoot, 'bad-schema'), JSON.stringify({ schema: 2, pid: 1, token: randomUUID() }))
    expect(hooks.readOwnerRecord(join(lockRoot, 'bad-schema'))).toMatchObject({ kind: 'malformed' })
    writeFileSync(join(lockRoot, 'bad-pid'), JSON.stringify({ schema: 1, pid: 1.5, token: randomUUID() }))
    expect(hooks.readOwnerRecord(join(lockRoot, 'bad-pid'))).toMatchObject({ kind: 'malformed' })
    // A schema-valid owner record whose token could escape LOCK_ROOT is malformed (R9 issue 6).
    writeFileSync(join(lockRoot, 'escape'), JSON.stringify({ schema: 1, pid: DEAD_PID, token: 'x/../../escaped' }))
    expect(hooks.readOwnerRecord(join(lockRoot, 'escape'))).toMatchObject({ kind: 'malformed' })
    expect(() => hooks.retiredBarrier('x/../../escaped')).toThrow('escapes LOCK_ROOT')
    expect(existsSync(join(workRoot, 'escaped'))).toBe(false)
    const candidate = hooks.prepareCandidateFile(lockRoot, process.pid, randomUUID())
    const validToken = JSON.parse(require('node:fs').readFileSync(candidate, 'utf8') as string).token as string
    expect(hooks.publishCandidateFile(candidate, lockRoot)).toBe(true)
    expect(hooks.readOwnerRecord(hooks.currentPath())).toMatchObject({ kind: 'valid', owner: { pid: process.pid, token: validToken } })
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
    const tokenLive = randomUUID()
    presetOwner(process.pid, tokenLive)
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
    expect(currentToken()).toBe(tokenLive)
  })

  it('treats malformed current as an unknown state: bounded timeout, never reclaimed, never deleted', async () => {
    const hooks = hostTestSerialTestHooks
    const { acquireHostTestSerialLock } = await import('./host-test-serial.ts')
    writeFileSync(hooks.currentPath(), 'garbage{')
    await expect(acquireHostTestSerialLock(250)).rejects.toThrow('timed out')
    expect(currentToken()).toBeNull() // still unparsable — not reclaimed, not deleted
    expect(existsSync(hooks.currentPath())).toBe(true)
    expect(existsSync(join(lockRoot, 'retired.garbage'))).toBe(false)
  })

  it('treats EPERM liveness as alive/unknown: bounded timeout with no reclaim', async () => {
    const hooks = hostTestSerialTestHooks
    const { acquireHostTestSerialLock } = await import('./host-test-serial.ts')
    const tokenLive = randomUUID()
    presetOwner(process.pid, tokenLive)
    hooks.ops.kill = () => {
      const error = new Error('permission') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    }
    await expect(acquireHostTestSerialLock(250)).rejects.toThrow('timed out')
    expect(currentToken()).toBe(tokenLive)
    expect(existsSync(hooks.retiredBarrier(tokenLive))).toBe(false)
  })

  it('release validation inode mismatch refuses with canonical and Q(token) retained and zero unlink', () => {
    const hooks = hostTestSerialTestHooks
    const tokenLive = randomUUID()
    presetOwner(process.pid, tokenLive)
    hooks.resetCounters()
    hooks.ops.stat = (path: string) => {
      const real = require('node:fs').statSync(path)
      if (path === hooks.retiredBarrier(tokenLive)) return { dev: real.dev + 1, ino: real.ino }
      return { dev: real.dev, ino: real.ino }
    }
    hooks.releaseWithToken(tokenLive)
    expect(currentToken()).toBe(tokenLive)
    expect(existsSync(hooks.retiredBarrier(tokenLive))).toBe(true)
    expect(hooks.counters()).toMatchObject({ unlinkCalls: 0 })
  })

  it('release validation I/O failure throws explicitly with canonical and Q(token) retained', () => {
    const hooks = hostTestSerialTestHooks
    const tokenLive = randomUUID()
    presetOwner(process.pid, tokenLive)
    hooks.resetCounters()
    hooks.ops.stat = (path: string) => {
      if (path === hooks.retiredBarrier(tokenLive)) {
        const error = new Error('io') as NodeJS.ErrnoException
        error.code = 'EIO'
        throw error
      }
      const real = require('node:fs').statSync(path)
      return { dev: real.dev, ino: real.ino }
    }
    expect(() => hooks.releaseWithToken(tokenLive)).toThrow('release validation I/O failed')
    expect(currentToken()).toBe(tokenLive)
    expect(existsSync(hooks.retiredBarrier(tokenLive))).toBe(true)
    expect(hooks.counters()).toMatchObject({ unlinkCalls: 0 })
  })

  it('reclaim validation inode mismatch fails explicitly with canonical and Q(T) retained', () => {
    const hooks = hostTestSerialTestHooks
    const tokenT = randomUUID()
    presetOwner(DEAD_PID, tokenT)
    hooks.resetCounters()
    hooks.ops.stat = (path: string) => {
      const real = require('node:fs').statSync(path)
      if (path === hooks.retiredBarrier(tokenT)) return { dev: real.dev, ino: real.ino + 1 }
      return { dev: real.dev, ino: real.ino }
    }
    expect(() => hooks.reclaimStale({ schema: 1, pid: DEAD_PID, token: tokenT })).toThrow('inode mismatch')
    expect(currentToken()).toBe(tokenT)
    expect(existsSync(hooks.retiredBarrier(tokenT))).toBe(true)
    expect(hooks.counters()).toMatchObject({ unlinkCalls: 0 })
  })

  it('reclaim validation read I/O failure fails explicitly with canonical and Q(T) retained', () => {
    const hooks = hostTestSerialTestHooks
    const tokenT = randomUUID()
    presetOwner(DEAD_PID, tokenT)
    hooks.resetCounters()
    hooks.ops.read = (path: string) => {
      if (path === hooks.retiredBarrier(tokenT)) {
        const error = new Error('io') as NodeJS.ErrnoException
        error.code = 'EIO'
        throw error
      }
      return require('node:fs').readFileSync(path, 'utf8')
    }
    expect(() => hooks.reclaimStale({ schema: 1, pid: DEAD_PID, token: tokenT })).toThrow('reclaim validation I/O failed')
    expect(currentToken()).toBe(tokenT)
    expect(existsSync(hooks.retiredBarrier(tokenT))).toBe(true)
    expect(hooks.counters()).toMatchObject({ unlinkCalls: 0 })
  })

  it('reclaim canonical unlink ENOENT after verified Q(T) surfaces explicitly with Q(T) retained (R9 issue 2)', () => {
    const hooks = hostTestSerialTestHooks
    const tokenT = randomUUID()
    presetOwner(DEAD_PID, tokenT)
    hooks.resetCounters()
    hooks.ops.unlink = (path: string) => {
      if (path === hooks.currentPath()) {
        const error = new Error('gone') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      require('node:fs').unlinkSync(path)
    }
    let unlinkCode = ''
    try {
      hooks.reclaimStale({ schema: 1, pid: DEAD_PID, token: tokenT })
    } catch (error) {
      unlinkCode = String((error as NodeJS.ErrnoException).code)
    }
    expect(unlinkCode).toBe('ENOENT')
    hooks.resetOps()
    expect(existsSync(hooks.retiredBarrier(tokenT))).toBe(true) // Q(T) retained as evidence
    expect(existsSync(hooks.currentPath())).toBe(true) // canonical retained: the unlink result surfaced
    expect(currentToken()).toBe(tokenT)
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
    presetOwner(process.pid, randomUUID())
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
    const tokenLive = randomUUID()
    presetOwner(process.pid, tokenLive)
    await expect(acquireHostTestSerialLock(250)).rejects.toThrow('timed out')
    expect(currentToken()).toBe(tokenLive)
    expect(existsSync(hooks.retiredBarrier(tokenLive))).toBe(false)
  })
})
