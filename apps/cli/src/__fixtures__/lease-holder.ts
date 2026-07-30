import { acquireCliThreadLease, createCliThread } from '../cli-thread-store.ts'

const configRoot = process.argv[2]
if (!configRoot) throw new Error('missing config root')
process.env.POLO_AI_CONFIG_DIR = configRoot

const record = await createCliThread({
  origin: 'cli-exec',
  configurationScopeId: 'global',
  configurationWorkspacePath: configRoot,
  workingDirectory: configRoot,
  persistence: 'persistent',
})
await acquireCliThreadLease(record)
process.stdout.write(`${JSON.stringify({ threadId: record.metadata.threadId })}\n`)
await new Promise(() => {})
