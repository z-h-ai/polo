import { describe, expect, it, mock } from 'bun:test'
import { canQuitAfterLocalAppShutdown } from '../quit-guard'

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
})
