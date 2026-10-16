import {test, expect} from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
test('an empty real provider stream fails without retry or fake success', async () => {
const root = await mkdtemp(join(tmpdir(), 'polo-review-empty-'))
let calls = 0
const provider = Bun.serve({port: 0, async fetch(request) {
  await request.json(); calls++
  const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({id: 'empty', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{index: 0, delta, finish_reason: finish}]})}\n\n`
  return new Response(chunk({role: 'assistant', content: ''}, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}})
}})
try {
  await writeFile(join(root, 'config.json'), JSON.stringify({workspaces: [], defaultLlmConnection: 'owned', llmConnections: [{slug: 'owned', name: 'Owned', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', baseUrl: `http://127.0.0.1:${provider.port}/v1`, customEndpoint: {api: 'openai-completions'}, models: ['test-model'], defaultModel: 'test-model', createdAt: 1}]}))
  const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'exec', '--json', '-C', root, 'Reply HELLO.'], {env: {...process.env, HOME: root, POLO_AI_CONFIG_DIR: root, LLM_API_KEY: 'controlled-not-secret'}, stdout: 'pipe', stderr: 'pipe'})
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  expect(code).not.toBe(0)
  expect(calls).toBe(1)
  expect(stdout).not.toContain('turn.completed')
  expect(stdout + stderr).toContain('CLI_EMPTY_RESULT')
} finally {provider.stop(true); await rm(root, {recursive: true, force: true})}

}, 45000)
