import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getProcessBirthIdentity } from '../cli-thread-store.ts'
import { createConfigurationSnapshot } from '../one-shot.ts'
import { spawnServer } from '../server-spawner.ts'

const root = process.argv[2]
if (!root) throw new Error('missing fixture root')

const threadId = crypto.randomUUID()
const directory = join(root, 'thread')
const sessionsRoot = join(directory, 'sessions')
const ownerFile = join(directory, 'owner.json')
await mkdir(sessionsRoot, { recursive: true, mode: 0o700 })
const record = {
  directory,
  sessionsRoot,
  ownerFile,
  metadata: {
    version: 1 as const,
    threadId,
    origin: 'cli-exec' as const,
    configurationScopeId: 'global',
    configurationWorkspacePath: join(root, 'fresh-config'),
    workingDirectory: root,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    persistence: 'persistent' as const,
  },
}
const snapshotRoot = await createConfigurationSnapshot(record, {
  id: 'global',
  path: record.metadata.configurationWorkspacePath,
})
const processIdentity = getProcessBirthIdentity(process.pid)
if (!processIdentity) throw new Error('could not resolve owner process identity')
const leaseId = crypto.randomUUID()
await writeFile(ownerFile, JSON.stringify({
  leaseId,
  cliPid: process.pid,
  cliStartedAt: Date.now(),
  cliProcessIdentity: processIdentity,
  serverPid: 0,
  serverStartedAt: 0,
  heartbeatAt: Date.now(),
}), { mode: 0o600 })
if (process.platform !== 'win32') await chmod(ownerFile, 0o600)

const server = await spawnServer({
  quiet: true,
  env: {
    POLO_AI_RUNTIME_PROFILE: 'cli-one-shot',
    POLO_AI_CONFIG_DIR: snapshotRoot,
    POLO_AI_SHARED_CREDENTIALS_DIR: root,
  },
  bootstrapPayload: {
    runtimeConfig: {
      sessionsRoot,
      workspace: {
        id: 'global',
        name: 'Global',
        slug: 'global',
        rootPath: snapshotRoot,
        createdAt: 0,
      },
    },
    owner: {
      pid: process.pid,
      ownerFile,
      leaseId,
      processIdentity,
    },
  },
})
process.stdout.write(`${JSON.stringify({
  runtimePid: server.pid,
  runtimeIdentity: server.processIdentity,
})}\n`)

await new Promise(() => {})
