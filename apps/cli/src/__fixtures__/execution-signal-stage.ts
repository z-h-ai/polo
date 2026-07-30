import { writeFile } from 'node:fs/promises'
import type { ExecutionLifecycleStage } from '../one-shot.ts'

const [configRoot, targetStage, markerFile, serverEntry, mode] = process.argv.slice(2) as [
  string,
  ExecutionLifecycleStage,
  string,
  string,
  'persistent' | 'ephemeral' | 'run-no-cleanup',
]

process.env.POLO_AI_CONFIG_DIR = configRoot

const [{ parseExecutionArgs }, { executeTurn }] = await Promise.all([
  import('../execution-parser.ts'),
  import('../one-shot.ts'),
])

const args = parseExecutionArgs([
  'bun',
  'index.ts',
  mode === 'run-no-cleanup' ? 'run' : 'exec',
  ...(mode === 'run-no-cleanup' ? ['--no-cleanup'] : ['--json']),
  ...(mode === 'ephemeral' ? ['--ephemeral'] : []),
  '--server-entry',
  serverEntry,
  'hello',
])

const exitCode = await executeTurn(args, 'hello', {
  async lifecycleStageHook(stage, state) {
    if (stage !== targetStage) return
    await writeFile(markerFile, JSON.stringify({
      stage,
      ephemeral: args.ephemeral,
      ...state,
    }), 'utf-8')
    // Hold the exact boundary long enough for the parent test process to send
    // a real OS signal. The lifecycle handler must remain installed here.
    await Bun.sleep(750)
  },
})

process.exit(exitCode)
