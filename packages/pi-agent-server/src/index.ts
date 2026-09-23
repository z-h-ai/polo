#!/usr/bin/env node
const args = process.argv.slice(2)
const hostFlags = args.filter((arg) => arg === '--host-completion-v1')
const unknownHostFlags = args.filter((arg) => arg.startsWith('--host-') && arg !== '--host-completion-v1')
if (hostFlags.length === 0 && unknownHostFlags.length === 0) {
  await import('./session-server.ts')
} else {
  // Bootstrap gate: owns output ONLY until the Host module loads successfully. The fixed handlers
  // cover exactly the dynamic import; once it resolves they are removed and the Host settle path
  // exclusively owns every later output — the bootstrap catch can never emit a second JSONL line
  // after runHostCompletion started (R7 §1, Review R5 issue 5).
  const fixedHandler = (): void => {}
  process.on('uncaughtException', fixedHandler)
  process.on('unhandledRejection', fixedHandler)
  let host: typeof import('./host-completion.ts')
  try {
    host = await import('./host-completion.ts')
  } catch {
    try {
      const { INVALID_RESULT_LINE, writeHostResultLine } = await import('./host-completion-protocol.ts')
      const flushed = await writeHostResultLine(INVALID_RESULT_LINE)
      process.exit(flushed ? 0 : 1)
    } catch {
      process.exit(1)
    }
  }
  process.off('uncaughtException', fixedHandler)
  process.off('unhandledRejection', fixedHandler)
  await host.runHostCompletion(hostFlags.length !== 1 || unknownHostFlags.length > 0)
}
