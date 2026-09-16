const [configRoot, serverEntry, ...commandArgs] = process.argv.slice(2)
if (!configRoot || !serverEntry) throw new Error('missing fixture config root or server entry')

process.env.POLO_AI_CONFIG_DIR = configRoot

const [{ parseExecutionArgs }, { runExecutionCommand }] = await Promise.all([
  import('../execution-parser.ts'),
  import('../one-shot.ts'),
])

const args = parseExecutionArgs(['bun', 'index.ts', ...commandArgs])
// Test-only dependency injection. Production CLI argv cannot set this field.
args.serverEntry = serverEntry
process.exit(await runExecutionCommand(args))
