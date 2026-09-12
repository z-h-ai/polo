import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Serial lock protocol for spawn-heavy host fixtures (R14 §5).
// Dedicated LOCK_ROOT + complete candidate files + atomic hard-link publish +
// token-specific retained hard-link barriers Q(T) for stale reclaim and release.
//
// State-machine contract (R14 §5.2–5.3, Fix R8 issue 2, Fix R9 issues 2/6): owner reads are
// discriminated (valid / absent / malformed / io_error). Only absent and malformed are
// contract-authorized unknown states that may be waited on; permission, hard-link, stat, read and
// unexpected unlink errors surface as explicit fail-closed I/O errors while retaining canonical
// and Q(T) evidence. Cleanup suppression is limited to ENOENT on the caller's own unpublished
// candidate — canonical unlink results after the retained barrier checks are never suppressed.
// Owner tokens must match the generated canonical-UUID grammar and every derived lock path must
// remain a direct child of LOCK_ROOT (same-root hard-link contract).

export interface LockOwner { schema: 1; pid: number; token: string }
export type OwnerRead =
  | { kind: 'valid'; owner: LockOwner }
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'io_error'; cause: NodeJS.ErrnoException }

const DEFAULT_LOCK_ROOT = join(tmpdir(), 'polo-pi-host-tests.serial.locks')
let LOCK_ROOT = DEFAULT_LOCK_ROOT
// Owner tokens are the generated canonical UUIDs; any other value (including path-escaping
// tokens like `x/../../escaped`) makes the owner record malformed (R9 issue 6).
const LOCK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function isValidLockToken(token: string): boolean {
  return LOCK_TOKEN_PATTERN.test(token)
}
const currentPath = (): string => join(LOCK_ROOT, 'current')
const retiredBarrier = (token: string): string => {
  // Defense in depth: even a grammar-valid token must derive a barrier path that is a direct
  // child of LOCK_ROOT, so a crafted owner record can never move a hard-link target outside it.
  const barrier = join(LOCK_ROOT, `retired.${token}`)
  if (!isValidLockToken(token) || dirname(barrier) !== LOCK_ROOT) throw new Error('host test serial lock token escapes LOCK_ROOT')
  return barrier
}
let ownToken: string | null = null

// ─── Test-only seam (R14 §5.4): default-disabled hooks and injectable ops ────
// With no test installed, `hostTestSerialTestHooks.ops` members call the real Node operations
// and the seam listener is a no-op, so the default schedule is the production schedule.
export type HostTestSerialSeamHook =
  | 'candidate:before-publish'
  | 'candidate:after-link'
  | 'reclaim:after-dead-read'
  | 'reclaim:after-retired-link'
  | 'release:after-token-check'
  | 'retired:before-link'
  | 'retired:after-link'
  | 'lock:enter'
  | 'lock:exit'
export interface HostTestSerialSeamEvent {
  hook: HostTestSerialSeamHook
  token: string | null
  // Deterministic post-operation acknowledgement (R9 issue 3): the after-link seams fire AFTER
  // the hard-link attempt returned, carrying its exact atomic outcome.
  outcome?: 'linked' | 'eexist'
}
export interface HostTestSerialOps {
  read(path: string): string
  stat(path: string): { dev: number; ino: number }
  link(source: string, destination: string): void
  unlink(path: string): void
  kill(pid: number): void
}
export interface HostTestSerialLinkUnlinkCounters { linkCalls: number; unlinkCalls: number }
const defaultOps: HostTestSerialOps = {
  read: (path) => readFileSync(path, 'utf8'),
  stat: (path) => {
    const stats = statSync(path)
    return { dev: stats.dev, ino: stats.ino }
  },
  link: (source, destination) => linkSync(source, destination),
  unlink: (path) => unlinkSync(path),
  kill: (pid) => process.kill(pid, 0),
}
const ops: HostTestSerialOps = { ...defaultOps }
const counters: HostTestSerialLinkUnlinkCounters = { linkCalls: 0, unlinkCalls: 0 }
let seamListener: ((event: HostTestSerialSeamEvent) => void) | null = null
const fireSeam = (hook: HostTestSerialSeamHook, token: string | null, outcome?: 'linked' | 'eexist'): void => {
  if (seamListener !== null) seamListener(outcome === undefined ? { hook, token } : { hook, token, outcome })
}
const readOp = (path: string): string => ops.read(path)
const statOp = (path: string): { dev: number; ino: number } => ops.stat(path)
const linkOp = (source: string, destination: string): void => {
  counters.linkCalls += 1
  ops.link(source, destination)
}
const unlinkOp = (path: string): void => {
  counters.unlinkCalls += 1
  ops.unlink(path)
}
const killOp = (pid: number): void => ops.kill(pid)

