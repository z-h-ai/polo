import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const configRoot = process.argv[2]
if (!configRoot) throw new Error('missing config root')
await mkdir(configRoot, { recursive: true })
await writeFile(join(configRoot, 'config.json'), JSON.stringify({
  workspaces: [],
  activeWorkspaceId: null,
  defaultLlmConnection: 'current-default',
  llmConnections: [{
    slug: 'saved-connection',
    name: 'Current edited connection',
    providerType: 'pi_compat',
    authType: 'api_key',
    piAuthProvider: 'anthropic',
    baseUrl: 'https://current-edited.invalid',
    defaultModel: 'current-edited-model',
    createdAt: 1,
  }, {
    slug: 'current-default',
    name: 'Current default',
    providerType: 'anthropic',
    authType: 'api_key',
    piAuthProvider: 'anthropic',
    defaultModel: 'current-default-model',
    createdAt: 1,
  }, {
    slug: 'stored-openai',
    name: 'Stored OpenAI identity',
    providerType: 'pi',
    authType: 'api_key',
    piAuthProvider: 'openai',
    baseUrl: 'https://api.example.test/v1/',
    defaultModel: 'stored-openai-model',
    createdAt: 1,
  }],
}))
process.env.POLO_AI_CONFIG_DIR = configRoot
process.env.OPENAI_API_KEY = 'invocation-env-secret'

const { resolveConnection } = await import('../one-shot.ts')
const { parseExecutionArgs } = await import('../execution-parser.ts')
const record = {
  directory: join(configRoot, 'thread'),
  sessionsRoot: join(configRoot, 'thread', 'sessions'),
  ownerFile: join(configRoot, 'thread', 'owner.json'),
  metadata: {
    version: 1 as const,
    threadId: crypto.randomUUID(),
    origin: 'cli-exec' as const,
    configurationScopeId: 'global',
    configurationWorkspacePath: configRoot,
    workingDirectory: configRoot,
    createdAt: 1,
    lastUsedAt: 1,
    persistence: 'persistent' as const,
    connection: {
      slug: 'saved-connection',
      provider: 'openai',
      model: 'saved-model',
      baseUrl: 'https://saved.invalid',
      connectionType: 'pi_compat' as const,
      authType: 'api_key' as const,
      customEndpoint: { api: 'openai-completions' as const },
    },
  },
}
const resolved = await resolveConnection(
  parseExecutionArgs(['bun', 'index.ts', 'exec', 'resume', record.metadata.threadId, 'continue']),
  record,
  { id: 'global', path: configRoot },
)

if (resolved.connection?.baseUrl !== 'https://saved.invalid') throw new Error('saved base URL was not preserved')
if (resolved.connection?.piAuthProvider !== 'openai') throw new Error('saved provider was not preserved')
if (resolved.connection?.providerType !== 'pi_compat') throw new Error('saved connection type was not preserved')
if (resolved.connection?.customEndpoint?.api !== 'openai-completions') throw new Error('saved endpoint protocol was not preserved')
if (resolved.model !== 'saved-model') throw new Error('saved model was not preserved')
if (resolved.apiKey !== 'invocation-env-secret') throw new Error('invocation environment credential lost precedence')

delete process.env.OPENAI_API_KEY
const { getCredentialManager } = await import('@polo-ai/shared/credentials')
const { createCliThread, updateCliThread } = await import('../cli-thread-store.ts')
const storedSecret = 'stored-manager-secret-123456'
await getCredentialManager().setLlmApiKey('stored-openai', storedSecret)
const explicitRecord = await createCliThread({
  origin: 'cli-exec',
  configurationScopeId: 'global',
  configurationWorkspacePath: configRoot,
  workingDirectory: configRoot,
  persistence: 'persistent',
  connection: {
    provider: 'openai',
    baseUrl: 'https://api.example.test/v1',
  },
})
const explicitResolved = await resolveConnection(
  parseExecutionArgs([
    'bun',
    'index.ts',
    'exec',
    '--provider',
    'openai',
    '--base-url',
    'https://api.example.test/v1',
    'hello',
  ]),
  explicitRecord,
  { id: 'global', path: configRoot },
)
if (explicitResolved.connection?.slug !== 'stored-openai') {
  throw new Error(`configured identity was not matched: ${explicitResolved.connection?.slug}`)
}
if (explicitResolved.apiKey !== storedSecret) {
  throw new Error('stored credential manager value was not resolved')
}
await updateCliThread(explicitRecord, {
  connection: {
    slug: explicitResolved.connection.slug,
    provider: explicitResolved.connection.piAuthProvider,
    model: explicitResolved.model,
    baseUrl: explicitResolved.connection.baseUrl,
    connectionType: explicitResolved.connection.providerType,
    authType: explicitResolved.connection.authType,
    customEndpoint: explicitResolved.connection.customEndpoint,
  },
})
const metadata = await Bun.file(join(explicitRecord.directory, 'thread.json')).text()
if (metadata.includes(storedSecret)) throw new Error('stored credential leaked into Thread metadata')
process.stdout.write('ok\n')
