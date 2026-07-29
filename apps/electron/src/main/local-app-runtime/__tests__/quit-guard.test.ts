import { describe, expect, it, mock } from 'bun:test'
import {
  BeforeQuitCleanupCoordinator,
  canQuitAfterLocalAppShutdown,
} from '../quit-guard'

describe('local app before-quit guard', () => {
  it('blocks quit and never logs success when runtime shutdown fails', async () => {
    const info = mock(() => {})
    const error = mock(() => {})

    const canQuit = await canQuitAfterLocalAppShutdown(
      async () => {
        throw new Error('managed process survived')
      },
      { info, error },
    )

    expect(canQuit).toBe(false)
    expect(info).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      'Failed to stop local app runtimes:',
      expect.objectContaining({ message: 'managed process survived' }),
    )
  })

  it('allows quit only after shutdown resolves', async () => {
    const info = mock(() => {})
    const error = mock(() => {})

    expect(await canQuitAfterLocalAppShutdown(async () => {}, { info, error })).toBe(true)
    expect(info).toHaveBeenCalledWith('Stopped all local app runtimes')
    expect(error).not.toHaveBeenCalled()
  })

  it('prevents consecutive before-quit events while one shutdown is pending and reuses it', async () => {
    const coordinator = new BeforeQuitCleanupCoordinator()
    const firstEvent = { preventDefault: mock(() => {}) }
    const secondEvent = { preventDefault: mock(() => {}) }
    let resolveShutdown!: () => void
    const shutdown = mock(() => new Promise<void>(resolve => {
      resolveShutdown = resolve
    }))
    const logger = { info: mock(() => {}), error: mock(() => {}) }
    const cleanup = () => canQuitAfterLocalAppShutdown(shutdown, logger)

    const first = coordinator.begin(firstEvent, cleanup)
    const second = coordinator.begin(secondEvent, cleanup)

    expect(first.started).toBe(true)
    expect(second.started).toBe(false)
    expect(second.promise).toBe(first.promise)
    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(secondEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledTimes(0)

    await Promise.resolve()
    expect(shutdown).toHaveBeenCalledTimes(1)
    resolveShutdown()
    await expect(first.promise!).resolves.toBe(true)
    expect(coordinator.isExitAllowed()).toBe(true)

    const allowedEvent = { preventDefault: mock(() => {}) }
    expect(coordinator.begin(allowedEvent, cleanup).started).toBe(false)
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled()
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('keeps both quit events blocked when shared shutdown rejects and allows a later retry', async () => {
    const coordinator = new BeforeQuitCleanupCoordinator()
    const logger = { info: mock(() => {}), error: mock(() => {}) }
    let rejectFirstShutdown!: (error: Error) => void
    const shutdown = mock()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => {
        rejectFirstShutdown = reject
      }))
      .mockResolvedValueOnce(undefined)
    const cleanup = () => canQuitAfterLocalAppShutdown(shutdown, logger)
    const firstEvent = { preventDefault: mock(() => {}) }
    const secondEvent = { preventDefault: mock(() => {}) }

    const first = coordinator.begin(firstEvent, cleanup)
    const second = coordinator.begin(secondEvent, cleanup)
    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(secondEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(second.promise).toBe(first.promise)

    await Promise.resolve()
    rejectFirstShutdown(new Error('managed process survived'))
    await expect(first.promise!).resolves.toBe(false)
    expect(coordinator.isExitAllowed()).toBe(false)
    expect(logger.error).toHaveBeenCalledTimes(1)

    const retryEvent = { preventDefault: mock(() => {}) }
    const retry = coordinator.begin(retryEvent, cleanup)
    expect(retry.started).toBe(true)
    expect(retryEvent.preventDefault).toHaveBeenCalledTimes(1)
    await expect(retry.promise!).resolves.toBe(true)
    expect(shutdown).toHaveBeenCalledTimes(2)
    expect(coordinator.isExitAllowed()).toBe(true)
  })
})
