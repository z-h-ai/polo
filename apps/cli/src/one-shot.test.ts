import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliRpcClient } from './client.ts'
import type { CliThreadRecord } from './cli-thread-store.ts'
import { ExecEventAdapter, type InternalSessionEvent } from './exec-event-adapter.ts'
import { parseExecutionArgs } from './execution-parser.ts'
import { createConfigurationSnapshot, waitForTurn } from './one-shot.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('one-shot execution internals', () => {
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
})
