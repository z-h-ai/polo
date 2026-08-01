import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('missing fixture root')
await mkdir(root, { recursive: true })

const traceFile = join(root, 'runtime-trace.jsonl')
const serverEntry = join(import.meta.dir, 'lifecycle-failure-server.ts')
const originalConnection = {
  slug: 'saved-original',
  provider: 'anthropic',
  model: 'original-model',
  baseUrl: 'https://original.example.test/v1',
  connectionType: 'pi_compat' as const,
  authType: 'api_key' as const,
  customEndpoint: { api: 'anthropic-messages' as const },
}

await writeFile(join(root, 'config.json'), JSON.stringify({
  workspaces: [],
  activeWorkspaceId: null,
  llmConnections: [],
}))
await writeFile(join(root, '.polo-lifecycle-fixture.json'), JSON.stringify({
  mode: 'complete',
  traceFile,
}))
process.env.POLO_AI_CONFIG_DIR = root

const [{ createCliThread, updateCliThread }, { parseExecutionArgs }, { executeTurn }] = await Promise.all([
  import('../cli-thread-store.ts'),
  import('../execution-parser.ts'),
  import('../one-shot.ts'),
])

const record = await createCliThread({
  origin: 'cli-exec',
  configurationScopeId: 'global',
  configurationWorkspacePath: root,
  workingDirectory: root,
  persistence: 'persistent',
  connection: originalConnection,
})
await updateCliThread(record, { mainSessionId: 'fixture-session', status: 'completed' })

const runResume = async (argv: string[], prompt: string): Promise<void> => {
  const args = parseExecutionArgs(['bun', 'index.ts', ...argv])
  args.serverEntry = serverEntry
  const exitCode = await executeTurn(args, prompt)
  if (exitCode !== 0) throw new Error(`resume failed with exit ${exitCode}`)
}

const originalWrite = process.stdout.write
process.stdout.write = (() => true) as typeof process.stdout.write
try {
  await runResume([
    'exec',
    'resume',
    record.metadata.threadId,
    '--provider',
    'openai',
    '--model',
    'override-model',
    '--base-url',
    'https://override.example.test/v1',
    '--',
    'first resume',
  ], 'first resume')

  const afterOverride = JSON.parse(
    await readFile(join(record.directory, 'thread.json'), 'utf-8'),
  )
  if (JSON.stringify(afterOverride.connection) !== JSON.stringify(originalConnection)) {
    throw new Error('explicit resume override mutated original Thread connection metadata')
  }

  await runResume([
    'exec',
    'resume',
    record.metadata.threadId,
    '--',
    'second resume',
  ], 'second resume')

  const traces = (await readFile(traceFile, 'utf-8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  const bootstraps = traces.filter(trace => trace.type === 'bootstrap')
  if (bootstraps.length !== 2) throw new Error(`expected two runtime bootstraps, got ${bootstraps.length}`)
  const first = bootstraps[0]?.connection
  if (
    first?.piAuthProvider !== 'openai'
    || first?.baseUrl !== 'https://override.example.test/v1'
    || first?.defaultModel !== 'override-model'
  ) {
    throw new Error('first resume did not use explicit connection overrides')
  }
  const second = bootstraps[1]?.connection
  if (
    second?.piAuthProvider !== 'anthropic'
    || second?.baseUrl !== 'https://original.example.test/v1'
    || second?.defaultModel !== 'original-model'
  ) {
    throw new Error('subsequent resume did not restore original Thread connection')
  }

  const afterSecondResume = JSON.parse(
    await readFile(join(record.directory, 'thread.json'), 'utf-8'),
  )
  if (JSON.stringify(afterSecondResume.connection) !== JSON.stringify(originalConnection)) {
    throw new Error('subsequent resume mutated original Thread connection metadata')
  }
} finally {
  process.stdout.write = originalWrite
}

process.stdout.write('ok\n')
