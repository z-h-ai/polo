import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'

const SMOKE_TEST = join(import.meta.dir, 'smoke.test.ts')
const TEST_TIMEOUT = 120_000

interface TraceEvent {
  event: 'allocated' | 'started' | 'cleaned' | 'spawn-error'
  instanceId: string
  pid?: number
  url?: string
  tempRoot: string
  configDir: string
  runtimeDir: string
  exitCode?: number
}

interface RunnerResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function collect(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  return new Response(stream).text()
}

async function stopRunner(proc: Subprocess): Promise<number> {
  if (proc.exitCode === null) {
    proc.kill('SIGTERM')
  }
  const graceful = await Promise.race([
    proc.exited.then((exitCode) => ({ exitCode })),
    Bun.sleep(5_000).then(() => null),
  ])
  if (graceful) return graceful.exitCode
  if (proc.exitCode === null) proc.kill('SIGKILL')
  return proc.exited
}

async function runSmokeRunner(
  root: string,
  tempParent: string,
  sharedConfig: string,
  sharedRuntime: string,
  name: string,
  activeRunners: Set<Subprocess>,
): Promise<RunnerResult> {
  const traceFile = join(root, `${name}.jsonl`)
  const { CLAUDECODE: _, ...parentEnv } = process.env
  const proc = Bun.spawn([process.execPath, 'test', SMOKE_TEST], {
    env: {
      ...parentEnv,
      // Reproduce the old failure mode: both test runners inherit the same
      // config/runtime. spawnTestServer must replace both for every child.
      POLO_AI_CONFIG_DIR: sharedConfig,
      POLO_AI_SERVER_RUNTIME_DIR: sharedRuntime,
      POLO_AI_SMOKE_TEMP_PARENT: tempParent,
      POLO_AI_SMOKE_TRACE_FILE: traceFile,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  activeRunners.add(proc)
  const stdoutPromise = collect(proc.stdout as ReadableStream<Uint8Array>)
  const stderrPromise = collect(proc.stderr as ReadableStream<Uint8Array>)
  const exitCode = await proc.exited
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  activeRunners.delete(proc)
  return { exitCode, stdout, stderr }
}

function parseTrace(path: string): TraceEvent[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (open: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(300, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function findServerLocks(path: string): string[] {
  if (!existsSync(path)) return []
  const locks: string[] = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) {
      locks.push(...findServerLocks(entryPath))
    } else if (entry.name === '.server.lock') {
      locks.push(entryPath)
    }
  }
  return locks
}

describe('concurrent headless smoke runners', () => {
  let root = ''
  const activeRunners = new Set<Subprocess>()

  afterEach(async () => {
    await Promise.all([...activeRunners].map((proc) => stopRunner(proc)))
    activeRunners.clear()
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  it('isolates and completely cleans every server from two simultaneous runners', async () => {
    root = mkdtempSync(join(tmpdir(), 'polo-smoke-concurrency-'))
    const tempParent = join(root, 'server-temp')
    const sharedConfig = join(root, 'shared-config')
    const sharedRuntime = join(root, 'shared-runtime')
    for (const path of [tempParent, sharedConfig, sharedRuntime]) {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    }

    const [runnerA, runnerB] = await Promise.all([
      runSmokeRunner(root, tempParent, sharedConfig, sharedRuntime, 'runner-a', activeRunners),
      runSmokeRunner(root, tempParent, sharedConfig, sharedRuntime, 'runner-b', activeRunners),
    ])

    for (const [name, result] of [['runner-a', runnerA], ['runner-b', runnerB]] as const) {
      expect(
        result.exitCode,
        `${name} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).toContain('5 pass')
    }

    const events = [
      ...parseTrace(join(root, 'runner-a.jsonl')),
      ...parseTrace(join(root, 'runner-b.jsonl')),
    ]
    const allocated = events.filter((event) => event.event === 'allocated')
    const started = events.filter((event) => event.event === 'started')
    const cleaned = events.filter((event) => event.event === 'cleaned')
    const spawnErrors = events.filter((event) => event.event === 'spawn-error')

    expect(spawnErrors).toHaveLength(0)
    expect(allocated).toHaveLength(10)
    expect(started).toHaveLength(6)
    expect(cleaned).toHaveLength(10)
    expect(new Set(allocated.map((event) => event.tempRoot)).size).toBe(10)
    expect(new Set(allocated.map((event) => event.configDir)).size).toBe(10)
    expect(new Set(allocated.map((event) => event.runtimeDir)).size).toBe(10)
    expect(new Set(cleaned.map((event) => event.instanceId))).toEqual(
      new Set(allocated.map((event) => event.instanceId)),
    )

    for (const event of allocated) {
      expect(existsSync(event.tempRoot)).toBe(false)
      expect(event.configDir).not.toBe(sharedConfig)
      expect(event.runtimeDir).not.toBe(sharedRuntime)
      expect(event.pid == null || isPidAlive(event.pid)).toBe(false)
    }
    for (const event of started) {
      const port = Number(new URL(event.url!).port)
      expect(await isPortOpen(port)).toBe(false)
    }

    expect(readdirSync(tempParent)).toEqual([])
    expect(readdirSync(sharedConfig)).toEqual([])
    expect(readdirSync(sharedRuntime)).toEqual([])
    expect(findServerLocks(root)).toEqual([])
  }, TEST_TIMEOUT)
})
