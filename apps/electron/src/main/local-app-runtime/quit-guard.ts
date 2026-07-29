export interface LocalAppQuitGuardLogger {
  info(message: string): void
  error(message: string, error: unknown): void
}

/**
 * Returns false when local runtime cleanup was not fully successful. Callers
 * must keep Electron alive so cleanup can be retried instead of claiming a
 * successful quit while managed descendants may still exist.
 */
export async function canQuitAfterLocalAppShutdown(
  shutdown: () => Promise<void>,
  logger: LocalAppQuitGuardLogger,
): Promise<boolean> {
  try {
    await shutdown()
    logger.info('Stopped all local app runtimes')
    return true
  } catch (error) {
    logger.error('Failed to stop local app runtimes:', error)
    return false
  }
}
