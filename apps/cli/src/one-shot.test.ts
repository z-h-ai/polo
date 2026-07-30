import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliRpcClient } from './client.ts'
import type { CliThreadRecord } from './cli-thread-store.ts'
import {
  createCliThread,
  listCliThreads,
  updateCliThread,
} from './cli-thread-store.ts'
import { ExecEventAdapter, type InternalSessionEvent } from './exec-event-adapter.ts'
import { parseExecutionArgs } from './execution-parser.ts'
import {
  createConfigurationSnapshot,
  normalizeCredentialFreeBaseUrl,
  readCliMainSessionSummary,
  runExecutionCommand,
  waitForTurn,
} from './one-shot.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('one-shot execution internals', () => {
  it('rejects userinfo and sensitive base URL query parameters', () => {
    expect(() => normalizeCredentialFreeBaseUrl(
      'https://user:oauth-secret@example.test/v1',
    )).toThrow('userinfo credentials')
    expect(() => normalizeCredentialFreeBaseUrl(
      'https://example.test/v1?access_token=oauth-secret',
    )).toThrow('sensitive query parameter: access_token')
    expect(normalizeCredentialFreeBaseUrl(
      'https://example.test/v1?api-version=2026-01-01',
    )).toBe('https://example.test/v1?api-version=2026-01-01')
  })

  it('seeds a completely fresh global config snapshot from bundled defaults', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'polo-fresh-config-'))
    tempDirs.push(temp)
    const directory = join(temp, 'thread')
    await mkdir(directory, { recursive: true })
    const record = {
      directory,
      sessionsRoot: join(directory, 'sessions'),
      ownerFile: join(directory, 'owner.json'),
      metadata: {
        version: 1,
        threadId: crypto.randomUUID(),
        origin: 'cli-exec',
        configurationScopeId: 'global',
        configurationWorkspacePath: join(temp, 'never-initialized'),
        workingDirectory: temp,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        persistence: 'persistent',
      },
    } satisfies CliThreadRecord

    const snapshot = await createConfigurationSnapshot(record, {
      id: 'global',
      path: record.metadata.configurationWorkspacePath,
    })

    expect(await Bun.file(join(snapshot, 'config.json')).exists()).toBe(true)
    expect(await Bun.file(join(snapshot, 'config-defaults.json')).exists()).toBe(true)
    expect(JSON.parse(await Bun.file(join(snapshot, 'config-defaults.json')).text())).toHaveProperty('defaults')
  })

  it('keeps provider typed_error terminal even if complete follows', async () => {
    let listener: ((value: unknown) => void) | undefined
    const client = {
      on(_channel: string, callback: (value: unknown) => void) {
        listener = callback
        return () => {
          listener = undefined
        }
      },
      async invoke() {
        listener?.({
          type: 'typed_error',
          sessionId: 'session-1',
          error: { code: 'invalid_credentials', message: 'provider rejected credential' },
        } satisfies InternalSessionEvent)
        listener?.({
          type: 'complete',
          sessionId: 'session-1',
        } satisfies InternalSessionEvent)
      },
      waitForDisconnect() {
        return new Promise<Error>(() => {})
      },
    } as unknown as CliRpcClient
    const args = parseExecutionArgs(['bun', 'index.ts', 'exec', 'hello'])

    const result = await waitForTurn(
      client,
      'session-1',
      'hello',
      args,
      new ExecEventAdapter({ json: false }),
    )

    expect(result.status).toBe('failed')
    expect(result.finalMessage).toBe('')
    expect(result.error?.message).toContain('provider rejected credential')
  })

  it('retains the raw final message for -o while stdout sanitization stays separate', async () => {
    let listener: ((value: unknown) => void) | undefined
    const client = {
      on(_channel: string, callback: (value: unknown) => void) {
        listener = callback
        return () => {
          listener = undefined
        }
      },
      async invoke() {
        listener?.({
          type: 'text_delta',
          sessionId: 'session-1',
          delta: '\u001B[31manswer\u001B[39m',
        } satisfies InternalSessionEvent)
        listener?.({ type: 'complete', sessionId: 'session-1' } satisfies InternalSessionEvent)
      },
      waitForDisconnect() {
        return new Promise<Error>(() => {})
      },
    } as unknown as CliRpcClient
    const args = parseExecutionArgs(['bun', 'index.ts', 'exec', 'hello'])

    const result = await waitForTurn(
      client,
      'session-1',
      'hello',
      args,
      new ExecEventAdapter({ json: false }),
    )

    expect(result.status).toBe('completed')
    expect(result.finalMessage).toBe('\u001B[31manswer\u001B[39m')
  })

  it('strips ANSI from every run text/tool path for all color modes and JSONL', async () => {
    const originalWrite = process.stdout.write
    try {
      for (const color of ['always', 'never', 'auto'] as const) {
        for (const outputFormat of ['text', 'stream-json'] as const) {
          let listener: ((value: unknown) => void) | undefined
          let stdout = ''
          process.stdout.write = ((chunk: string | Uint8Array) => {
            stdout += String(chunk)
            return true
          }) as typeof process.stdout.write
          const client = {
            on(_channel: string, callback: (value: unknown) => void) {
              listener = callback
              return () => {
                listener = undefined
              }
            },
            async invoke() {
              for (const event of [
                {
                  type: 'text_delta',
                  sessionId: 'session-1',
                  delta: '\u001B[31mtext\u001B[39m',
                },
                {
                  type: 'tool_start',
                  sessionId: 'session-1',
                  toolName: '\u001B[31mtool\u001B[39m',
                  toolIntent: '\u001B[33mintent\u001B[39m',
                },
                {
                  type: 'tool_result',
                  sessionId: 'session-1',
                  result: '\u001B[32mresult\u001B[39m',
                },
                {
                  type: 'complete',
                  sessionId: 'session-1',
                },
              ] satisfies InternalSessionEvent[]) {
                listener?.(event)
              }
            },
            waitForDisconnect() {
              return new Promise<Error>(() => {})
            },
          } as unknown as CliRpcClient
          const args = parseExecutionArgs([
            'bun',
            'index.ts',
            'run',
            '--color',
            color,
            ...(outputFormat === 'stream-json'
              ? ['--output-format', 'stream-json']
              : []),
            'hello',
          ])

          const result = await waitForTurn(
            client,
            'session-1',
            'hello',
            args,
            new ExecEventAdapter({ json: false }),
          )

          expect(result.status).toBe('completed')
          expect(stdout).not.toContain('\u001B')
          if (outputFormat === 'text') {
            expect(stdout).toContain('text')
            expect(stdout).toContain('[tool: tool — intent]')
            expect(stdout).toContain('result')
          } else {
            for (const line of stdout.trim().split('\n')) {
              expect(() => JSON.parse(line)).not.toThrow()
            }
          }
        }
      }
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('finishes failed when the client disconnects after sendMessage ACK', async () => {
    const client = {
      on() {
        return () => {}
      },
      async invoke() {
        return undefined
      },
      async waitForDisconnect() {
        return new Error('fixture disconnected after ACK')
      },
    } as unknown as CliRpcClient
    const args = parseExecutionArgs(['bun', 'index.ts', 'exec', 'hello'])

    const result = await waitForTurn(
      client,
      'session-1',
      'hello',
      args,
      new ExecEventAdapter({ json: false }),
    )

    expect(result.status).toBe('failed')
    expect(result.error?.message).toContain('disconnected after ACK')
  })

  it('resolves resume connection in invocation-env, Thread, current-default order', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'polo-resume-connection-'))
    tempDirs.push(temp)
    const proc = Bun.spawn([
      'bun',
      'run',
      join(import.meta.dir, '__fixtures__', 'connection-resolution.ts'),
      temp,
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(exitCode, stderr).toBe(0)
    expect(stdout).toBe('ok\n')
  }, 15_000)

  it('rejects base URL secrets before args or resolved connections reach metadata', async () => {
    for (const mode of ['args', 'resolved']) {
      const temp = await mkdtemp(join(tmpdir(), `polo-base-url-${mode}-`))
      tempDirs.push(temp)
      const proc = Bun.spawn([
        'bun',
        'run',
        join(import.meta.dir, '__fixtures__', 'base-url-secret.ts'),
        temp,
        mode,
      ], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env },
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(0)
      expect(stdout).toBe('ok\n')
      expect(stderr).not.toContain('oauth-real-token-123456')
      expect(stderr).not.toContain('sk-query-secret-123456')
    }
  }, 20_000)

  it('validates resume --ephemeral before cloning the original Thread', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'polo-resume-ephemeral-validation-'))
    tempDirs.push(temp)
    const previousConfigDir = process.env.POLO_AI_CONFIG_DIR
    process.env.POLO_AI_CONFIG_DIR = temp
    try {
      const original = await createCliThread({
        origin: 'cli-exec',
        configurationScopeId: 'global',
        configurationWorkspacePath: join(temp, 'missing-scope'),
        workingDirectory: temp,
        persistence: 'persistent',
      })
      const args = parseExecutionArgs([
        'bun',
        'index.ts',
        'exec',
        'resume',
        original.metadata.threadId,
        '--ephemeral',
        '--',
        'continue',
      ])

      expect(await runExecutionCommand(args)).toBe(1)
      const records = await listCliThreads()
      expect(records.map(record => record.metadata.threadId)).toEqual([original.metadata.threadId])
    } finally {
      if (previousConfigDir === undefined) delete process.env.POLO_AI_CONFIG_DIR
      else process.env.POLO_AI_CONFIG_DIR = previousConfigDir
    }
  })

  it('reports main-session summaries and explicit missing/corrupt degradation', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'polo-main-session-summary-'))
    tempDirs.push(temp)
    const previousConfigDir = process.env.POLO_AI_CONFIG_DIR
    process.env.POLO_AI_CONFIG_DIR = temp
    try {
      const record = await createCliThread({
        origin: 'cli-exec',
        configurationScopeId: 'global',
        configurationWorkspacePath: temp,
        workingDirectory: temp,
        persistence: 'persistent',
      })
      expect(await readCliMainSessionSummary(record)).toEqual({
        state: 'missing',
        reason: 'thread metadata has no mainSessionId',
      })

      await updateCliThread(record, { mainSessionId: 'session-1' })
      expect(await readCliMainSessionSummary(record)).toMatchObject({
        state: 'missing',
        sessionId: 'session-1',
      })

      const sessionDirectory = join(record.sessionsRoot, 'session-1')
      await mkdir(sessionDirectory)
      await writeFile(join(sessionDirectory, 'session.jsonl'), '{invalid\n')
      expect(await readCliMainSessionSummary(record)).toMatchObject({
        state: 'corrupt',
        sessionId: 'session-1',
      })

      await writeFile(join(sessionDirectory, 'session.jsonl'), `${JSON.stringify({
        id: 'session-1',
        workspaceRootPath: temp,
        createdAt: 1,
        lastUsedAt: 2,
        lastMessageAt: 3,
        messageCount: 4,
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
        name: 'Main session',
        preview: 'hello',
        model: 'gpt-5',
      })}\n`)
      expect(await readCliMainSessionSummary(record)).toMatchObject({
        state: 'ok',
        sessionId: 'session-1',
        name: 'Main session',
        messageCount: 4,
        lastMessageAt: 3,
        preview: 'hello',
        model: 'gpt-5',
      })
    } finally {
      if (previousConfigDir === undefined) delete process.env.POLO_AI_CONFIG_DIR
      else process.env.POLO_AI_CONFIG_DIR = previousConfigDir
    }
  })
})
