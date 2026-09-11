import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// These spawn-heavy host fixtures run in separate bun test workers that start concurrently.
// Holding this filesystem lock keeps at most one of them active at a time so the rest of the
// suite never runs under their combined load.
//
// Protocol (R14 §5, review issue `host-test-lock-stale-reclaim-race`): complete candidate file +
// atomic hard-link publish + token-specific retained hard-link barrier `Q(token)`. A reclaimer
// never unlinks based on a check-then-delete race: it first publishes the current inode into the
// retired barrier `Q(T)` (atomic no-overwrite link), verifies device/inode, token and a second
// ESRCH, and only then unlinks the canonical name. A successor that acquired after the swap can
// never have its live lock removed by an older reclaimer.
// The root is fixed at module scope for the default production scheduling; tests inject an
// isolated root exclusively through `hostTestSerialTestHooks.setLockRoot` (R14 §5.4).
let LOCK_ROOT = join(tmpdir(), 'polo-pi-host-tests.serial.locks')
const currentPath = (): string => join(LOCK_ROOT, 'current')
interface LockOwner { schema: 1; pid: number; token: string }
let ownToken: string | null = null

function readOwnerFrom(path: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockOwner>
    if (parsed?.schema === 1 && typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.token === 'string' && parsed.token.length > 0) {
      return { schema: 1, pid: parsed.pid, token: parsed.token }
    }
    return null
  } catch {
    return null
  }
}
// Liveness (R14 §5.2): only errno ESRCH proves dead. Success is alive; EPERM and every other
// error are treated as alive/unknown and never authorize reclamation.
function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
// Complete candidate file: exclusive create, fsync, close, read-back verification. Any mismatch
// fails closed instead of publishing an unverified owner (R14 §5.1).
function writeCandidateFile(token: string): string {
  const candidate = join(LOCK_ROOT, `candidate.${token}`)
  const fd = openSync(candidate, 'wx')
  try {
    writeSync(fd, JSON.stringify({ schema: 1 as const, pid: process.pid, token } satisfies LockOwner))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const verified = readOwnerFrom(candidate)
  if (verified === null || verified.token !== token || verified.pid !== process.pid) {
    try { unlinkSync(candidate) } catch { /* best effort */ }
    throw new Error('host test serial lock candidate validation failed')
  }
  return candidate
}
// Atomic no-overwrite publish: `linkSync(candidate, canonical)` fails with EEXIST when any
// canonical already exists — empty, malformed or valid — and never overwrites it.
function publishCandidate(candidate: string): boolean {
  try {
    linkSync(candidate, currentPath())
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}
function sameInode(a: string, b: string): boolean {
  const sa = statSync(a)
  const sb = statSync(b)
  return sa.dev === sb.dev && sa.ino === sb.ino
}
// Retained barrier Q(token): created by atomic hard link, kept non-empty, never deleted on a
// TTL, never restored back onto the canonical name (R14 §5.3).
function retiredBarrier(token: string): string {
  return join(LOCK_ROOT, `retired.${token}`)
}
// Reclaim protocol (R14 §5.3): after observing a dead PID for token T, hard-link the canonical
// into Q(T) (atomic), verify canonical/Q(T) share device+inode, re-read Q(T) owner token === T,
// re-confirm ESRCH, and only then unlink the canonical name. Token/inode mismatch, malformed
// records or validation I/O failures fail closed with both paths retained.
function reclaimStale(owner: LockOwner): void {
  if (!isDead(owner.pid)) return
  const barrier = retiredBarrier(owner.token)
  let barrierCreated = false
  try {
    linkSync(currentPath(), barrier)
    barrierCreated = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  try {
    if (!sameInode(currentPath(), barrier)) return
    const canonicalOwner = readOwnerFrom(currentPath())
    if (canonicalOwner === null || canonicalOwner.token !== owner.token) return
    if (!isDead(canonicalOwner.pid)) return
    unlinkSync(currentPath())
  } catch {
    // Fail closed: retain canonical and Q(T) evidence; never unlink on uncertain state.
  } finally {
    void barrierCreated
  }
}
export async function acquireHostTestSerialLock(timeoutMs = 300000): Promise<void> {
  mkdirSync(LOCK_ROOT, { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const token = randomUUID()
    let candidate: string
    try {
      candidate = writeCandidateFile(token)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue // token collision: retry
      throw error
    }
    let published = false
    try {
      published = publishCandidate(candidate)
    } finally {
      // Only clean up our own candidate name; the published hard link keeps the inode alive.
      try { unlinkSync(candidate) } catch { /* already unlinked */ }
    }
    if (published) {
      ownToken = token
      const canonicalOwner = readOwnerFrom(currentPath())
      if (canonicalOwner === null || canonicalOwner.token !== token) {
        releaseHostTestSerialLock()
        throw new Error('host test serial lock publish validation failed')
      }
      return
    }
    const owner = readOwnerFrom(currentPath())
    if (owner !== null && isDead(owner.pid)) reclaimStale(owner)
    if (Date.now() >= deadline) throw new Error('host test serial lock timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
export function releaseHostTestSerialLock(): void {
  releaseWithToken(ownToken)
  ownToken = null
}
// Release protocol (R14 §5.3.4): verify the canonical token first, then hard-link the canonical
// into Q(token), verify inode/token, and only then unlink. Token mismatch, canonical replacement
// (EEXIST barrier from an earlier retirement) or validation failure refuses the late release with
// zero link/unlink side effects on a successor.
function releaseWithToken(token: string | null): void {
  if (token === null) return
  const owner = readOwnerFrom(currentPath())
  if (owner === null || owner.token !== token) return
  const barrier = retiredBarrier(token)
  let barrierReady = false
  try {
    linkSync(currentPath(), barrier)
    barrierReady = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    barrierReady = true
  }
  try {
    if (!sameInode(currentPath(), barrier)) return
    const canonicalOwner = readOwnerFrom(currentPath())
    if (canonicalOwner === null || canonicalOwner.token !== token) return
    unlinkSync(currentPath())
  } catch {
    // Fail closed: keep canonical and barrier; never unlink a successor.
  }
}
function siblingTestWorkerExists(): boolean {
  try {
    const listing = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    return listing.split('\n').some((line) => {
      const pid = Number(line.trimStart().split(/\s+/, 1)[0])
      return pid !== process.pid && pid > 1 && line.includes('bun test --test-worker')
    })
  } catch {
    return false
  }
}
// Inside the full suite this file sits at the very front of bun's discovery order, directly ahead
// of load-sensitive suites (pi subprocess acceptance, transport bundle fixtures). Waiting out a
// bounded early-suite window lets those fixtures run against a quiet machine before any host
// worker spawn begins. Direct/targeted invocations with no sibling worker skip the wait.
export async function waitOutEarlySuiteWindow(graceMs = 75_000): Promise<void> {
  if (!siblingTestWorkerExists()) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    if (!siblingTestWorkerExists()) return
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250))
}
// Test-only surface (R14 §5.4): deterministic hooks injected exclusively through
// `host-test-serial.test.ts`; the default production scheduling above never imports them.
export const hostTestSerialTestHooks = {
  lockRoot(): string {
    return LOCK_ROOT
  },
  setLockRoot(root: string): void {
    LOCK_ROOT = root
  },
  currentPath(): string {
    return currentPath()
  },
  retiredBarrier,
  readOwnerFrom,
  writeOwnerFile(directory: string, pid: number, token: string): void {
    writeFileSync(join(directory, 'owner'), JSON.stringify({ schema: 1 as const, pid, token } satisfies LockOwner))
  },
  prepareCandidateFile(root: string, pid: number, token: string): string {
    const candidate = join(root, `candidate.${token}`)
    const fd = openSync(candidate, 'wx')
    try {
      writeSync(fd, JSON.stringify({ schema: 1 as const, pid, token } satisfies LockOwner))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return candidate
  },
  publishCandidateFile(candidate: string, root: string): boolean {
    try {
      linkSync(candidate, join(root, 'current'))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  },
  releaseWithToken,
  isDead,
}
