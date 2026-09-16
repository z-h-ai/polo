import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [root, mode] = process.argv.slice(2)
if (!root || (mode !== 'args' && mode !== 'resolved')) {
  throw new Error('usage: base-url-secret <root> <args|resolved>')
}
await mkdir(root, { recursive: true })
process.env.POLO_AI_CONFIG_DIR = root

const userinfoSecret = 'oauth-real-token-123456'
const querySecret = 'sk-query-secret-123456'
const credentialUrl =
  `https://user:${userinfoSecret}@example.test/v1?api_key=${querySecret}`

if (mode === 'resolved') {
  await writeFile(join(root, 'config.json'), JSON.stringify({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    defaultLlmConnection: 'credential-bearing-default',
    llmConnections: [{
      slug: 'credential-bearing-default',
      name: 'Unsafe config endpoint',
      providerType: 'pi_compat',
      authType: 'api_key',
      piAuthProvider: 'openai',
      baseUrl: credentialUrl,
      createdAt: 1,
    }],
  }))
}

const { parseExecutionArgs, UsageError } = await import('../execution-parser.ts')
const {
  listCliThreads,
} = await import('../cli-thread-store.ts')
const { runExecutionCommand } = await import('../one-shot.ts')

if (mode === 'args') {
  let rejected = false
  try {
    await runExecutionCommand(parseExecutionArgs([
      'bun',
      'index.ts',
      'exec',
      '--base-url',
      credentialUrl,
      'hello',
    ]))
  } catch (error) {
    rejected = error instanceof UsageError
  }
  if (!rejected) throw new Error('credential-bearing --base-url was not rejected')
} else {
  const exitCode = await runExecutionCommand(parseExecutionArgs([
    'bun',
    'index.ts',
    'exec',
    'hello',
  ]))
  if (exitCode !== 1) throw new Error(`expected resolved connection failure, got ${exitCode}`)
}

const records = await listCliThreads()
if (mode === 'args' && records.length !== 0) {
  throw new Error('argument validation created a Thread before rejecting base URL')
}
for (const record of records) {
  const files = await readdir(record.directory)
  for (const file of files) {
    const path = join(record.directory, file)
    if (!(await Bun.file(path).exists()) || Bun.file(path).type === '') continue
    try {
      const content = await readFile(path, 'utf-8')
      if (content.includes(userinfoSecret) || content.includes(querySecret)) {
        throw new Error(`credential leaked into ${file}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('credential leaked')) {
        throw error
      }
    }
  }
}
process.stdout.write('ok\n')
