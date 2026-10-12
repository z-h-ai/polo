import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setInvocationLlmConnections, clearInvocationLlmConnections } from '@polo-ai/shared/config'
import { setInvocationCredential, clearInvocationCredentials } from '@polo-ai/shared/credentials'

const root = mkdtempSync(join(tmpdir(), 'polo-electron-app-worker-'))
mock.module('electron', () => ({ app: { isPackaged: true, getAppPath: () => root } }))
const { createElectronAppLlmExecutor } = await import('../host-executor')

afterEach(() => {
  clearInvocationLlmConnections()
  clearInvocationCredentials()
  rmSync(root, { recursive: true, force: true })
})

describe('production Electron App Host runtime wiring', () => {
  it('resolves and launches the shipped worker without a caller-supplied serverPath', async () => {
    const dir = join(root, 'resources', 'pi-agent-server')
    mkdirSync(dir, { recursive: true })
    // Protocol worker fixture only: no provider/network or credential response.
    writeFileSync(join(dir, 'index.js'), `process.stdin.once('data', data => {
      const request = JSON.parse(data.toString().split('\\n')[0]);
      process.stdout.write(JSON.stringify({type:'host_completion_result',version:1,
        requestId:request.requestId,model:request.model,status:'completed',text:'shipped worker reached',
        usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:2,
          reportedModel:request.model,terminalReason:'stop',provenance:'provider_final'}})+'\\n');
    });`)
    setInvocationLlmConnections([{
      slug: 'space-worker', name: 'Scoped', providerType: 'anthropic', authType: 'api_key',
      models: ['claude-sonnet-4-6'], defaultModel: 'claude-sonnet-4-6', createdAt: 1,
    }])
    setInvocationCredential({ type: 'llm_api_key', connectionSlug: 'space-worker' }, { value: 'test-only-key' })
    const executor = createElectronAppLlmExecutor({ connectionSlug: 'space-worker', nodeRuntimePath: process.execPath })
    try {
      const result = await executor.execute({ prompt: 'hello', maxOutputTokens: 16, timeoutMs: 2000 })
      expect(result).toMatchObject({ status: 'completed', text: 'shipped worker reached' })
    } finally { await executor.dispose() }
  })
})
