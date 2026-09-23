import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireHostTestSerialLock, releaseHostTestSerialLock, waitOutEarlySuiteWindow } from './host-test-serial.ts'

await waitOutEarlySuiteWindow()

const SRC_DIR = join(import.meta.dir, '..')
const PACKAGE_ROOT = join(SRC_DIR, '..')
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..')
const ENTRY = join(SRC_DIR, 'index.ts')
const HOST_FLAG = '--host-completion-v1'

const POISON_MODULE_IDS = [
  '@mariozechner/pi-coding-agent',
  join(SRC_DIR, 'session-server.ts'),
  join(SRC_DIR, 'model-resolution.ts'),
  join(SRC_DIR, 'pick-mini-model.ts'),
  join(SRC_DIR, 'proxy-tool-registry.ts'),
  join(SRC_DIR, 'polo-ai-metadata-schema.ts'),
  join(SRC_DIR, 'system-prompt-override.ts'),
  join(SRC_DIR, 'tools', 'web-fetch.ts'),
  join(SRC_DIR, 'tools', 'search', 'resolve-provider.ts'),
  join(SRC_DIR, 'tools', 'search', 'create-search-tool.ts'),
  join(REPO_ROOT, 'packages', 'shared', 'src', 'utils', 'large-response.ts'),
  join(REPO_ROOT, 'packages', 'shared', 'src', 'agent', 'llm-tool.ts'),
  join(REPO_ROOT, 'packages', 'shared', 'src', 'agent', 'backend', 'pi', 'constants.ts'),
  join(REPO_ROOT, 'packages', 'shared', 'src', 'config', 'models.ts'),
]

function poisonPreload(ids: string[]): string {
  return `
const ids = ${JSON.stringify(ids)}
for (const id of ids) {
  Bun.plugin({
    name: 'poison:' + id,
    setup(build) {
      build.module(id, () => ({ contents: "throw new Error('POISON-MODULE-LOADED: " + id + "')", loader: 'js' }))
    },
  })
}
`
}

const POISON_PRELOAD = poisonPreload(POISON_MODULE_IDS)

function runSource(args: string[], stdinData: string | null, timeoutMs = 90000, preload = POISON_PRELOAD): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const preloadPath = join(import.meta.dir, `host-bootstrap-poison-${Math.random().toString(36).slice(2)}.mts`)
    const usesPreload = args.includes('POISON_PRELOAD')
    const argv = [process.execPath.split('/').pop() ?? 'bun']
    const cmd = usesPreload ? [process.execPath, '--preload', preloadPath, ...args.filter((arg) => arg !== 'POISON_PRELOAD')] : [process.execPath, ...args]
    void argv
    const { writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs')
    if (usesPreload) writeFileSync(preloadPath, preload)
    const child = spawn('/usr/bin/nice', ['-n', '20', cmd[0], ...cmd.slice(1)], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    if (stdinData === null) child.stdin.end()
    else child.stdin.end(stdinData)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (usesPreload) rmSync(preloadPath, { force: true })
      resolve({ code, stdout, stderr })
    })
  })
}

const ZERO_TRANSPORT_REQUEST = JSON.stringify({
  type: 'host_completion', version: 1, parentValidation: 'sessionless-host-llm-executor.v1', requestId: 'req-boot',
  route: { kind: 'catalog', provider: 'anthropic', transportBaseUrl: 'https://api.anthropic.com/' },
  model: 'pi/definitely-not-a-catalog-model-xyz', prompt: 'hello', maxOutputTokens: 16, timeoutMs: 5000,
  credential: { type: 'api_key', value: 'sk-test' },
}) + '\n'

