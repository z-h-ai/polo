import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.argv[2]!
process.env.POLO_AI_CONFIG_DIR = root
delete process.env.LLM_API_KEY
delete process.env.OPENAI_API_KEY
await mkdir(root, { recursive: true })
await writeFile(join(root, 'config.json'), JSON.stringify({
  workspaces: [], activeWorkspaceId: null, defaultLlmConnection: 'owned-openai',
  llmConnections: [{
    slug: 'owned-openai', name: 'Owned OpenAI', providerType: 'pi',
    piAuthProvider: 'openai', authType: 'api_key',
    baseUrl: 'https://owned.example/v1', defaultModel: 'test-model', createdAt: 1,
  }],
}))
const { getCredentialManager } = await import('@polo-ai/shared/credentials')
const { createCliThread } = await import('../cli-thread-store')
const { parseExecutionArgs } = await import('../execution-parser')
const { resolveConnection } = await import('../one-shot')
const secret = 'fake-test-credential-owned-route'
await getCredentialManager().setLlmApiKey('owned-openai', secret)
const record = await createCliThread({
  origin: 'cli-exec', configurationScopeId: 'global',
  configurationWorkspacePath: root, workingDirectory: root, persistence: 'ephemeral',
})
const scope = { id: 'global', path: root }
const args = (extra: string[] = []) => parseExecutionArgs(['bun', 'index.ts', 'exec', ...extra, 'hello'])
const current = await resolveConnection(args(), record, scope)
if (current.credential?.value !== secret) throw new Error('default stored credential was not bootstrapped')
record.metadata.connection = {
  slug: 'owned-openai', provider: 'openai', baseUrl: 'https://owned.example/v1',
  model: 'test-model', connectionType: 'pi', authType: 'api_key',
}
const resumed = await resolveConnection(args(), record, scope)
if (resumed.credential?.value !== secret) throw new Error('matching resume identity lost its stored credential')
const overridden = await resolveConnection(args(['--provider', 'openai', '--base-url', 'https://other.example/v1']), record, scope)
if (overridden.credential) throw new Error('unmatched endpoint borrowed a saved identity credential')
record.metadata.connection.baseUrl = 'https://old.example/v1'
const stale = await resolveConnection(args(), record, scope)
if (stale.credential) throw new Error('changed connection route authorized a historical endpoint credential')
process.stdout.write('ok\n')
