import { beforeEach, describe, expect, it, mock } from 'bun:test'

const logEntries: unknown[][] = []
const capture = (...args: unknown[]) => {
  logEntries.push(args)
}

mock.module('../logger', () => ({
  mainLog: {
    debug: capture,
    error: capture,
    info: capture,
    warn: capture,
  },
}))

const { handleDeepLink, parseDeepLink } = await import('../deep-link')

beforeEach(() => {
  logEntries.length = 0
})

describe('deep-link logging', () => {
  it('never writes join bearer tokens or raw URLs to main-process logs', async () => {
    const joinToken = 'join-secret-token-abcdefghijklmnopqrstuvwxyz'
    const joinUrl = `poloai://join/${joinToken}?window=focused`
    const malformedSecret = 'malformed-secret-token-abcdefghijklmnopqrstuvwxyz'
    const malformedUrl = `poloai://join/%E0%A4%A-${malformedSecret}`
    const focusedWindow = {
      webContents: { id: 17 },
    }
    const createdWindow = {
      webContents: { id: 23 },
    }
    const windowManager = {
      getFocusedWindow: () => focusedWindow,
      getWorkspaceForWindow: () => 'workspace-1',
      getAllWindows: () => [],
      createWindow: mock(() => createdWindow),
    }

    const result = await handleDeepLink(joinUrl, windowManager as never)
    expect(result).toEqual({ success: true, windowId: 23 })
    expect(parseDeepLink(malformedUrl)).toBeNull()

    const serializedLogs = JSON.stringify(logEntries)
    expect(serializedLogs).not.toContain(joinToken)
    expect(serializedLogs).not.toContain(joinUrl)
    expect(serializedLogs).not.toContain(malformedSecret)
    expect(serializedLogs).not.toContain(malformedUrl)
    expect(serializedLogs).not.toContain('%E0%A4%A')

    const contexts = logEntries
      .flat()
      .filter((entry): entry is { routeType: string; fingerprint: string } => (
        typeof entry === 'object'
        && entry !== null
        && 'routeType' in entry
        && 'fingerprint' in entry
      ))
    expect(contexts.length).toBeGreaterThan(0)
    expect(contexts.every(context => (
      ['join', 'invalid'].includes(context.routeType)
      && /^[a-f0-9]{12}$/.test(context.fingerprint)
      && Object.keys(context).sort().join(',') === 'fingerprint,routeType'
    ))).toBe(true)
  })
})
