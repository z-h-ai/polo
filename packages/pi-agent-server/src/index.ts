#!/usr/bin/env node
const args = process.argv.slice(2)
const hostFlags = args.filter((arg) => arg === '--host-completion-v1')
const unknownHostFlags = args.filter((arg) => arg.startsWith('--host-') && arg !== '--host-completion-v1')
if (hostFlags.length === 0 && unknownHostFlags.length === 0) {
  await import('./session-server.ts')
} else {
  const fixedHandler = (): void => {}
  process.on('uncaughtException', fixedHandler)
  process.on('unhandledRejection', fixedHandler)
  try {
    const host = await import('./host-completion.ts')
    process.off('uncaughtException', fixedHandler)
    process.off('unhandledRejection', fixedHandler)
    await host.runHostCompletion(hostFlags.length !== 1 || unknownHostFlags.length > 0)
  } catch {
    const { INVALID_RESULT_LINE, writeHostResultLine } = await import('./host-completion-protocol.ts')
    const flushed = await writeHostResultLine(INVALID_RESULT_LINE)
    process.exit(flushed ? 0 : 1)
  }
}
