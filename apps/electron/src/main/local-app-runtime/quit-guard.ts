export interface LocalAppQuitGuardLogger {
  info(message: string): void
  error(message: string, error: unknown): void
}

export interface PreventableBeforeQuitEvent {
  preventDefault(): void
}

export interface BeforeQuitCleanupAttempt {
  started: boolean
  promise?: Promise<boolean>
}

/**
 * Synchronously blocks every before-quit event until one shared asynchronous
 * cleanup attempt has completed successfully. Re-entrant events reuse the
 * in-flight promise but cannot bypass preventDefault().
 */
export class BeforeQuitCleanupCoordinator {
  private cleanupPromise?: Promise<boolean>
  private exitAllowed = false

  begin(
    event: PreventableBeforeQuitEvent,
    cleanup: () => Promise<boolean>,
  ): BeforeQuitCleanupAttempt {
    if (this.exitAllowed) return { started: false }
    event.preventDefault()
    if (this.cleanupPromise) {
      return { started: false, promise: this.cleanupPromise }
    }

    const cleanupPromise: Promise<boolean> = Promise.resolve()
      .then(cleanup)
      .then((successful) => {
        if (successful) {
          this.exitAllowed = true
        } else if (this.cleanupPromise === cleanupPromise) {
          this.cleanupPromise = undefined
        }
        return successful
      })
      .catch((error) => {
        if (this.cleanupPromise === cleanupPromise) {
          this.cleanupPromise = undefined
        }
        throw error
      })
    this.cleanupPromise = cleanupPromise
    return { started: true, promise: cleanupPromise }
  }

  isExitAllowed(): boolean {
    return this.exitAllowed
  }
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
