/**
 * P0-2 isolation gate: the `tool_input_delta` SessionEvent (render_ui
 * skeleton streaming) is a RENDERER-INTERNAL channel. It must NEVER reach
 * tab protocol pages (the poloai:// bidirectional whitelist / fan-out) and
 * is never persisted. This test is the red-first guard written BEFORE the
 * event exists: once the dto type lands, it must stay green forever — any
 * regression that adds tool_input_delta to the protocol page surface fails
 * here.
 *
 * Mirrors the mock/module setup of deep-link-callback-bridge.test.ts.
 */

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
// dto re-exports flow through the protocol barrel — these constants only
// exist once the P0-2 dto change lands (this import is what made the test
// red first).
const {
  GENUI_TOOL_INPUT_DELTA_FLUSH_MS,
  GENUI_TOOL_INPUT_DELTA_MAX_TOTAL_CHARS,
} = await import('@polo-ai/shared/protocol')
import type { PoloaiProtocolEvent, SessionEvent } from '@polo-ai/shared/protocol'

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

describe('tool_input_delta protocol-page isolation (P0-2)', () => {
  let webContentsById: Map<number, FakeWebContents>
  let bridge: InstanceType<typeof DeepLinkCallbackBridge>

  beforeEach(() => {
    webContentsById = new Map()
    bridge = new DeepLinkCallbackBridge({
      registerIpc: false,
      cleanupIntervalMs: 0,
      now: () => 1_000,
      ttlMs: 1_000,
      maxCallbacksPerWebContents: 2,
      getWebContentsById: (id) => webContentsById.get(id),
    })
  })

  it('exposes the throttling/cap constants with the agreed values', () => {
    expect(GENUI_TOOL_INPUT_DELTA_FLUSH_MS).toBe(250)
    expect(GENUI_TOOL_INPUT_DELTA_MAX_TOTAL_CHARS).toBe(8192)
  })

  it('NEVER fans tool_input_delta out to a bound protocol page', () => {
    const wc = createWebContents()
    webContentsById.set(42, wc)

    bridge.registerCallback('callback-1', 42)
    bridge.handleActionResult({ callbackId: 'callback-1', sessionId: 'session-1' })
    wc.messages.length = 0

    // Sanity: the whitelist itself still works for a whitelisted family member
    bridge.handleSessionEvent({ type: 'text_delta', sessionId: 'session-1', delta: 'hi' })
    expect(wc.messages).toHaveLength(1)

    // The isolation contract: tool_input_delta is dropped by the fan-out
    bridge.handleSessionEvent({
      type: 'tool_input_delta',
      sessionId: 'session-1',
      toolUseId: 'toolu_1',
      toolName: 'render_ui',
      delta: '{"components":[{"type":"stat-card"',
      seq: 1,
    } as SessionEvent)
    expect(wc.messages).toHaveLength(1) // still only the text_delta

    // And nothing is queued behind it either
    bridge.handleSessionEvent({
      type: 'tool_input_delta',
      sessionId: 'session-1',
      toolUseId: 'toolu_1',
      toolName: 'render_ui',
      delta: ',"title":"Rev"}]}',
      seq: 2,
    } as SessionEvent)
    expect(wc.messages).toHaveLength(1)
  })

  it('keeps tool_input_delta out of the PoloaiProtocolEvent union (compile-time)', () => {
    // Type-level guard: assigning a tool_input_delta to PoloaiProtocolEvent
    // must be a compile error — the union is the whitelist. If someone adds
    // the member, this @ts-expect-error goes unused and typecheck fails.
    const notAProtocolEvent: PoloaiProtocolEvent = {
      // @ts-expect-error tool_input_delta is intentionally NOT a protocol page event
      type: 'tool_input_delta',
      sessionId: 'session-1',
    }
    void notAProtocolEvent
    expect(true).toBe(true)
  })
})
