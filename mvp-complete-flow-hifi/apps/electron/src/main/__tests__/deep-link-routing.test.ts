import { describe, expect, it } from 'bun:test'
import { handleDeepLink, parseDeepLink } from '../deep-link'
import { RPC_CHANNELS } from '../../shared/types'
import type { EventSink } from '@polo-ai/server-core/transport'
import type { WindowManager } from '../window-manager'

function createMockWindow(webContentsId: number) {
  return {
    isMinimized: () => false,
    restore: () => {},
    focus: () => {},
    isDestroyed: () => false,
    webContents: {
      id: webContentsId,
      isLoading: () => false,
      isDestroyed: () => false,
      once: () => {},
    },
  }
}

describe('handleDeepLink routing', () => {
  it('parses valid callbackId and strips it from action params', () => {
    const target = parseDeepLink('poloai://action/new-session?input=hello&callbackId=abc12345')

    expect(target?.action).toBe('new-session')
    expect(target?.callbackId).toBe('abc12345')
    expect(target?.actionParams).toEqual({ input: 'hello' })
  })

  it('accepts the configured custom deep-link scheme', () => {
    const previousScheme = process.env.POLO_AI_DEEPLINK_SCHEME
    process.env.POLO_AI_DEEPLINK_SCHEME = 'poloai-test'

    try {
      const target = parseDeepLink('poloai-test://action/new-session?input=hello&callbackId=abc12345')

      expect(target?.action).toBe('new-session')
      expect(target?.callbackId).toBe('abc12345')
      expect(target?.actionParams).toEqual({ input: 'hello' })
    } finally {
      if (previousScheme == null) {
        delete process.env.POLO_AI_DEEPLINK_SCHEME
      } else {
        process.env.POLO_AI_DEEPLINK_SCHEME = previousScheme
      }
    }
  })

  it('ignores invalid callbackId values', () => {
    const target = parseDeepLink('poloai://action/new-session?input=hello&callbackId=bad!')

    expect(target?.action).toBe('new-session')
    expect(target?.callbackId).toBeUndefined()
    expect(target?.actionParams).toEqual({ input: 'hello' })
  })

  it('parses send-message action session id', () => {
    const target = parseDeepLink('poloai://action/send-message/session-123?input=next&callbackId=cb-123456')

    expect(target?.action).toBe('send-message')
    expect(target?.callbackId).toBe('cb-123456')
    expect(target?.actionParams).toEqual({ id: 'session-123', input: 'next' })
  })

  it('parses organization join tokens without treating them as workspace ids', () => {
    const target = parseDeepLink('poloai://join/invitation-token-1234567890%2Bsafe')

    expect(target).toEqual({
      workspaceId: undefined,
      joinToken: 'invitation-token-1234567890+safe',
      windowMode: undefined,
    })
  })

  it('prefers resolved target client over preferred caller client', async () => {
    const targetWindow = createMockWindow(22)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: (webContentsId: number) => webContentsId === 22 ? 'ws-target' : 'ws-other',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'poloai://workspace/ws-target/allSessions',
      windowManager,
      sink,
      (wcId) => wcId === 22 ? 'client-target' : undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.channel).toBe(RPC_CHANNELS.deeplink.NAVIGATE)
    expect(sent[0]?.target).toEqual({ to: 'client', clientId: 'client-target' })
  })

  it('uses preferred client only when no resolver is provided', async () => {
    const targetWindow = createMockWindow(31)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: () => 'ws-target',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'poloai://workspace/ws-target/allSessions',
      windowManager,
      sink,
      undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.target).toEqual({ to: 'client', clientId: 'client-caller' })
  })

  it('falls back to workspace routing when resolver exists but target client is unresolved', async () => {
    const targetWindow = createMockWindow(44)

    const windowManager = {
      focusOrCreateWindow: () => targetWindow,
      getFocusedWindow: () => targetWindow,
      getLastActiveWindow: () => targetWindow,
      getWorkspaceForWindow: () => 'ws-target',
    } as unknown as WindowManager

    const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
    const sink: EventSink = (channel, target, ...args) => {
      sent.push({ channel, target, args })
    }

    await handleDeepLink(
      'poloai://workspace/ws-target/allSessions',
      windowManager,
      sink,
      () => undefined,
      'client-caller',
    )

    expect(sent.length).toBe(1)
    expect(sent[0]?.target).toEqual({ to: 'workspace', workspaceId: 'ws-target' })
  })
})
