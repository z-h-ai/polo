import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root = process.argv[2]!
process.env.POLO_AI_CONFIG_DIR = root
process.env.HOME = root
const { createCliThread, acquireCliThreadLease, getCliSessionsRoot } = await import('../cli-thread-store')
const { spawnServer } = await import('../server-spawner')
const { CliRpcClient } = await import('../client')
const { createConfigurationSnapshot } = await import('../one-shot')
await mkdir(root, { recursive: true })
await writeFile(join(root, 'config.json'), JSON.stringify({ workspaces: [], activeWorkspaceId: null }))
let modelCalls = 0
const provider = Bun.serve({ port: 0, fetch() { modelCalls++; return new Response('should not be requested', {status: 500}) } })
const connection = { slug: 'owned-test', name: 'Owned', providerType: 'pi' as const, piAuthProvider: 'openai', authType: 'api_key' as const, baseUrl: `http://127.0.0.1:${provider.port}/v1`, customEndpoint: { api: 'openai-completions' as const }, defaultModel: 'test-model', createdAt: 1 }
const record = await createCliThread({ origin: 'cli-exec', configurationScopeId: 'global', configurationWorkspacePath: root, workingDirectory: root, persistence: 'persistent' })
const lease = await acquireCliThreadLease(record)
const snapshot = await createConfigurationSnapshot(record, { id: 'global', path: root })
const workspace = { id: 'global', name: 'Global', slug: 'global', rootPath: snapshot, createdAt: 1 }
const runtimeConfig = { threadId: record.metadata.threadId, threadRoot: record.directory, sessionsRoot: record.sessionsRoot, controlledRoot: getCliSessionsRoot(), workspace, origin: 'cli-exec', connection, connectionProvenance: { kind: 'owned' } }
const owner = { pid: process.pid, ownerFile: record.ownerFile, leaseId: lease.owner.leaseId, processIdentity: lease.owner.cliProcessIdentity }
const rejected: string[] = []
const reject = async (name: string, fn: () => Promise<any>) => { try { await fn() } catch { rejected.push(name); return }; throw new Error(`${name} unexpectedly allowed`) }
const start = (config = runtimeConfig, authorityOwner = owner) => spawnServer({ serverEntry: resolve('packages/server/src/index.ts'), startupTimeout: 10000, quiet: true, env: { POLO_AI_RUNTIME_PROFILE: 'cli-one-shot', POLO_AI_CONFIG_DIR: snapshot, HOME: snapshot, POLO_AI_SHARED_CREDENTIALS_DIR: snapshot, POLO_AI_BUNDLED_ASSETS_ROOT: resolve('apps/electron') }, bootstrapPayload: { runtimeConfig: config, owner: authorityOwner, credential: { value: 'controlled-test-key' } } })
let server: Awaited<ReturnType<typeof start>> | undefined
let client: InstanceType<typeof CliRpcClient> | undefined
try {
  await reject('wrong owner birth', () => start(runtimeConfig, { ...owner, processIdentity: 'wrong' }))
  await reject('wrong owner pid', () => start(runtimeConfig, { ...owner, pid: process.pid + 1 }))
  await reject('wrong lease', () => start(runtimeConfig, { ...owner, leaseId: 'wrong' }))
  await reject('cross Thread roots', () => start({ ...runtimeConfig, sessionsRoot: join(root, 'other', 'sessions') }))
  await reject('managed bootstrap', () => start({ ...runtimeConfig, connection: { ...connection, managedBy: 'admin' } } as any))
  await reject('managed provenance bootstrap', () => start({ ...runtimeConfig, connectionProvenance: { kind: 'managed' } } as any))
  server = await start()
  client = new CliRpcClient(server.url, { token: server.token, workspaceId: workspace.id, requestTimeout: 5000 })
  await client.connect()
  await reject('unregistered admin RPC', () => client!.invoke('admin:getSession'))
  await reject('unregistered file RPC', () => client!.invoke('file:read', '/etc/passwd'))
  await reject('cross workspace', () => client!.invoke('sessions:create', 'another', {}))
  await reject('forged business scope', () => client!.invoke('sessions:create', 'global', { permissionMode: 'safe', accountId: 'forged', productSpaceId: 'space' }))
  await reject('forged origin', () => client!.invoke('sessions:create', 'global', { permissionMode: 'safe', origin: 'edit-popover' }))
  const created = await client.invoke('sessions:create', 'global', { permissionMode: 'safe', workingDirectory: root, llmConnection: connection.slug, hidden: true, origin: 'cli-exec' }) as { id: string }
  await reject('second root', () => client!.invoke('sessions:create', 'global', { permissionMode: 'safe', workingDirectory: root, llmConnection: connection.slug }))
  await reject('cross Thread send', () => client!.invoke('sessions:sendMessage', 'foreign-session', 'hi'))
  await reject('cross Thread cancel', () => client!.invoke('sessions:cancel', 'foreign-session', true))
  await reject('managed model laundering', () => client!.invoke('session:setModel', created.id, 'global', 'test-model', 'polo-space-forged'))
  await reject('permission escalation enum', () => client!.invoke('sessions:command', created.id, { type: 'setPermissionMode', mode: 'unrestricted' }))
  await reject('unsupported command', () => client!.invoke('sessions:command', created.id, { type: 'setSources', sourceSlugs: [] }))
  await reject('source spoof', () => client!.invoke('sessions:sendMessage', created.id, 'hi', null, null, { invocationSource: 'desktop' }))
  const other = new CliRpcClient(server.url, { token: server.token, workspaceId: 'foreign', requestTimeout: 5000 })
  try { await other.connect(); await reject('foreign client workspace', () => other.invoke('sessions:cancel', created.id, true)) } finally { other.destroy() }
  const currentOwner = JSON.parse(await readFile(record.ownerFile, 'utf8'))
  await writeFile(record.ownerFile, JSON.stringify({ ...currentOwner, leaseId: 'revoked' }))
  await reject('revoked owner request', () => client!.invoke('sessions:sendMessage', created.id, 'never send'))
  await Bun.sleep(1500)
  if (modelCalls !== 0) throw new Error('Unauthorized request reached provider')
  console.log(JSON.stringify({ rejected, modelCalls, validRootCreated: true }))
} finally { client?.destroy(); await server?.stop(); await lease.release().catch(() => {}); provider.stop(true) }
