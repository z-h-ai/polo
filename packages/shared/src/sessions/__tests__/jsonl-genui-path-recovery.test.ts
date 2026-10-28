import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionJsonl, writeSessionJsonl } from '../jsonl'

describe('historical generate_app path recovery (POO-161)', () => {
  it('recovers only the exact session-owned marker; leaves source file, other payloads and unsafe paths alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'genui-history-'))
    try {
      const file = join(root, 'session.jsonl')
      const suffix = '/data/genui-apps/app-test/index.html'
      const marker = (path: string, id = 'app-test') => `[genui-app id="${id}" version="6" path="${path}"]`
      const message = (toolResult: string, extra = {}) => ({ id: 'm', type: 'tool', toolName: 'mcp__session__generate_app', toolResult, ...extra })
      const cases = [
        message(marker('.{{SESSION_PATH}}' + suffix)),
        message(marker('.' + root + suffix), { toolName: 'generate_app' }),
        message(marker('{{SESSION_PATH}}' + suffix)),
        message(marker('./Users/other/session' + suffix)),
        message(marker('.{{SESSION_PATH}}' + suffix), { toolName: 'Read' }),
        message(marker('.{{SESSION_PATH}}' + suffix), { isError: true }),
        message(marker('.{{SESSION_PATH}}' + suffix, '../escape')),
        message(marker('.{{SESSION_PATH}}/data/genui-apps/app-other/index.html')),
        message(marker('.{{SESSION_PATH}}/data/genui-apps/app-test/../secret')),
      ]
      const source = [JSON.stringify({ id: 's', workspaceRootPath: root }), ...cases.map(m => JSON.stringify(m))].join('\n')
      writeFileSync(file, source)
      const loaded = readSessionJsonl(file)!
      expect(loaded.messages.slice(0, 3).map(m => m.toolResult)).toEqual(Array(3).fill(marker(root + suffix)))
      expect(loaded.messages.slice(3).map(m => m.toolResult)).toEqual(cases.slice(3).map(m => m.toolResult.replaceAll('{{SESSION_PATH}}', root)))
      expect(readFileSync(file, 'utf8')).toBe(source) // Read migration never rewrites original evidence.
      writeSessionJsonl(file, loaded)
      expect(readSessionJsonl(file)?.messages).toEqual(loaded.messages) // Stable across save/reload.
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
