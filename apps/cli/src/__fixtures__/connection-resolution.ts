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
process.stdout.write('ok\n')
