import { test, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

test('standalone pre-chat bootstrap errors cannot race complete into success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-failure-'))
  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({ workspaces: [], defaultLlmConnection: 'invalid', llmConnections: [{ slug: 'invalid', name: 'Invalid', providerType: 'anthropic', defaultModel: 'claude-opus-4-7', authType: 'api_key', createdAt: 1 }] }))
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'exec', '--json', '-C', root, 'hello'], { env: { ...process.env, HOME: root, POLO_AI_CONFIG_DIR: root, LLM_API_KEY: 'controlled-key' }, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code).not.toBe(0)
    expect(stdout).not.toContain('"turn.completed"')
    expect(stdout + stderr).toContain('error')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
