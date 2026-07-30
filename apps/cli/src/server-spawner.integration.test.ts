import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import { processIdentityMatches } from './cli-thread-store.ts'
import { spawnServer, type SpawnedServer } from './server-spawner.ts'

const tempDirs: string[] = []
const processes: Subprocess[] = []
const servers: SpawnedServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => {})
  for (const proc of processes.splice(0)) {
    if (proc.exitCode === null) proc.kill('SIGKILL')
    await proc.exited.catch(() => {})
  }
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function readJsonLine(proc: Subprocess, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const stdout = proc.stdout as ReadableStream<Uint8Array>
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  const readLine = async (): Promise<Record<string, unknown>> => {
    let buffer = ''
    while (true) {
      const result = await reader.read()
      if (result.done) throw new Error('process closed before emitting JSON')
      buffer += decoder.decode(result.value, { stream: true })
      const newline = buffer.indexOf('\n')
      if (newline >= 0) return JSON.parse(buffer.slice(0, newline))
    }
  }
  return Promise.race([
    readLine(),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error('timed out waiting for fixture JSON')
    }),
  ])
}

describe('server spawner process integration', () => {
  it('drains noisy stderr, bounds diagnostics, and removes invocation secrets from child env', async () => {
    const secret = 'server-spawner-secret-value-123456'
    process.env.POLO_FAKE_API_KEY = secret
    try {
      const server = await spawnServer({
        serverEntry: join(import.meta.dir, '__fixtures__', 'noisy-server.ts'),
        quiet: true,
        secrets: [secret],
        startupTimeout: 10_000,
      })
      servers.push(server)
      await Bun.sleep(100)

      const diagnostics = server.diagnostics()
      expect(diagnostics.length).toBeLessThanOrEqual(16 * 1024)
      expect(diagnostics).not.toContain(secret)
      expect(diagnostics).toContain('credential=missing')
    } finally {
      delete process.env.POLO_FAKE_API_KEY
    }
  }, 20_000)

  it('runtime detects parent SIGKILL through inherited-pipe EOF and exits', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'polo-owner-sentinel-'))
    tempDirs.push(root)
    const proc = Bun.spawn([
      'bun',
      'run',
      join(import.meta.dir, '__fixtures__', 'owner-sentinel.ts'),
      root,
    ], {
      cwd: join(import.meta.dir, '..', '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    })
    processes.push(proc)
    const stderrDrain = new Response(proc.stderr!).text()
    const info = await readJsonLine(proc)
    const runtimePid = Number(info.runtimePid)
    const runtimeIdentity = String(info.runtimeIdentity)
    expect(processIdentityMatches(runtimePid, runtimeIdentity)).toBe(true)

    proc.kill('SIGKILL')
    await proc.exited

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && processIdentityMatches(runtimePid, runtimeIdentity)) {
      await Bun.sleep(100)
    }
    if (processIdentityMatches(runtimePid, runtimeIdentity)) {
      process.kill(runtimePid, 'SIGTERM')
      throw new Error(`runtime ${runtimePid} survived parent SIGKILL`)
    }
    await stderrDrain
  }, 30_000)

  it('rejects a concurrent resume from an independent CLI process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-concurrent-resume-'))
    tempDirs.push(root)
    const holder = Bun.spawn([
      'bun',
      'run',
      join(import.meta.dir, '__fixtures__', 'lease-holder.ts'),
      root,
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    })
    processes.push(holder)
    const holderStderr = new Response(holder.stderr!).text()
    const info = await readJsonLine(holder)
    const threadId = String(info.threadId)

    const contender = Bun.spawn([
      'bun',
      'run',
      join(import.meta.dir, 'index.ts'),
      'exec',
      'resume',
      threadId,
      '--',
      'continue',
    ], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        POLO_AI_CONFIG_DIR: root,
      },
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      contender.exited,
      new Response(contender.stdout!).text(),
      new Response(contender.stderr!).text(),
    ])

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('already active')
    holder.kill('SIGTERM')
    await holder.exited
    await holderStderr
  }, 20_000)

  it('finalizes and releases a newly created Thread when runtime startup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-early-lifecycle-'))
    tempDirs.push(root)
    const proc = Bun.spawn([
      'bun',
      'run',
      join(import.meta.dir, 'index.ts'),
      'exec',
      '--server-entry',
      join(root, 'missing-server-entry.ts'),
      'hello',
    ], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        POLO_AI_CONFIG_DIR: root,
      },
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout!).text(),
      new Response(proc.stderr!).text(),
    ])

    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('Server process exited before printing POLO_AI_SERVER_URL')

    const executionsRoot = join(root, 'cli-sessions', 'global', 'executions')
    const threadIds = await readdir(executionsRoot)
    expect(threadIds).toHaveLength(1)
    const threadRoot = join(executionsRoot, threadIds[0]!)
    const metadata = JSON.parse(await Bun.file(join(threadRoot, 'thread.json')).text())
    expect(metadata.status).toBe('failed')
    expect(await Bun.file(join(threadRoot, 'owner.json')).exists()).toBe(false)
    expect(await Bun.file(join(root, 'sessions')).exists()).toBe(false)
  }, 20_000)
})
