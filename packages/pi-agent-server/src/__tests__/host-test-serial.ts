import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// These spawn-heavy host fixtures run in separate bun test workers that start
// concurrently. Holding this filesystem lock keeps at most one of them active
// at a time so the rest of the suite never runs under their combined load.
const LOCK_PATH = join(tmpdir(), 'polo-pi-host-tests.serial.lock')

function lockHolderPid(): number | null {
  try {
    return Number(readFileSync(LOCK_PATH, 'utf8'))
  } catch {
    return null
  }
}

function holderIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function tryAcquire(): boolean {
  try {
    const fd = openSync(LOCK_PATH, 'wx')
    writeSync(fd, String(process.pid))
    closeSync(fd)
    return true
  } catch {
    return false
  }
}

export async function acquireHostTestSerialLock(timeoutMs = 300000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pid = lockHolderPid()
    if (pid !== null && pid !== process.pid && !holderIsAlive(pid)) rmSync(LOCK_PATH, { force: true })
    if (tryAcquire()) return
    if (Date.now() >= deadline) throw new Error('host test serial lock timed out')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export function releaseHostTestSerialLock(): void {
  try {
    if (lockHolderPid() === process.pid) rmSync(LOCK_PATH, { force: true })
  } catch {
    // Best effort only; a leaked stale lock is reclaimed via the liveness probe.
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

// Inside the full suite this file sits at the very front of bun's discovery
// order, directly ahead of load-sensitive suites (pi subprocess acceptance,
// transport bundle fixtures). Waiting out a bounded early-suite window lets
// those fixtures run against a quiet machine before any host worker spawn
// begins. Direct/targeted invocations with no sibling worker skip the wait.
export async function waitOutEarlySuiteWindow(graceMs = 75_000): Promise<void> {
  if (!siblingTestWorkerExists()) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    if (!siblingTestWorkerExists()) return
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250))
}
