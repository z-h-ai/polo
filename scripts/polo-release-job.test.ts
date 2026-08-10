import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { RELEASE_ASSET_NAMES } from './electron-release-draft-identity'
import {
  cancelReleaseJob,
  getReleaseJobStatus,
  releaseJobRequestHash,
  runReleaseJobWorker,
  startReleaseJob,
  type ReleaseJobRequest,
} from './polo-release-job'

function request(variant = 'a'): ReleaseJobRequest {
  return {
    repository: 'z-h-ai/polo',
    tag: 'v1.2.3',
    version: '1.2.3',
    commitSha: 'a'.repeat(40),
    releaseId: 42,
    assetIdentity: JSON.stringify({
      releaseId: 42,
      assets: RELEASE_ASSET_NAMES.map((name, index) => ({
        id: index + 1,
        name,
        size: index + 1,
        sha256: variant.repeat(64),
      })),
    }),
  }
}

describe('detached Zeabur release job controller', () => {
  it('keeps the real detached worker alive after start returns and persists its terminal result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-detached-'))
    const originalToken = process.env.GH_TOKEN
    process.env.GH_TOKEN = ''
    try {
      expect(await startReleaseJob(request(), { releasesDir: root })).toBe('running')
      let status = await getReleaseJobStatus('1.2.3', { releasesDir: root })
      for (let attempt = 0; attempt < 100 && status === 'running'; attempt += 1) {
        await Bun.sleep(20)
        status = await getReleaseJobStatus('1.2.3', { releasesDir: root })
      }
      expect(status).toBe('failed')
      expect(await readFile(join(root, 'electron', '.jobs', '1.2.3', 'worker.log'), 'utf8'))
        .toContain('GH_TOKEN is required')
    } finally {
      if (originalToken === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = originalToken
      await rm(root, { recursive: true, force: true })
    }
  })

  it('starts once, binds retries to the approved Draft, and reports running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-job-'))
    let spawns = 0
    try {
      const options = {
        releasesDir: root,
        processAlive: () => true,
        spawnWorker: (args: string[], logPath: string) => {
          spawns += 1
          expect(args).toContain('--request-hash')
          expect(logPath).toEndWith('/electron/.jobs/1.2.3/worker.log')
          return 4242
        },
      }
      expect(await startReleaseJob(request(), options)).toBe('running')
      expect(await startReleaseJob(request(), options)).toBe('running')
      expect(await getReleaseJobStatus('1.2.3', options)).toBe('running')
      expect(spawns).toBe(1)
      await expect(startReleaseJob(request('b'), options)).rejects.toThrow('different approved Draft')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records worker success for polling without keeping the Service Exec caller open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-worker-'))
    const approved = request()
    try {
      await startReleaseJob(approved, {
        releasesDir: root,
        processAlive: () => true,
        spawnWorker: () => process.pid,
      })
      const running = JSON.parse(await readFile(join(root, 'electron', '.jobs', '1.2.3', 'state.json'), 'utf8'))
      await runReleaseJobWorker(approved, releaseJobRequestHash(approved), running.attemptId, {
        releasesDir: root,
        pull: async () => 'published',
      })
      expect(await getReleaseJobStatus('1.2.3', { releasesDir: root })).toBe('success')
      const state = JSON.parse(await readFile(join(root, 'electron', '.jobs', '1.2.3', 'state.json'), 'utf8'))
      expect(state.status).toBe('success')
      let restarted = false
      expect(await startReleaseJob(approved, {
        releasesDir: root,
        spawnWorker: () => {
          restarted = true
          return 4243
        },
      })).toBe('running')
      expect(restarted).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cancels only its worker and removes only same-version incoming state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-cancel-'))
    const stage = join(root, 'electron', '.incoming', '.1.2.3.download-42-100')
    const unrelated = join(root, 'electron', '.incoming', '.2.0.0.download-7-200')
    let terminated = 0
    try {
      await Promise.all([mkdir(stage, { recursive: true }), mkdir(unrelated, { recursive: true })])
      await Promise.all([writeFile(join(stage, 'partial'), 'partial'), writeFile(join(unrelated, 'partial'), 'keep')])
      await startReleaseJob(request(), {
        releasesDir: root,
        processAlive: () => true,
        spawnWorker: () => 4242,
      })
      expect(await cancelReleaseJob('1.2.3', {
        releasesDir: root,
        processAlive: () => true,
        terminateProcess: async (pid) => { terminated = pid },
      })).toBe('cancelled')
      expect(terminated).toBe(4242)
      expect(await getReleaseJobStatus('1.2.3', { releasesDir: root })).toBe('cancelled')
      await expect(readFile(join(stage, 'partial'))).rejects.toThrow()
      expect(await readFile(join(unrelated, 'partial'), 'utf8')).toBe('keep')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
