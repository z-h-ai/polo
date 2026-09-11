import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostTestSerialTestHooks } from './host-test-serial.ts'

// Deterministic child IPC/barrier proof for the hard-link serial lock protocol (R14 §5.4).
// Children run a scripted role against an isolated LOCK_ROOT; the parent drives barriers through
// marker files and polls with bounded deadlines — no sleep-based race guessing. Role-prefixed
// markers keep parent assertions independent of acquisition order under load.

const SERIAL_HELPER = join(import.meta.dir, 'host-test-serial.ts')
const DEAD_PID = 999999999
let workRoot: string
let lockRoot: string
let childPath: string
const children: Array<{ exited: Promise<number>; stderrFile: string; role: string }> = []

function childScript(): string {
  return [
    "const [serialHelper, root, role, work] = process.argv.slice(2)",
    "const m = await import(serialHelper)",
    "const fs = await import('node:fs')",
    "m.hostTestSerialTestHooks.setLockRoot(root)",
    "const poll = (path, timeoutMs) => new Promise((resolve, reject) => {",
    "  const deadline = Date.now() + timeoutMs",
    "  const tick = () => (fs.existsSync(path) ? resolve() : Date.now() > deadline ? reject(new Error('barrier timeout: ' + path)) : setTimeout(tick, 5))",
    "  tick()",
    "})",
    "const ownerToken = () => JSON.parse(fs.readFileSync(m.hostTestSerialTestHooks.currentPath(), 'utf8')).token",
    "if (role === 'hold-until-signal') {",
    "  await m.acquireHostTestSerialLock(30000)",
    "  const token = ownerToken()",
    "  fs.writeFileSync(work + '/enter-HOLD-' + token, '')",
    "  await poll(work + '/go-HOLD-' + token, 60000)",
    "  m.releaseHostTestSerialLock()",
    "  fs.writeFileSync(work + '/exit-HOLD-' + token, '')",
    "}",
    "if (role === 'reclaim-once') {",
    "  await m.acquireHostTestSerialLock(30000)",
    "  const token = ownerToken()",
    "  fs.writeFileSync(work + '/enter-RECLAIM-' + token, '')",
    "  m.releaseHostTestSerialLock()",
    "  fs.writeFileSync(work + '/exit-RECLAIM-' + token, '')",
    "}",
    "process.exit(0)",
  ].join('\n')
}
function spawnChild(role: string): void {
  const stderrFile = join(workRoot, `stderr-${role}-${children.length}`)
  const proc = Bun.spawn([process.execPath, childPath, SERIAL_HELPER, lockRoot, role, workRoot], { stdout: 'pipe', stderr: 'pipe' })
  const reportFailure = async (role: string, code: number, proc: ReturnType<typeof Bun.spawn>): Promise<void> => {
    const stderr = await new Response(proc.stderr as ReadableStream).text().catch(() => '')
    if (code !== 0) console.log(`CHILD-FAIL ${role} exit=${code} stderr=${stderr}`)
  }
  void proc.exited.then((code) => reportFailure(role, code, proc))
  children.push({ exited: proc.exited, stderrFile, role })
}
function readdirSafe(directory: string): string[] {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}
const barrierSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
function firstMatch(directory: string, prefix: string): string | null {
  return readdirSafe(directory).find((name) => name.startsWith(prefix)) ?? null
}
async function waitFor(produce: () => string | null, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = produce()
    if (found !== null) return found
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await barrierSleep(10)
  }
}
async function absentFor(directory: string, prefix: string, durationMs: number): Promise<boolean> {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    if (firstMatch(directory, prefix) !== null) return false
    await barrierSleep(20)
  }
  return true
}
function presetDeadOwner(token: string): void {
  const hooks = hostTestSerialTestHooks
  // A PID far above the macOS default process limit is guaranteed dead (ESRCH) and immune to
  // PID-reuse misjudgement during the test window.
  hooks.writeOwnerFile(lockRoot, 999999999, token)
  hooks.publishCandidateFile(hooks.prepareCandidateFile(lockRoot, 999999999, token), lockRoot)
}
beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'serial-lock-work-'))
  lockRoot = join(workRoot, 'locks')
  mkdirSync(lockRoot, { recursive: true })
  hostTestSerialTestHooks.setLockRoot(lockRoot)
  childPath = join(workRoot, 'serial-child.mts')
  writeFileSync(childPath, childScript())
  children.length = 0
})
describe('host test serial lock: hard-link protocol', () => {
  it('serializes two concurrent waiters with maxConcurrent = 1 across retained Q(token) tombstones', async () => {
    // A (hold) enters first; B (reclaim) is spawned while A holds and must stay outside.
    spawnChild('hold-until-signal')
    const firstEnter = await waitFor(() => firstMatch(workRoot, 'enter-HOLD-'), 40000)
    const tokenA = firstEnter.slice('enter-HOLD-'.length)
    expect(await absentFor(workRoot, 'enter-RECLAIM-', 700)).toBe(true)
    spawnChild('reclaim-once')
    expect(await absentFor(workRoot, 'enter-RECLAIM-', 700)).toBe(true)
    // Release A; B enters only after A's exit.
    writeFileSync(join(workRoot, `go-HOLD-${tokenA}`), '')
    expect((await waitFor(() => firstMatch(workRoot, 'exit-HOLD-'), 40000))).not.toBeNull()
    await waitFor(() => firstMatch(workRoot, 'enter-RECLAIM-'), 40000)
    const reclaimedEnter = firstMatch(workRoot, 'enter-RECLAIM-')!
    const reclaimedToken = reclaimedEnter.slice('enter-RECLAIM-'.length)
    writeFileSync(join(workRoot, `go-RECLAIM-${reclaimedToken}`), '')
    expect((await waitFor(() => firstMatch(workRoot, 'exit-RECLAIM-'), 40000))).not.toBeNull()
    expect(existsSync(join(lockRoot, `retired.${tokenA}`))).toBe(true)
    expect(existsSync(join(lockRoot, `retired.${reclaimedToken}`))).toBe(true)
  }, 90000)
  it('lets exactly one of two reclaimers retire a dead owner and never delete a successor', async () => {
    presetDeadOwner('T')
    spawnChild('reclaim-once')
    spawnChild('reclaim-once')
    const deadline = Date.now() + 55000
    while (readdirSafe(workRoot).filter((name) => name.startsWith('exit-RECLAIM-')).length < 2 && Date.now() < deadline) await barrierSleep(10)
    expect(readdirSafe(workRoot).filter((name) => name.startsWith('exit-RECLAIM-')).length).toBe(2)
    // Both children acquired non-T tokens; the dead owner T was retired behind its barrier.
    const enterTokens = readdirSafe(workRoot).filter((name) => name.startsWith('enter-RECLAIM-')).map((name) => name.slice('enter-RECLAIM-'.length))
    expect(enterTokens.length).toBe(2)
    for (const token of enterTokens) expect(token).not.toBe('T')
    expect(new Set(enterTokens).size).toBe(2)
    expect(existsSync(join(lockRoot, 'retired.T'))).toBe(true)
    expect(existsSync(hostTestSerialTestHooks.currentPath())).toBe(false)
  }, 60000)
  it('refuses a token-mismatched late release with zero link and zero unlink on a live successor', () => {
    const hooks = hostTestSerialTestHooks
    hooks.writeOwnerFile(lockRoot, process.pid, 'LIVE-1')
    hooks.publishCandidateFile(hooks.prepareCandidateFile(lockRoot, process.pid, 'LIVE-1'), lockRoot)
    expect(hooks.readOwnerFrom(hooks.currentPath())?.token).toBe('LIVE-1')
    hooks.releaseWithToken('STALE-T')
    expect(hooks.readOwnerFrom(hooks.currentPath())?.token).toBe('LIVE-1')
    expect(hooks.readOwnerFrom(hooks.currentPath())?.pid).toBe(process.pid)
    expect(existsSync(hooks.retiredBarrier('STALE-T'))).toBe(false)
  })
  it('stops a stale release at the Q(token) barrier after the owner was retired by a reclaimer', () => {
    const hooks = hostTestSerialTestHooks
    presetDeadOwner('T1')
    // Token check for the late T1 release would pass here (canonical token === T1)...
    expect(hooks.readOwnerFrom(hooks.currentPath())?.token).toBe('T1')
    // ...but a reclaimer retires T1 first: Q(T1) barrier created, canonical unlinked.
    hooks.releaseWithToken('T1')
    expect(existsSync(hooks.retiredBarrier('T1'))).toBe(true)
    expect(existsSync(hooks.currentPath())).toBe(false)
    // A successor publishes the canonical name, then the resumed late T1 release must fail
    // closed at the Q(T1) EEXIST barrier: zero unlink, LIVE-2 survives.
    hooks.writeOwnerFile(lockRoot, process.pid, 'LIVE-2')
    hooks.publishCandidateFile(hooks.prepareCandidateFile(lockRoot, process.pid, 'LIVE-2'), lockRoot)
    hooks.releaseWithToken('T1')
    expect(hooks.readOwnerFrom(hooks.currentPath())?.token).toBe('LIVE-2')
  })
  it('classifies absent owners as never reclaimable and leaves no stray barrier', () => {
    const hooks = hostTestSerialTestHooks
    expect(hooks.readOwnerFrom(join(lockRoot, 'missing'))).toBeNull()
    presetDeadOwner('T')
    hooks.releaseWithToken('T')
    expect(existsSync(hooks.currentPath())).toBe(false)
    expect(hooks.readOwnerFrom(hooks.currentPath())).toBeNull()
  })
})
