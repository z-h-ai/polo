import { afterEach, describe, expect, it } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { constants as osConstants, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import {
  acquireCliThreadLease,
  createCliThread,
  processIdentityMatches,
  updateCliThread,
} from './cli-thread-store.ts'
import { readCliMainSessionSummary } from './one-shot.ts'
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

async function runLifecycleFailure(mode: 'disconnect' | 'heartbeat') {
  const root = await mkdtemp(join(tmpdir(), `polo-${mode}-failure-`))
  tempDirs.push(root)
  await writeFile(
    join(root, '.polo-lifecycle-fixture.json'),
    JSON.stringify({ mode }),
  )
  const proc = Bun.spawn([
    'bun',
    'run',
    join(import.meta.dir, '__fixtures__', 'one-shot-with-server.ts'),
    root,
    join(import.meta.dir, '__fixtures__', 'lifecycle-failure-server.ts'),
    'exec',
    '--json',
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
  processes.push(proc)
  const exitCode = await Promise.race([
    proc.exited,
    Bun.sleep(12_000).then(() => {
      proc.kill('SIGKILL')
      throw new Error(`${mode} lifecycle process did not terminate`)
    }),
  ])
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout!).text(),
    new Response(proc.stderr!).text(),
  ])
  const executionsRoot = join(root, 'cli-sessions', 'global', 'executions')
  const threadIds = await readdir(executionsRoot)
  expect(threadIds).toHaveLength(1)
  const threadRoot = join(executionsRoot, threadIds[0]!)
  return { root, exitCode, stdout, stderr, threadRoot }
}