export const hostTestSerialTestHooks = {
  setLockRoot(root: string): void {
    LOCK_ROOT = root
  },
  restoreDefaultLockRoot(): void {
    LOCK_ROOT = DEFAULT_LOCK_ROOT
  },
  currentPath,
  retiredBarrier,
  setSeamListener(listener: ((event: HostTestSerialSeamEvent) => void) | null): void {
    seamListener = listener
  },
  ops,
  resetOps(): void {
    Object.assign(ops, defaultOps)
  },
  counters(): HostTestSerialLinkUnlinkCounters {
    return { ...counters }
  },
  resetCounters(): void {
    counters.linkCalls = 0
    counters.unlinkCalls = 0
  },
  readOwnerRecord,
  readOwnerFrom,
  isValidLockToken,
  prepareCandidateFile,
  publishCandidateFile,
  reclaimStale,
  releaseWithToken,
}

// ─── Owner record reading (R14 §5.1–5.2) ────────────────────────────────────
// ENOENT is absent; a record that parses but violates the schema, or JSON that does not parse,
// is malformed; every other read error is io_error with its cause retained.
function readOwnerRecord(path: string): OwnerRead {
  let raw: string
  try {
    raw = readOp(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'io_error', cause: error as NodeJS.ErrnoException }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>
    if (
      parsed?.schema === 1 &&
      typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 &&
      typeof parsed.token === 'string' && parsed.token.length > 0 && isValidLockToken(parsed.token)
    ) {
      return { kind: 'valid', owner: { schema: 1, pid: parsed.pid, token: parsed.token } }
    }
    return { kind: 'malformed' }
  } catch {
    return { kind: 'malformed' }
  }
}
function readOwnerFrom(path: string): LockOwner | null {
  const result = readOwnerRecord(path)
  return result.kind === 'valid' ? result.owner : null
}
// Liveness (R14 §5.2): only errno ESRCH proves dead. Success is alive; EPERM and every other
// error are treated as alive/unknown and never authorize reclamation.
function isDead(pid: number): boolean {
  try {
    killOp(pid)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
// ─── Candidate creation and atomic publish (R14 §5.1) ──────────────────────
// Exclusive create + fsync + close + discriminated readback. Cleanup suppresses only ENOENT on
// the caller's own unpublished candidate; unexpected unlink failures propagate. Publish is
// link(candidate, canonical); only EEXIST is normal competition.
function writeCandidateFile(token: string): string {
  const candidate = join(LOCK_ROOT, `candidate.${token}`)
  const fd = openSync(candidate, 'wx')
  try {
    writeSync(fd, JSON.stringify({ schema: 1 as const, pid: process.pid, token } satisfies LockOwner))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const verified = readOwnerRecord(candidate)
  if (verified.kind !== 'valid' || verified.owner.token !== token || verified.owner.pid !== process.pid) {
    unlinkCandidateQuietly(candidate)
    if (verified.kind === 'io_error') throw new Error('host test serial lock candidate read failed (fail-closed I/O)', { cause: verified.cause })
    throw new Error('host test serial lock candidate validation failed')
  }
  return candidate
}
function unlinkCandidateQuietly(candidate: string): void {
  try {
    unlinkOp(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
function publishCandidate(token: string, candidate: string): boolean {
  fireSeam('candidate:before-publish', token)
  try {
    linkOp(candidate, currentPath())
    fireSeam('candidate:after-link', token, 'linked')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      fireSeam('candidate:after-link', token, 'eexist')
      return false
    }
    throw error
  }
}
// Test preset helper (R14 §5.4): writes a complete candidate under `root` and publishes it with
// the same atomic hard-link publish used by acquire, then removes the candidate name. Preset
// tokens must satisfy the lock-token grammar so preset paths cannot escape the root either.
function prepareCandidateFile(root: string, pid: number, token: string): string {
  if (!isValidLockToken(token)) throw new Error('host test serial lock preset token escapes LOCK_ROOT')
  const candidate = join(root, `candidate.${token}`)
  const fd = openSync(candidate, 'wx')
  try {
    writeSync(fd, JSON.stringify({ schema: 1 as const, pid, token } satisfies LockOwner))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return candidate
}
function publishCandidateFile(candidate: string, root: string): boolean {
  try {
    linkOp(candidate, join(root, 'current'))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    unlinkCandidateQuietly(candidate)
  }
}
// ─── Retained barrier Q(token) (R14 §5.3) ───────────────────────────────────
function sameInode(a: string, b: string): boolean {
  const sa = statOp(a)
  const sb = statOp(b)
  return sa.dev === sb.dev && sa.ino === sb.ino
}
// Reclaim protocol (R14 §5.3): after observing dead T, hard-link canonical into Q(T) (atomic),
// verify canonical/Q(T) share device+inode, re-read Q(T) owner token === T, re-confirm ESRCH,
// then unlink canonical. The dual-reclaimer loser observes EEXIST at the link and fails closed
// without unlinking. Validation anomalies (R14 §5.3.3: inode/token mismatch, malformed, no
// longer provably dead, validation I/O) retain canonical and Q(T) and fail explicitly.
function reclaimStale(owner: LockOwner): void {
  if (!isDead(owner.pid)) return
  const barrier = retiredBarrier(owner.token)
  fireSeam('retired:before-link', owner.token)
  try {
    linkOp(currentPath(), barrier)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      fireSeam('retired:after-link', owner.token, 'eexist') // deterministic loser acknowledgement
      return // dual-reclaimer loser: fail closed
    }
    throw error // permission/cross-filesystem/unsupported hard link: explicit failure, canonical retained
  }
  fireSeam('retired:after-link', owner.token, 'linked')
  fireSeam('reclaim:after-retired-link', owner.token)
  // Every validation failure below retains canonical and Q(T) as evidence (R14 §5.3.3) and
  // surfaces explicitly instead of being swallowed into a retry.
  let same = false
  try {
    same = sameInode(currentPath(), barrier)
  } catch (cause) {
    throw new Error('host test serial lock reclaim validation I/O failed (fail-closed)', { cause })
  }
  if (!same) throw new Error('host test serial lock reclaim validation failed: inode mismatch')
  const barrierOwner = readOwnerRecord(barrier)
  if (barrierOwner.kind === 'io_error') throw new Error('host test serial lock reclaim validation I/O failed (fail-closed)', { cause: barrierOwner.cause })
  if (barrierOwner.kind !== 'valid' || barrierOwner.owner.token !== owner.token) throw new Error('host test serial lock reclaim validation failed: barrier token mismatch')
  if (!isDead(barrierOwner.owner.pid)) throw new Error('host test serial lock reclaim validation failed: owner no longer provably dead')
  // The Q(T) barrier is published and verified, so the canonical unlink result is never
  // suppressed (R9 issue 2): ENOENT or any other error surfaces explicitly with Q(T) retained.
  unlinkOp(currentPath())
}
// Release protocol (R14 §5.3.4): verify canonical token, then hard-link canonical into Q(T),
// verify inode/token, then unlink canonical. A late/foreign release is REFUSED before any link
// when the canonical token does not match, and at the Q(T) EEXIST barrier with zero unlink.
// Release validation I/O surfaces as an explicit error with canonical and Q(T) retained.
function releaseWithToken(token: string | null): void {
  if (token === null) return
  const owner = readOwnerRecord(currentPath())
  if (owner.kind === 'io_error') throw new Error('host test serial lock release read failed (fail-closed I/O)', { cause: owner.cause })
  if (owner.kind !== 'valid' || owner.owner.token !== token) return // refuse: zero link, zero unlink
  fireSeam('release:after-token-check', token)
  const barrier = retiredBarrier(token)
  fireSeam('retired:before-link', token)
  try {
    linkOp(currentPath(), barrier)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      fireSeam('retired:after-link', token, 'eexist') // deterministic refusal acknowledgement
      return // refuse: successor protected
    }
    throw error
  }
  fireSeam('retired:after-link', token, 'linked')
  // Every validation refusal below retains canonical and Q(T) as evidence (R14 §5.3.4).
  let same = false
  try {
    same = sameInode(currentPath(), barrier)
  } catch (cause) {
    throw new Error('host test serial lock release validation I/O failed (fail-closed)', { cause })
  }
  if (!same) return // refuse: retain canonical and Q(T)
  const barrierOwner = readOwnerRecord(barrier)
  if (barrierOwner.kind === 'io_error') throw new Error('host test serial lock release validation I/O failed (fail-closed)', { cause: barrierOwner.cause })
  if (barrierOwner.kind !== 'valid' || barrierOwner.owner.token !== token) return // refuse
  unlinkOp(currentPath())
}
// ─── Public API (acquire / release) ─────────────────────────────────────────
export async function acquireHostTestSerialLock(timeoutMs = 300000): Promise<void> {
  mkdirSync(LOCK_ROOT, { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const token = randomUUID()
    let candidate: string
    try {
      candidate = writeCandidateFile(token)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    let published = false
    try {
      published = publishCandidate(token, candidate)
    } finally {
      unlinkCandidateQuietly(candidate) // only the caller's own unpublished candidate; ENOENT-only suppression
    }
    if (published) {
      ownToken = token
      const canonicalOwner = readOwnerRecord(currentPath())
      if (canonicalOwner.kind === 'io_error') {
        releaseHostTestSerialLock()
        throw new Error('host test serial lock publish validation read failed (fail-closed I/O)', { cause: canonicalOwner.cause })
      }
      if (canonicalOwner.kind !== 'valid' || canonicalOwner.owner.token !== token) {
        releaseHostTestSerialLock()
        throw new Error('host test serial lock publish validation failed')
      }
      fireSeam('lock:enter', token)
      return
    }
    const owner = readOwnerRecord(currentPath())
    // Permission/hard-link/stat/read I/O uncertainty on `current` fails closed immediately
    // (R14 §5.2.4) instead of surfacing later as a generic timeout.
    if (owner.kind === 'io_error') throw new Error('host test serial lock current read failed (fail-closed I/O)', { cause: owner.cause })
    // Only a valid owner whose liveness call is exactly ESRCH may reclaim.
    if (owner.kind === 'valid' && isDead(owner.owner.pid)) {
      fireSeam('reclaim:after-dead-read', owner.owner.token)
      reclaimStale(owner.owner)
      continue
    }
    // absent/malformed/alive-or-unknown: contract-authorized unknown states → bounded wait, never reclaim.
    if (Date.now() >= deadline) throw new Error('host test serial lock timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
export function releaseHostTestSerialLock(): void {
  const token = ownToken
  releaseWithToken(token)
  ownToken = null
  if (token !== null) fireSeam('lock:exit', token)
}
// ─── Early suite window ─────────────────────────────────────────────────────
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
export async function waitOutEarlySuiteWindow(graceMs = 75_000): Promise<void> {
  if (!siblingTestWorkerExists()) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    if (!siblingTestWorkerExists()) return
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250))
}
