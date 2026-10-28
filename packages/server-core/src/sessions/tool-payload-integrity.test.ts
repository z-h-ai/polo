import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager'
import { readSessionJsonl, writeSessionJsonl } from '@polo-ai/shared/sessions/jsonl'

describe('tool payload integrity (POO-161)', () => {
  it('preserves protocol paths, HTML and commands through live events and storage when launched from /', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-integrity-'))
    const cwd = process.cwd()
    try {
      const manager = new SessionManager()
      const workspace = { id: 'test', slug: 'test', name: 'test', rootPath: root, createdAt: 0 }
      const managed = createManagedSession({ id: '261027-quick-moor' }, workspace, { messagesLoaded: true })
      const events: any[] = []
      const harness = manager as unknown as {
        processEvent: (session: typeof managed, event: any) => Promise<void>
        sendEvent: (event: any) => void
      }
      harness.sendEvent = event => events.push(event)
      process.chdir('/') // Finder-launched Electron's real cwd, not the repository cwd.
      const input = {
        title: 'test', html: '<img src="/Users/example/assets/icon.png">',
        command: 'cat /etc/hosts', path: '/tmp/source.txt', model: 'haiku',
      }
      const original = structuredClone(input)
      const result = '[genui-app id="app-test" version="6" path="/Users/example/sessions/s1/data/genui-apps/app-test/index.html"]'
      await harness.processEvent(managed, { type: 'tool_start', toolName: 'mcp__session__generate_app', toolUseId: 't1', input })
      await harness.processEvent(managed, { type: 'tool_result', toolName: 'mcp__session__generate_app', toolUseId: 't1', result })
      expect(events.find(e => e.type === 'tool_start').toolInput).toEqual(original)
      expect(events.find(e => e.type === 'tool_result').result).toBe(result)
      expect(input).toEqual(original)
      const file = join(root, 'session.jsonl')
      writeSessionJsonl(file, { id: managed.id, workspaceRootPath: root, messages: managed.messages } as any)
      const loaded = readSessionJsonl(file)!
      expect(loaded.messages[0]?.toolInput).toEqual(original)
      expect(loaded.messages[0]?.toolResult).toBe(result)
    } finally {
      process.chdir(cwd)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
