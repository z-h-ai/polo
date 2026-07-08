import { beforeEach, describe, expect, it, mock } from 'bun:test'

const ipcOn = mock(() => {})
const ipcOff = mock(() => {})

mock.module('electron', () => ({
  ipcMain: {
    on: ipcOn,
    off: ipcOff,
  },
  webContents: {
    fromId: mock(() => undefined),
  },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
  }
})

const { DeepLinkCallbackBridge } = await import('../deep-link-callback-bridge')
const { RPC_CHANNELS } = await import('../../shared/types')

interface FakeWebContents {
  url: string
  destroyed: boolean
  messages: Array<{ payload: unknown; origin: string }>
  isDestroyed(): boolean
  getURL(): string
  executeJavaScript(script: string): Promise<void>
}

function createWebContents(url = 'https://app.example/page'): FakeWebContents {
  return {
    url,
    destroyed: false,
    messages: [],
    isDestroyed() {
      return this.destroyed
    },
    getURL() {
      return this.url
    },
    async executeJavaScript(script: string) {
      const match = /^window\.postMessage\((.*), ("(?:[^"\\]|\\.)*")\)$/.exec(script)
      if (!match) throw new Error(`Unexpected script: ${script}`)
      this.messages.push({
        payload: JSON.parse(match[1]),
        origin: JSON.parse(match[2]),
      })
    },
  }
}

describe('DeepLinkCallbackBridge', () => {
  let now: number
  let webContentsById: Map<number, FakeWebContents>
  let bridge: InstanceType<typeof DeepLinkCallbackBridge>

  beforeEach(() => {
    now = 1_000
    webContentsById = new Map()
    bridge = new DeepLinkCallbackBridge({
      registerIpc: false,
      cleanupIntervalMs: 0,
      now: () => now,
      ttlMs: 1_000,
      maxCallbacksPerWebContents: 2,
      getWebContentsById: (id) => webContentsById.get(id),
    })
  })

  it('posts ack messages for action results', () => {
    const wc = createWebContents()
    webContentsById.set(42, wc)

    expect(bridge.registerCallback('callback-1', 42)).toEqual({ ok: true })
    bridge.handleActionResult({ callbackId: 'callback-1', sessionId: 'session-1' })

    expect(wc.messages).toEqual([
      {
        origin: 'https://app.example',
        payload: {
          type: 'poloai:ack',
          callbackId: 'callback-1',
          result: { sessionId: 'session-1' },
        },
      },
    ])
  })

  it('forwards only whitelisted event fields', () => {
    const wc = createWebContents()
    webContentsById.set(42, wc)

    bridge.registerCallback('callback-1', 42)
    bridge.handleActionResult({ callbackId: 'callback-1', sessionId: 'session-1' })
    wc.messages.length = 0

    bridge.handleSessionEvent({ type: 'text_delta', sessionId: 'session-1', delta: 'hi' })
    bridge.handleSessionEvent({
      type: 'tool_result',
      sessionId: 'session-1',
      toolUseId: 'tool-1',
      toolName: 'bash',
      result: 'secret output',
    })
    bridge.handleSessionEvent({ type: 'permission_request', sessionId: 'session-1', request: {} as never })

    expect(wc.messages.map(message => message.payload)).toEqual([
      {
        type: 'poloai:event',
        callbackId: 'callback-1',
        event: { type: 'text_delta', sessionId: 'session-1', delta: 'hi' },
      },
      {
        type: 'poloai:event',
        callbackId: 'callback-1',
        event: { type: 'tool_result', sessionId: 'session-1', toolName: 'bash' },
      },
    ])
  })

  it('authorizes send-message only for sessions owned by the same webContents', () => {
    const wc = createWebContents()
    webContentsById.set(42, wc)

    bridge.registerCallback('callback-1', 42)
    bridge.handleActionResult({ callbackId: 'callback-1', sessionId: 'session-1' })

    expect(bridge.prepareSendMessage('callback-1', 42, 'session-1')).toEqual({ ok: true })
    expect(bridge.prepareSendMessage('callback-1', 43, 'session-1')).toEqual({
      ok: false,
      error: {
        code: 'not_authorized',
        message: 'Session belongs to another protocol page',
      },
    })
    expect(bridge.prepareSendMessage('callback-2', 42, 'missing-session')).toEqual({
      ok: false,
      error: {
        code: 'session_not_found',
        message: 'Session is not owned by this protocol page',
      },
    })
  })

  it('cleans callbacks on navigation and ttl expiry', () => {
    const wc = createWebContents()
    webContentsById.set(42, wc)

    bridge.registerCallback('callback-1', 42)
    bridge.handleActionResult({ callbackId: 'callback-1', sessionId: 'session-1' })
    bridge.cleanupWebContents(42)

    wc.messages.length = 0
    bridge.handleSessionEvent({ type: 'complete', sessionId: 'session-1' })
    expect(wc.messages).toHaveLength(0)

    bridge.registerCallback('callback-2', 42)
    expect(bridge.getActiveCallbackCount(42)).toBe(1)
    now += 1_001
    bridge.cleanupExpired()
    expect(bridge.getActiveCallbackCount(42)).toBe(0)
  })

  it('enforces active callback limit per webContents', () => {
    const wc = createWebContents()
    webContentsById.set(42, wc)

    expect(bridge.registerCallback('callback-1', 42)).toEqual({ ok: true })
    expect(bridge.registerCallback('callback-2', 42)).toEqual({ ok: true })
    expect(bridge.registerCallback('callback-3', 42)).toEqual({
      ok: false,
      error: {
        code: 'invalid_action',
        message: 'Too many active poloai:// callbacks for this page (max 2)',
      },
    })
  })

  it('wraps session event sinks', () => {
    const wc = createWebContents()
    webContentsById.set(42, wc)
    bridge.registerCallback('callback-1', 42)
    bridge.handleActionResult({ callbackId: 'callback-1', sessionId: 'session-1' })
    wc.messages.length = 0

    const calls: unknown[] = []
    const sink = bridge.wrapEventSink((channel, target, ...args) => {
      calls.push({ channel, target, args })
    })

    sink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId: 'ws-1' }, {
      type: 'complete',
      sessionId: 'session-1',
    })

    expect(wc.messages[0]?.payload).toEqual({
      type: 'poloai:event',
      callbackId: 'callback-1',
      event: { type: 'complete', sessionId: 'session-1' },
    })
    expect(calls).toHaveLength(1)
  })
})
