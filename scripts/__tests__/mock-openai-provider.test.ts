import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
const processes: Array<ReturnType<typeof Bun.spawn>> = []
const fixture = join(
  import.meta.dir,
  '..',
  '..',
  'apps',
  'electron',
  'scripts',
  'fixtures',
  'mock-openai-provider.ts',
)

afterEach(async () => {
  for (const process of processes.splice(0)) {
    if (process.exitCode === null) process.kill('SIGTERM')
    await process.exited
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('artifact E2E mock provider', () => {
  it('rejects production-like invocation without the fixture gate', async () => {
    const child = Bun.spawn([process.execPath, 'run', fixture], {
      env: {},
      stdout: 'ignore',
      stderr: 'ignore',
    })
    expect(await child.exited).not.toBe(0)
  })

  it('serves a deterministic loopback OpenAI stream and records the prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'polo mock provider 空格 '))
    roots.push(root)
    const state = join(root, 'state.json')
    const log = join(root, 'requests.jsonl')
    const token = 'polo-artifact-e2e-token-for-test'
    const child = Bun.spawn([process.execPath, 'run', fixture], {
      env: {
        POLO_AI_ARTIFACT_E2E_FIXTURE: '1',
        POLO_AI_ARTIFACT_E2E_ROOT: root,
        POLO_AI_E2E_MOCK_STATE: state,
        POLO_AI_E2E_MOCK_LOG: log,
        POLO_AI_E2E_MOCK_TOKEN: token,
      },
      stdout: 'ignore',
      stderr: 'pipe',
    })
    processes.push(child)

    const deadline = Date.now() + 5_000
    while (!existsSync(state) && child.exitCode === null && Date.now() < deadline) {
      await Bun.sleep(20)
    }
    expect(existsSync(state)).toBe(true)
    const record = JSON.parse(readFileSync(state, 'utf8')) as { baseUrl: string; host: string }
    expect(record.host).toBe('127.0.0.1')
    const response = await fetch(`${record.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('artifact run completed')
    expect(body).toContain('data: [DONE]')
    expect(readFileSync(log, 'utf8')).toContain('"sawHello":true')
  })

  it('rejects a final-component symlink without modifying its outside target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'polo mock provider symlink root '))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'polo mock provider outside '))
    roots.push(root, outsideRoot)
    const outsideState = join(outsideRoot, 'outside-state.json')
    const state = join(root, 'state.json')
    const log = join(root, 'requests.jsonl')
    writeFileSync(outsideState, 'user-owned\n')
    symlinkSync(outsideState, state)

    const child = Bun.spawn([process.execPath, 'run', fixture], {
      env: {
        POLO_AI_ARTIFACT_E2E_FIXTURE: '1',
        POLO_AI_ARTIFACT_E2E_ROOT: root,
        POLO_AI_E2E_MOCK_STATE: state,
        POLO_AI_E2E_MOCK_LOG: log,
        POLO_AI_E2E_MOCK_TOKEN: 'polo-artifact-e2e-token-for-symlink-test',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    })
    processes.push(child)

    expect(await child.exited).not.toBe(0)
    expect(readFileSync(outsideState, 'utf8')).toBe('user-owned\n')
  })
})
