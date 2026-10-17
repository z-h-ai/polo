import { join } from 'node:path'
const root = process.argv[2]
if (!root) throw new Error('missing fixture root')
process.env.POLO_AI_CONFIG_DIR = root
const { createCliThread, acquireCliThreadLease, getCliSessionsRoot } = await import('../cli-thread-store.ts')
const { createConfigurationSnapshot } = await import('../one-shot.ts')
const { spawnServer } = await import('../server-spawner.ts')
const record = await createCliThread({
  origin: 'cli-exec', configurationScopeId: 'global',
  configurationWorkspacePath: join(root, 'fresh-config'), workingDirectory: root,
  persistence: 'persistent',
})
const lease = await acquireCliThreadLease(record)
const snapshotRoot = await createConfigurationSnapshot(record, { id: 'global', path: record.metadata.configurationWorkspacePath })
const server = await spawnServer({
  quiet: true,
  env: { POLO_AI_RUNTIME_PROFILE: 'cli-one-shot', POLO_AI_CONFIG_DIR: snapshotRoot, POLO_AI_SHARED_CREDENTIALS_DIR: snapshotRoot },
  bootstrapPayload: {
    runtimeConfig: {
      threadId: record.metadata.threadId, threadRoot: record.directory,
      origin: record.metadata.origin, sessionsRoot: record.sessionsRoot,
      controlledRoot: getCliSessionsRoot(),
      workspace: { id: 'global', name: 'Global', slug: 'global', rootPath: snapshotRoot, createdAt: 0 },
    },
    owner: { pid: process.pid, ownerFile: record.ownerFile, leaseId: lease.owner.leaseId, processIdentity: lease.owner.cliProcessIdentity },
  },
})
process.stdout.write(`${JSON.stringify({ runtimePid: server.pid, runtimeIdentity: server.processIdentity })}\n`)
await new Promise(() => {})
