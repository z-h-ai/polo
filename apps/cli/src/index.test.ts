import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { printHelp } from './index.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

describe('top-level CLI help', () => {
  it('uses polo as the primary command and mentions polo-ai only as an alias', () => {
    let output = ''
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      printHelp()
    } finally {
      process.stdout.write = originalWrite
    }

    expect(output).toStartWith('polo — Terminal client for Polo AI')
    expect(output).toContain('Usage: polo [options]')
    expect(output).toContain('Compatibility: polo-ai is retained as an alias for polo.')
    expect(output.match(/polo-ai/g)).toHaveLength(1)
    expect(output).not.toContain('polo-ai run')
    expect(output).toContain('exec resume <id>')
    expect(output).toContain('exec sessions')
    expect(output).toContain('exec delete <id>')
    expect(output).toContain('independent CLI runtime')
    expect(output).toContain('does not register a workspace')
    expect(output).not.toContain('Use directory as workspace (creates if needed)')
  })

  it('never routes run with legacy server options to the old full server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-run-routing-'))
    tempDirs.push(root)
    for (const args of [
      ['--url', 'ws://electron.invalid', 'run', 'hello'],
      ['--token', 'server-secret', 'run', 'hello'],
      ['--tls-ca', join(root, 'ca.pem'), 'run', 'hello'],
      ['run', '--url', 'ws://electron.invalid', 'hello'],
      ['run', '--token', 'server-secret', 'hello'],
      ['run', '--tls-ca', join(root, 'ca.pem'), 'hello'],
    ]) {
      const proc = Bun.spawn([
        'bun',
        'run',
        join(import.meta.dir, 'index.ts'),
        ...args,
      ], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, POLO_AI_CONFIG_DIR: root },
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(exitCode).toBe(2)
      expect(stdout).toBe('')
      expect(stderr).toMatch(/unsupported option for run: --(?:url|token|tls-ca)/)
      expect(await Bun.file(join(root, 'sessions')).exists()).toBe(false)
    }
  }, 20_000)

  it('returns exit 2 when management subcommands receive execution-only options', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-management-options-'))
    tempDirs.push(root)
    const id = '123e4567-e89b-12d3-a456-426614174000'
    for (const args of [
      ['exec', 'sessions', '--last'],
      ['exec', 'sessions', '--yolo'],
      ['exec', 'sessions', '--model', 'gpt-5'],
      ['exec', 'sessions', '--api-key', 'secret-value'],
      ['exec', 'delete', id, '--provider', 'openai'],
      ['exec', 'delete', id, '--base-url', 'https://example.test'],
    ]) {
      const proc = Bun.spawn([
        'bun',
        'run',
        join(import.meta.dir, 'index.ts'),
        ...args,
      ], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, POLO_AI_CONFIG_DIR: root },
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(exitCode).toBe(2)
      expect(stdout).toBe('')
      expect(stderr).toContain('unsupported option for exec')
      expect(stderr).not.toContain('secret-value')
    }
  }, 20_000)

  it('repairs a SIGKILL-abandoned persistent exec Thread when sessions lists it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-sessions-repair-'))
    tempDirs.push(root)
    const threadId = crypto.randomUUID()
    const threadRoot = join(root, 'cli-sessions', 'global', 'executions', threadId)
    const workingDirectory = await realpath(root)
    const staleAt = Date.now() - 60_000
    await mkdir(join(threadRoot, 'sessions'), { recursive: true })
    await writeFile(join(threadRoot, 'thread.json'), JSON.stringify({
      version: 1,
      threadId,
      origin: 'cli-exec',
      configurationScopeId: 'global',
      configurationWorkspacePath: root,
      workingDirectory,
      createdAt: staleAt,
      lastUsedAt: staleAt,
      persistence: 'persistent',
    }))
    await writeFile(join(threadRoot, 'owner.json'), JSON.stringify({
      leaseId: crypto.randomUUID(),
      cliPid: 999_999_991,
      cliStartedAt: staleAt,
      cliProcessIdentity: 'dead-cli',
      serverPid: 999_999_992,
      serverStartedAt: staleAt,
      serverProcessIdentity: 'dead-runtime',
      heartbeatAt: staleAt,
    }))

    const proc = Bun.spawn([
      'bun',
      'run',
      join(import.meta.dir, 'index.ts'),
      'exec',
      'sessions',
      '-C',
      root,
    ], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, POLO_AI_CONFIG_DIR: root },
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(exitCode, stderr).toBe(0)
    expect(stdout).toContain(`${threadId}\tinterrupted\t`)
    expect(JSON.parse(await readFile(join(threadRoot, 'thread.json'), 'utf-8')))
      .toMatchObject({ status: 'interrupted', lastUsedAt: staleAt })
  }, 20_000)
})