describe('host bootstrap module isolation', () => {
  beforeAll(async () => { await acquireHostTestSerialLock() })
  afterAll(() => releaseHostTestSerialLock())

  it('runs the host path with zero session/tool module loads (poison pills never fire)', async () => {
    const outcome = await runSource(['POISON_PRELOAD', ENTRY, HOST_FLAG], ZERO_TRANSPORT_REQUEST)
    expect(outcome.code).toBe(0)
    expect(outcome.stderr).not.toContain('POISON-MODULE-LOADED')
    const lines = outcome.stdout.split('\n').filter((line) => line.trim().length > 0)
    expect(lines).toHaveLength(1)
    const result = JSON.parse(lines[0]) as { type: string; requestId: string; status: string; error: { code: string; reason: string; message: string } }
    expect(result.type).toBe('host_completion_result')
    expect(result.status).toBe('failed')
    expect(result.error.code).toBe('provider_protocol_error')
    expect(result.error.reason).toBe('catalog_model_missing')
    expect(result.error.message).toBe('Model is not available in the sealed provider catalog')
  }, 120000)

  it('emits one fixed invalid result and exits 0 when the host worker module itself fails to import', async () => {
    const outcome = await runSource(['POISON_PRELOAD', ENTRY, HOST_FLAG], ZERO_TRANSPORT_REQUEST, 90000, poisonPreload([join(SRC_DIR, 'host-completion.ts')]))
    expect(outcome.code).toBe(0)
    expect(outcome.stderr).not.toContain('POISON-MODULE-LOADED')
    const lines = outcome.stdout.split('\n').filter((line) => line.trim().length > 0)
    expect(lines).toHaveLength(1)
    const result = JSON.parse(lines[0]) as { requestId: string; model: string; error: { code: string; reason: string; message: string } }
    expect(result.requestId).toBe('invalid')
    expect(result.model).toBe('invalid')
    expect(result.error).toEqual({ code: 'provider_protocol_error', reason: 'invalid_worker_message', message: 'Host LLM worker protocol failed' })
  }, 120000)
  it('keeps bootstrap output authority limited to the import: a Host rejection after its own JSONL adds no second line', async () => {
    // Run the REAL index.ts beside a fake host-completion.ts so the import genuinely resolves;
    // the fake emits one JSONL line and then rejects. Ownership transfer means the bootstrap
    // catch never wraps runHostCompletion, so stdout ends with exactly the Host line.
    const runDir = mkdtempSync(join(tmpdir(), 'host-reject-run-'))
    const { copyFileSync, writeFileSync } = await import('node:fs')
    copyFileSync(join(SRC_DIR, 'index.ts'), join(runDir, 'index.ts'))
    writeFileSync(join(runDir, 'host-completion.ts'), [
      'export async function runHostCompletion(): Promise<void> {',
      "  const line = JSON.stringify({ type: 'host_completion_result', version: 1, requestId: 'req-host-line', model: 'm', status: 'failed', error: { code: 'provider_failed', reason: 'provider_error_terminal', message: 'LLM provider request failed' } }) + String.fromCharCode(10)",
      '  process.stdout.write(line)',
      "  throw new Error('host rejection after output')",
      '}',
    ].join('\n'))
    const child = Bun.spawn([process.execPath, join(runDir, 'index.ts'), '--host-completion-v1'], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    const stdout = await new Response(child.stdout as ReadableStream).text()
    const exitCode = await child.exited
    const lines = stdout.split('\n').filter((line) => line.trim().length > 0)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]) as { type: string }
    expect(parsed.type).toBe('host_completion_result')
    expect(exitCode).not.toBe(0)
    rmSync(runDir, { recursive: true, force: true })
  })

  it('proves the poison pills fire when the ordinary session path loads them (control)', async () => {
    const outcome = await runSource(['POISON_PRELOAD', ENTRY], null)
    const pillsFired = POISON_MODULE_IDS.some((id) => outcome.stderr.includes(id.split('/').pop() ?? id))
    expect(pillsFired).toBe(true)
    expect(outcome.stdout).not.toContain('host_completion_result')
  }, 120000)

  it('keeps the ordinary session JSONL protocol intact without the host flag', async () => {
    const outcome = await runSource([ENTRY], JSON.stringify({ type: 'init', sessionId: 'host-bootstrap-smoke', cwd: '/tmp' }) + '\n', 60000)
    expect(outcome.stderr).not.toContain('POISON-MODULE-LOADED')
    const lines = outcome.stdout.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as { type: string })
    expect(lines[0]?.type).toBe('ready')
  }, 90000)
})
