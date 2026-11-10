import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Session } from '@polo-ai/shared/protocol'
import { CodedError, SESSION_PROJECT_ERROR_MESSAGES } from '@polo-ai/shared/protocol'
import type { ISessionManager } from '@polo-ai/server-core/handlers'
import { BindingStore } from '../binding-store'
import { Commands } from '../commands'
import type { IncomingMessage, PlatformAdapter, SentMessage } from '../types'

// POO-205 C6 (P2-6): the gateway /new command is a BACKGROUND entry point —
// in an enterprise space the session layer refuses with the coded
// PROJECT_CONTEXT_REQUIRED, and handleNew replies the canonical reason itself
// (CodedError loses its class across the in-process boundary; the branch is on
// the bare code). Other errors keep the plain err.message shape.

function makeSessionManagerWithCreateError(error: unknown): ISessionManager {
  return {
    getSessions: () => [],
    getSession: async () => null,
    createSession: async () => { throw error },
    sendMessage: async () => {},
    cancelProcessing: async () => {},
    respondToPermission: () => true,
  } as unknown as ISessionManager
}

function makeAdapter(): PlatformAdapter & { sent: string[] } {
  const sent: string[] = []
  return {
    platform: 'whatsapp',
    capabilities: {
      messageEditing: false,
      inlineButtons: false,
      maxButtons: 10,
      maxMessageLength: 4096,
      markdown: 'whatsapp',
      webhookSupport: false,
    },
    sent,
    async initialize() {},
    async destroy() {},
    isConnected() { return true },
    onMessage() {},
    onButtonPress() {},
    async sendText(_channelId: string, text: string): Promise<SentMessage> {
      sent.push(text)
      return { platform: 'whatsapp', channelId: 'chan-1', messageId: String(sent.length) }
    },
    async editMessage() {},
    async sendButtons(): Promise<SentMessage> {
      return { platform: 'whatsapp', channelId: 'chan-1', messageId: String(sent.length + 1) }
    },
    async sendTyping() {},
    async sendFile(): Promise<SentMessage> {
      return { platform: 'whatsapp', channelId: 'chan-1', messageId: String(sent.length + 2) }
    },
  }
}

function makeMessage(text: string): IncomingMessage {
  return {
    platform: 'whatsapp',
    channelId: 'chan-1',
    messageId: 'm1',
    senderId: 'u1',
    senderName: 'Alice',
    text,
    timestamp: Date.now(),
    raw: {},
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeStore(): BindingStore {
  const dir = mkdtempSync(join(tmpdir(), 'commands-gate-bind-'))
  tempDirs.push(dir)
  return new BindingStore(dir)
}

describe('Commands /new project gate (POO-205 C6)', () => {
  it('a coded PROJECT_CONTEXT_REQUIRED refusal replies the canonical reason itself', async () => {
    const gate = new CodedError(
      'PROJECT_CONTEXT_REQUIRED',
      SESSION_PROJECT_ERROR_MESSAGES.PROJECT_CONTEXT_REQUIRED,
    )
    const store = makeStore()
    const commands = new Commands(makeSessionManagerWithCreateError(gate), store, 'ws1')
    const adapter = makeAdapter()

    await commands.handleCommand(adapter, makeMessage('/new nightly'))

    expect(adapter.sent).toHaveLength(1)
    expect(adapter.sent[0]).toBe(`Failed to create session: ${SESSION_PROJECT_ERROR_MESSAGES.PROJECT_CONTEXT_REQUIRED}`)
    expect(adapter.sent[0]).not.toContain('CodedError')
    // The chat is NOT bound to a session that was never created.
    expect(store.findByChannel('whatsapp', 'chan-1')).toBeUndefined()
  })

  it('a plain error keeps the err.message reply shape', async () => {
    const commands = new Commands(
      makeSessionManagerWithCreateError(new Error('disk exploded')),
      makeStore(),
      'ws1',
    )
    const adapter = makeAdapter()

    await commands.handleCommand(adapter, makeMessage('/new nightly'))

    expect(adapter.sent).toHaveLength(1)
    expect(adapter.sent[0]).toBe('Failed to create session: disk exploded')
  })

  it('success still binds the created session', async () => {
    const session = { id: 'sess-new', name: 'nightly' } as unknown as Session
    const commands = new Commands({
      getSessions: () => [],
      getSession: async () => session,
      createSession: async () => session,
      sendMessage: async () => {},
      cancelProcessing: async () => {},
      respondToPermission: () => true,
    } as unknown as ISessionManager, makeStore(), 'ws1')
    const adapter = makeAdapter()

    await commands.handleCommand(adapter, makeMessage('/new nightly'))

    expect(adapter.sent.at(-1)).toContain('Created "nightly"')
  })
})
