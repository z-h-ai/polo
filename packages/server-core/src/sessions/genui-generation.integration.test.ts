import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager'
import { PiEventAdapter } from '../../../shared/src/agent/backend/pi/event-adapter'
import { handleGenerateApp } from '../../../session-tools-core/src/handlers/generate-app'
import type { SessionToolContext } from '../../../session-tools-core/src/context'
import type { AgentEvent } from '@polo-ai/core/types'
import type { SessionEvent } from '@polo-ai/shared/protocol'

test('generate_app → Pi wrapper → live event → production persistence → session API preserves the bundle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'genui-generation-'))
  const cwd = process.cwd()
  const manager = new SessionManager()
  try {
    const workspace = { id: 'test', slug: 'test', name: 'test', rootPath: root, createdAt: 0 }
    const managed = createManagedSession({ id: '261027-quick-moor' }, workspace, { messagesLoaded: true })
    const harness = manager as unknown as {
      sessions: Map<string, typeof managed>
      processEvent: (session: typeof managed, event: AgentEvent) => Promise<void>
      persistSession: (session: typeof managed) => void
      sendEvent: (event: SessionEvent) => void
    }
    const events: SessionEvent[] = []
    harness.sendEvent = event => events.push(event)
    harness.sessions.set(managed.id, managed)
    const sessionDir = join(root, 'sessions', managed.id)
    const input = { title: 'Regression app', html: '<!doctype html><html><body>App ready<img src="/tmp/icon.png"></body></html>' }
    process.chdir('/')
    const generated = await handleGenerateApp({ dataPath: join(sessionDir, 'data') } as SessionToolContext, input)
    expect(generated.isError).toBe(false)
    const original = generated.content.map(c => c.text).join('\n')
    const indexPath = /path="([^"]+)"/.exec(original)![1]!
    expect(readFileSync(indexPath, 'utf8')).toBe(input.html)
    const adapter = new PiEventAdapter()
    adapter.startTurn()
    for (const sdkEvent of [
      { type: 'tool_execution_start' as const, toolCallId: 't1', toolName: 'generate_app', args: input },
      { type: 'tool_execution_end' as const, toolCallId: 't1', toolName: 'generate_app', result: generated, isError: false },
    ]) {
      for (const event of adapter.adaptEvent(sdkEvent)) await harness.processEvent(managed, event)
    }
    expect(events.find(e => e.type === 'tool_result')).toMatchObject({ result: original })
    harness.persistSession(managed)
    await manager.flushSession(managed.id)
    const stored = readFileSync(join(sessionDir, 'session.jsonl'), 'utf8').trim().split('\n').slice(1).map(line => JSON.parse(line))
    expect(stored[0].type).toBe('tool')
    expect(stored[0].toolResult).toContain('path="{{SESSION_PATH}}/data/genui-apps/')
    expect(stored[0].toolInput).toEqual(input)
    managed.messages = []
    managed.messagesLoaded = false
    const reloaded = await manager.getSession(managed.id)
    expect(reloaded?.messages[0]?.toolResult).toBe(original)
    expect(reloaded?.messages[0]?.toolInput).toEqual(input)
  } finally {
    await manager.flushAllSessions()
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})
