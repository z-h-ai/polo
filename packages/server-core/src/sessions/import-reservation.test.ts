import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RootedSessionStorage,
  type SessionBundle,
} from '@polo-ai/shared/sessions'
import { SessionManager } from './SessionManager.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function runConcurrentImports(mode: 'fork' | 'move') {
  const root = await mkdtemp(join(tmpdir(), `polo-${mode}-reservation-`))
  tempDirs.push(root)
  await mkdir(join(root, 'configuration-workspace'), { recursive: true })
  const fixture = join(
    import.meta.dir,
    '__tests__',
    'fixtures',
    'concurrent-import-worker.ts',
  )
  const spawn = (workerId: string) =>
    Bun.spawn(['bun', 'run', fixture, root, mode, workerId], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        POLO_AI_CONFIG_DIR: join(root, 'config'),
      },
    })
  const workers = [spawn('one'), spawn('two')]
  return {
    root,
    results: await Promise.all(
      workers.map(async (worker) => ({
        exitCode: await worker.exited,
        stdout: await new Response(worker.stdout).text(),
        stderr: await new Response(worker.stderr).text(),
      })),
    ),
  }
}

describe('SessionManager import reservations', () => {
  it('retries a colliding fork ID across independent processes', async () => {
    const { root, results } = await runConcurrentImports('fork')
    expect(results.map((result) => result.exitCode)).toEqual([0, 0])
    const firstCandidates = await Promise.all(
      ['one', 'two'].map((worker) =>
        readFile(join(root, 'barrier', `${worker}.ready`), 'utf-8'),
      ),
    )
    expect(firstCandidates[0]).toBe(firstCandidates[1])
    expect(await readdir(join(root, 'sessions'))).toHaveLength(2)
  }, 20_000)

  it('allows only one concurrent move import to reserve the public ID', async () => {
    const { root, results } = await runConcurrentImports('move')
    expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1)
    expect(results.filter((result) => result.exitCode !== 0)).toHaveLength(1)
    expect(results.map((result) => result.stderr).join('\n')).toContain(
      'already exists in target workspace',
    )
    expect(await readdir(join(root, 'sessions'))).toEqual(['shared-move-id'])
  }, 20_000)

  it('removes its atomic reservation when bundle restoration fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-import-rollback-'))
    tempDirs.push(root)
    const workspace = {
      id: 'workspace-1',
      name: 'Workspace 1',
      slug: 'workspace-1',
      rootPath: join(root, 'configuration-workspace'),
      createdAt: 1,
    }
    await mkdir(workspace.rootPath, { recursive: true })
    const storage = new RootedSessionStorage(join(root, 'sessions'), {
      controlledRoot: root,
    })
    const manager = new SessionManager({
      profile: 'cli-one-shot',
      workspace,
      sessionStorage: storage,
    })
    const bundle: SessionBundle = {
      version: 1,
      session: {
        header: {
          id: 'source-id',
          workspaceRootPath: workspace.rootPath,
          createdAt: 1,
          lastUsedAt: 1,
          messageCount: 0,
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            contextTokens: 0,
            costUsd: 0,
          },
        },
        messages: [],
      },
      files: [{
        relativePath: '../escape',
        contentBase64: '',
        size: 0,
      }],
    }

    try {
      await expect(
        manager.importSession(workspace.id, bundle, 'fork'),
      ).rejects.toThrow('Invalid bundle file')
      expect(await readdir(join(root, 'sessions'))).toEqual([])
    } finally {
      manager.cleanup()
    }
  })
})