describe('server spawner process integration', () => {
  it('drains noisy stderr, bounds diagnostics, and removes invocation secrets from child env', async () => {
    const secret = 'server-spawner-secret-value-123456'
    process.env.POLO_FAKE_API_KEY = secret
    process.env.COMPANY_SSO_REFRESH_MATERIAL = 'unknown-oauth-refresh-secret'
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
      expect(diagnostics).not.toContain('unknown-oauth-refresh-secret')
      expect(diagnostics).toContain('credential=missing')
      expect(diagnostics).toContain('custom-oauth=missing')
    } finally {
      delete process.env.POLO_FAKE_API_KEY
      delete process.env.COMPANY_SSO_REFRESH_MATERIAL
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
      join(import.meta.dir, '__fixtures__', 'one-shot-with-server.ts'),
      root,
      join(root, 'missing-server-entry.ts'),
      'exec',
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

  it('fails and cleans up when RPC disconnects after sendMessage ACK', async () => {
    const result = await runLifecycleFailure('disconnect')
    expect(result.exitCode, result.stderr).toBe(1)
    for (const line of result.stdout.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    expect(result.stdout).toContain('WebSocket disconnected')
    const metadata = JSON.parse(
      await readFile(join(result.threadRoot, 'thread.json'), 'utf-8'),
    )
    expect(metadata.status).toBe('failed')
    expect(await Bun.file(join(result.threadRoot, 'owner.json')).exists()).toBe(false)
  }, 20_000)

  it('fails and cleans up when lease heartbeat persistence is lost', async () => {
    const result = await runLifecycleFailure('heartbeat')
    expect(result.exitCode, result.stderr).toBe(1)
    expect(result.stdout).toContain('ENOENT')
    const metadata = JSON.parse(
      await readFile(join(result.threadRoot, 'thread.json'), 'utf-8'),
    )
    expect(metadata.status).toBe('failed')
    expect(await Bun.file(join(result.threadRoot, 'owner.json')).exists()).toBe(false)
  }, 20_000)

  it('handles SIGINT/SIGTERM at every startup lifecycle boundary', async () => {
    if (process.platform === 'win32') return
    const cases = [
      { stage: 'thread:create', signal: 'SIGTERM', mode: 'persistent' },
      { stage: 'thread:create', signal: 'SIGINT', mode: 'persistent' },
      { stage: 'snapshot', signal: 'SIGTERM', mode: 'persistent' },
      { stage: 'spawnServer', signal: 'SIGTERM', mode: 'persistent' },
      { stage: 'connect', signal: 'SIGTERM', mode: 'persistent' },
      { stage: 'session:create', signal: 'SIGTERM', mode: 'persistent' },
      { stage: 'thread:create', signal: 'SIGTERM', mode: 'run-no-cleanup' },
    ] as const

    for (const { stage, signal, mode } of cases) {
      const root = await mkdtemp(join(
        tmpdir(),
        `polo-startup-signal-${mode}-${stage.replace(':', '-')}-${signal.toLowerCase()}-`,
      ))
      tempDirs.push(root)
      const markerFile = join(root, 'stage-ready')
      const runtimeInfoFile = join(root, 'runtime-info.json')
      await writeFile(
        join(root, '.polo-lifecycle-fixture.json'),
        JSON.stringify({ mode: 'hang', runtimeInfoFile }),
      )
      const proc = Bun.spawn([
        'bun',
        'run',
        join(import.meta.dir, '__fixtures__', 'execution-signal-stage.ts'),
        root,
        stage,
        markerFile,
        join(import.meta.dir, '__fixtures__', 'lifecycle-failure-server.ts'),
        mode,
      ], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env },
      })
      processes.push(proc)

      const readyDeadline = Date.now() + 15_000
      while (!(await Bun.file(markerFile).exists())) {
        if (proc.exitCode !== null) {
          throw new Error(`${stage} fixture exited before reaching its lifecycle boundary`)
        }
        if (Date.now() >= readyDeadline) {
          proc.kill('SIGKILL')
          throw new Error(`${stage} fixture did not reach its lifecycle boundary`)
        }
        await Bun.sleep(10)
      }
      const stageState = JSON.parse(await readFile(markerFile, 'utf-8')) as {
        stage: string
        ephemeral: boolean
        directory?: string
        mainSessionId?: string
        persistence?: string
      }
      expect(stageState).toMatchObject({
        stage,
        ephemeral: false,
        persistence: 'persistent',
      })

      proc.kill(signal)
      if (stage === 'thread:create' && signal === 'SIGTERM') {
        await Bun.sleep(20)
        proc.kill('SIGINT')
      }
      const exitCode = await Promise.race([
        proc.exited,
        Bun.sleep(15_000).then(() => {
          proc.kill('SIGKILL')
          throw new Error(`${stage} signal cleanup did not finish`)
        }),
      ])
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout!).text(),
        new Response(proc.stderr!).text(),
      ])
      expect(exitCode, `${stage}: ${stderr}`).toBe(signal === 'SIGINT' ? 130 : 143)
      expect(stdout, stage).toBe('')
      if (mode === 'run-no-cleanup') {
        expect(stderr, stage).toContain('thread_id:')
        expect(stderr, stage).toContain('thread_dir:')
      } else {
        expect(stderr, stage).toBe('')
      }
      const threadIds = await readdir(
        join(root, 'cli-sessions', 'global', 'executions'),
      ).catch(() => [])
      if (stage === 'session:create') {
        expect(stageState.mainSessionId).toBe('fixture-session')
        expect(stageState.directory).toBeTruthy()
        expect(await stat(stageState.directory!).then(() => true).catch(() => false)).toBe(true)
        expect(threadIds, stage).toHaveLength(1)
        const threadRoot = join(
          root,
          'cli-sessions',
          'global',
          'executions',
          threadIds[0]!,
        )
        expect(JSON.parse(await readFile(
          join(threadRoot, 'thread.json'),
          'utf-8',
        ))).toMatchObject({
          status: 'interrupted',
          mainSessionId: 'fixture-session',
        })
        expect(await Bun.file(join(threadRoot, 'owner.json')).exists()).toBe(false)
      } else {
        expect(threadIds, stage).toHaveLength(1)
        const threadRoot = join(
          root,
          'cli-sessions',
          'global',
          'executions',
          threadIds[0]!,
        )
        expect(JSON.parse(await readFile(
          join(threadRoot, 'thread.json'),
          'utf-8',
        ))).toMatchObject({
          origin: mode === 'run-no-cleanup' ? 'cli-run' : 'cli-exec',
          persistence: 'persistent',
          status: 'interrupted',
        })
        expect(await Bun.file(join(threadRoot, 'owner.json')).exists()).toBe(false)
      }

      if (await Bun.file(runtimeInfoFile).exists()) {
        const runtime = JSON.parse(await readFile(runtimeInfoFile, 'utf-8')) as {
          pid: number
          processIdentity: string
        }
        const runtimeDeadline = Date.now() + 5_000
        while (
          Date.now() < runtimeDeadline
          && processIdentityMatches(runtime.pid, runtime.processIdentity)
        ) {
          await Bun.sleep(20)
        }
        expect(processIdentityMatches(runtime.pid, runtime.processIdentity), stage).toBe(false)
      }
    }
  }, 90_000)

  it('resume --last skips active, deleting, missing and corrupt newer candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-resume-last-integrity-'))
    tempDirs.push(root)
    await writeFile(
      join(root, '.polo-lifecycle-fixture.json'),
      JSON.stringify({ mode: 'disconnect' }),
    )
    const canonicalRoot = await realpath(root)
    const previousConfigDir = process.env.POLO_AI_CONFIG_DIR
    process.env.POLO_AI_CONFIG_DIR = root

    const writeValidSession = async (
      record: Awaited<ReturnType<typeof createCliThread>>,
      sessionId: string,
    ) => {
      const sessionDirectory = join(record.sessionsRoot, sessionId)
      await mkdir(sessionDirectory, { recursive: true })
      await writeFile(join(sessionDirectory, 'session.jsonl'), `${JSON.stringify({
        id: sessionId,
        workspaceRootPath: root,
        createdAt: 1,
        lastUsedAt: 2,
        lastMessageAt: 3,
        messageCount: 1,
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
      })}\n`)
      await updateCliThread(record, { mainSessionId: sessionId })
    }
    const createCandidate = async (lastUsedAt: number) => {
      const record = await createCliThread({
        origin: 'cli-exec',
        configurationScopeId: 'global',
        configurationWorkspacePath: canonicalRoot,
        workingDirectory: canonicalRoot,
        persistence: 'persistent',
      })
      await updateCliThread(record, { status: 'completed', lastUsedAt })
      return record
    }

    let runningLease: Awaited<ReturnType<typeof acquireCliThreadLease>> | undefined
    try {
      const now = Date.now()
      const valid = await createCandidate(now - 6_000)
      await writeValidSession(valid, 'valid-session')
      expect(await readCliMainSessionSummary(valid)).toMatchObject({ state: 'ok' })

      await createCandidate(now - 5_000) // missing mainSessionId

      const missingJsonl = await createCandidate(now - 4_000)
      await updateCliThread(missingJsonl, { mainSessionId: 'missing-jsonl' })

      const invalidHeader = await createCandidate(now - 3_000)
      const invalidDirectory = join(invalidHeader.sessionsRoot, 'invalid-header')
      await mkdir(invalidDirectory, { recursive: true })
      await writeFile(join(invalidDirectory, 'session.jsonl'), '{invalid\n')
      await updateCliThread(invalidHeader, { mainSessionId: 'invalid-header' })

      const deleting = await createCandidate(now - 2_000)
      await writeValidSession(deleting, 'deleting-session')
      await writeFile(join(deleting.directory, 'deleting.json'), '{}', { mode: 0o600 })

      const running = await createCandidate(now - 1_000)
      await writeValidSession(running, 'running-session')
      runningLease = await acquireCliThreadLease(running)

      const proc = Bun.spawn([
        'bun',
        'run',
        join(import.meta.dir, '__fixtures__', 'one-shot-with-server.ts'),
        root,
        join(import.meta.dir, '__fixtures__', 'lifecycle-failure-server.ts'),
        'exec',
        'resume',
        '--last',
        '--json',
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
      processes.push(proc)
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout!).text(),
        new Response(proc.stderr!).text(),
      ])

      expect(exitCode, stderr).toBe(1)
      expect(stdout.trim(), stderr).not.toBe('')
      const events = stdout.trim().split('\n').map(line => JSON.parse(line))
      const started = events.find(event => event.type === 'thread.started')
      expect(started?.thread_id).toBe(valid.metadata.threadId)
      expect(stdout).not.toContain(missingJsonl.metadata.threadId)
      expect(stdout).not.toContain(invalidHeader.metadata.threadId)
      expect(stdout).not.toContain(deleting.metadata.threadId)
      expect(stdout).not.toContain(running.metadata.threadId)
    } finally {
      await runningLease?.release().catch(() => {})
      if (previousConfigDir === undefined) delete process.env.POLO_AI_CONFIG_DIR
      else process.env.POLO_AI_CONFIG_DIR = previousConfigDir
    }
  }, 30_000)

  it('handles a non-standard catchable signal with interrupted cleanup', async () => {
    if (process.platform === 'win32' || !osConstants.signals.SIGQUIT) return

    const runCase = async (ephemeral: boolean) => {
      const root = await mkdtemp(join(tmpdir(), 'polo-sigquit-'))
      tempDirs.push(root)
      const runtimeInfo = join(root, 'runtime-info.json')
      await writeFile(
        join(root, '.polo-lifecycle-fixture.json'),
        JSON.stringify({ mode: 'hang', runtimeInfoFile: runtimeInfo }),
      )
      const command = [
        'bun',
        'run',
        join(import.meta.dir, '__fixtures__', 'one-shot-with-server.ts'),
        root,
        join(import.meta.dir, '__fixtures__', 'lifecycle-failure-server.ts'),
        'exec',
        '--json',
        ...(ephemeral ? ['--ephemeral'] : []),
        'hello',
      ]
      const proc = Bun.spawn(command, {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          POLO_AI_CONFIG_DIR: root,
        },
      })
      processes.push(proc)
      const deadline = Date.now() + 10_000
      while (!(await Bun.file(runtimeInfo).exists())) {
        if (Date.now() >= deadline) throw new Error('runtime did not become ready')
        await Bun.sleep(20)
      }
      await Bun.sleep(250)
      proc.kill('SIGQUIT')
      const exitCode = await Promise.race([
        proc.exited,
        Bun.sleep(12_000).then(() => {
          proc.kill('SIGKILL')
          throw new Error('SIGQUIT process did not terminate')
        }),
      ])
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout!).text(),
        new Response(proc.stderr!).text(),
      ])
      const runtime = JSON.parse(await readFile(runtimeInfo, 'utf-8')) as {
        pid: number
        processIdentity: string
      }
      const runtimeDeadline = Date.now() + 5_000
      while (
        Date.now() < runtimeDeadline
        && processIdentityMatches(runtime.pid, runtime.processIdentity)
      ) {
        await Bun.sleep(25)
      }
      expect(processIdentityMatches(runtime.pid, runtime.processIdentity)).toBe(false)
      expect(exitCode, stderr).toBe(128 + osConstants.signals.SIGQUIT)
      expect(stdout).toContain('"signal":"SIGQUIT"')
      return { root, stdout }
    }

    const persistent = await runCase(false)
    const persistentRoot = join(
      persistent.root,
      'cli-sessions',
      'global',
      'executions',
    )
    const persistentIds = await readdir(persistentRoot)
    expect(persistentIds).toHaveLength(1)
    const metadata = JSON.parse(await readFile(
      join(persistentRoot, persistentIds[0]!, 'thread.json'),
      'utf-8',
    ))
    expect(metadata.status).toBe('interrupted')
    expect(await Bun.file(
      join(persistentRoot, persistentIds[0]!, 'owner.json'),
    ).exists()).toBe(false)

    const ephemeral = await runCase(true)
    const ephemeralRoot = join(
      ephemeral.root,
      'cli-sessions',
      'global',
      'executions',
    )
    expect(await readdir(ephemeralRoot).catch(() => [])).toEqual([])
  }, 40_000)

  it('keeps resume workspace and cwd overrides invocation-scoped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-resume-location-'))
    tempDirs.push(root)
    const oldWorkspace = join(root, 'workspace-old')
    const newWorkspace = join(root, 'workspace-new')
    const oldCwd = join(root, 'cwd-old')
    const newCwd = join(root, 'cwd-new')
    await Promise.all(
      [oldWorkspace, newWorkspace, oldCwd, newCwd].map(path =>
        mkdir(path, { recursive: true }),
      ),
    )
    const canonicalOldWorkspace = await realpath(oldWorkspace)
    const canonicalNewWorkspace = await realpath(newWorkspace)
    const canonicalOldCwd = await realpath(oldCwd)
    const workspaces = [
      {
        id: 'workspace-old',
        name: 'Workspace Old',
        slug: 'workspace-old',
        rootPath: canonicalOldWorkspace,
        createdAt: 1,
      },
      {
        id: 'workspace-new',
        name: 'Workspace New',
        slug: 'workspace-new',
        rootPath: canonicalNewWorkspace,
        createdAt: 2,
      },
    ]
    await writeFile(join(root, 'config.json'), JSON.stringify({
      workspaces,
      activeWorkspaceId: 'workspace-old',
      activeSessionId: null,
      llmConnections: [],
    }))
    await writeFile(
      join(root, '.polo-lifecycle-fixture.json'),
      JSON.stringify({ mode: 'disconnect' }),
    )

    const previousConfigDir = process.env.POLO_AI_CONFIG_DIR
    process.env.POLO_AI_CONFIG_DIR = root
    let record: Awaited<ReturnType<typeof createCliThread>>
    try {
      record = await createCliThread({
        origin: 'cli-exec',
        configurationScopeId: 'workspace-old',
        configurationWorkspaceId: 'workspace-old',
        configurationWorkspacePath: canonicalOldWorkspace,
        workingDirectory: canonicalOldCwd,
        persistence: 'persistent',
      })
      await updateCliThread(record, { mainSessionId: 'fixture-session' })
      await mkdir(join(record.sessionsRoot, 'fixture-session'), { recursive: true })
      await writeFile(
        join(record.sessionsRoot, 'fixture-session', 'session.jsonl'),
        `${JSON.stringify({
          id: 'fixture-session',
          workspaceRootPath: canonicalOldWorkspace,
          createdAt: 1,
          lastUsedAt: 2,
          lastMessageAt: 3,
          messageCount: 1,
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            contextTokens: 0,
            costUsd: 0,
          },
        })}\n`,
      )
    } finally {
      if (previousConfigDir === undefined) delete process.env.POLO_AI_CONFIG_DIR
      else process.env.POLO_AI_CONFIG_DIR = previousConfigDir
    }

    const runCli = async (args: string[], serverEntry?: string) => {
      const proc = Bun.spawn([
        'bun',
        'run',
        serverEntry
          ? join(import.meta.dir, '__fixtures__', 'one-shot-with-server.ts')
          : join(import.meta.dir, 'index.ts'),
        ...(serverEntry ? [root, serverEntry] : []),
        ...args,
      ], {
        cwd: oldCwd,
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
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      return { exitCode, stdout, stderr }
    }

    const beforeResume = await runCli([
      'exec',
      'sessions',
      '--workspace',
      'workspace-old',
      '-C',
      oldCwd,
      '--json',
    ])
    expect(beforeResume.exitCode, beforeResume.stderr).toBe(0)
    expect(beforeResume.stdout).toContain(record.metadata.threadId)

    const resumed = await runCli([
      'exec',
      'resume',
      record.metadata.threadId,
      '--workspace',
      'workspace-new',
      '-C',
      newCwd,
      '--',
      'continue',
    ], join(import.meta.dir, '__fixtures__', 'lifecycle-failure-server.ts'))
    expect(resumed.exitCode, resumed.stderr).toBe(1)

    const metadata = JSON.parse(
      await readFile(join(record.directory, 'thread.json'), 'utf-8'),
    )
    expect(metadata).toMatchObject({
      configurationScopeId: 'workspace-old',
      configurationWorkspaceId: 'workspace-old',
      configurationWorkspacePath: canonicalOldWorkspace,
      workingDirectory: canonicalOldCwd,
      status: 'failed',
    })

    const oldSessions = await runCli([
      'exec',
      'sessions',
      '--workspace',
      'workspace-old',
      '-C',
      oldCwd,
      '--json',
    ])
    expect(oldSessions.exitCode, oldSessions.stderr).toBe(0)
    expect(oldSessions.stdout).toContain(record.metadata.threadId)

    const newSessions = await runCli([
      'exec',
      'sessions',
      '--workspace',
      'workspace-new',
      '-C',
      newCwd,
      '--json',
    ])
    expect(newSessions.exitCode, newSessions.stderr).toBe(0)
    expect(newSessions.stdout).toBe('')

    const lastOld = await runCli([
      'exec',
      'resume',
      '--last',
      '--workspace',
      'workspace-old',
      '-C',
      oldCwd,
      '--',
      'continue',
    ], join(root, 'missing-server.ts'))
    expect(lastOld.exitCode).toBe(1)
    expect(lastOld.stderr).toContain('Server process exited before printing')
    expect(lastOld.stderr).not.toContain('no resumable CLI exec Thread')

    const lastNew = await runCli([
      'exec',
      'resume',
      '--last',
      '--workspace',
      'workspace-new',
      '-C',
      newCwd,
      '--',
      'continue',
    ])
    expect(lastNew.exitCode).toBe(1)
    expect(lastNew.stderr).toContain('no resumable CLI exec Thread')
  }, 40_000)
})
