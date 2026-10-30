/** No initializeDocs or filesystem writes: exercise the configured instance's
 * guide reference, generated system prompt and actual browser prerequisite. */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
const originalReadFileSync = fs.readFileSync
const savedConfigDir = process.env.POLO_AI_CONFIG_DIR
const instanceRoot = `/tmp/poo159-guide-instance-${process.pid}`
process.env.POLO_AI_CONFIG_DIR = instanceRoot
const instanceGuide = join(instanceRoot, 'docs', 'browser-tools.md')
const globalGuide = join(homedir(), '.polo-ai', 'docs', 'browser-tools.md')
// Both guides exist by default; missing-guide cases only vary this boundary.
let instanceGuideExists = true
let instanceGuideReadable = true
mock.module('node:fs', () => ({
  ...fs,
  existsSync: (path: unknown) => (instanceGuideExists && path === instanceGuide) || path === globalGuide,
  readFileSync: (path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (path === instanceGuide) {
      if (!instanceGuideExists) throw Object.assign(new Error('guide missing'), { code: 'ENOENT' })
      if (!instanceGuideReadable) throw Object.assign(new Error('guide unreadable'), { code: 'EACCES' })
      return 'Current instance browser guide'
    }
    if (path === globalGuide) return 'Other global browser guide'
    return (originalReadFileSync as (...input: unknown[]) => unknown)(path, ...args)
  },
}))
const storage = await import('../../config/storage.ts')
mock.module('../../config/storage.ts', () => ({ ...storage, getBrowserToolEnabled: () => true, getGenerativeUiInlineEnabled: () => false, getGenerativeUiCanvasEnabled: () => false }))
mock.module('../../config/preferences.ts', () => ({ getCoAuthorPreference: () => true, formatPreferencesForPrompt: () => '' }))
const { DOC_REFS, getDocPath } = await import('../index')
const { getSystemPrompt } = await import('../../prompts/system')
const { PrerequisiteManager } = await import('../../agent/core/prerequisite-manager')
afterEach(() => { instanceGuideExists = true; instanceGuideReadable = true })
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.POLO_AI_CONFIG_DIR
  else process.env.POLO_AI_CONFIG_DIR = savedConfigDir
})

describe('browser guide uses the running configured instance', () => {
  it('points the agent at the same browser guide that initializeDocs syncs', () => {
    expect(getDocPath('browser-tools.md')).toBe(instanceGuide)
    expect(DOC_REFS.browserTools).toBe(instanceGuide)
  })
  it('generates the actual mandatory Read instruction with the instance guide path', () => {
    const prompt = getSystemPrompt(undefined, undefined, '/test/workspace', '/test/workspace')
    expect(prompt).toContain(`until you read \`${instanceGuide}\``)
    expect(prompt).not.toContain('`~/.polo-ai/docs/browser-tools.md`')
  })
  it('does not instruct default open as unconditional background while documenting user choice', () => {
    const prompt = getSystemPrompt(undefined, undefined, '/test/workspace', '/test/workspace')
    expect(prompt).toContain('first open in the current chat uses the sidebar; preserves hidden/popup choices')
    expect(prompt).not.toContain('ensure browser window exists (opens in background)')
  })
  it('keeps the gate strict when the agent reads another instance global guide', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/test/workspace' })
    manager.trackReadTool({ file_path: globalGuide })
    const first = manager.checkPrerequisites('browser_tool')
    expect(first.allowed).toBe(false)
    expect(first.blockReason).toContain(instanceGuide)
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(false)
  })
  it('accepts the synced instance guide for the session-scoped browser tool', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/test/workspace' })
    manager.trackReadTool({ file_path: instanceGuide })
    expect(manager.checkPrerequisites('mcp__session__browser_tool').allowed).toBe(true)
  })
})


describe('strict browser guide prerequisite when instance docs are missing', () => {
  it('blocks unread browser tools even when only a different global guide exists', () => {
    instanceGuideExists = false
    for (const tool of ['browser_tool', 'mcp__session__browser_tool']) {
      const manager = new PrerequisiteManager({ workspaceRootPath: '/test/workspace' })
      expect(manager.hasRead(instanceGuide)).toBe(false)
      expect(manager.hasRead(globalGuide)).toBe(false)
      const result = manager.checkPrerequisites(tool)
      expect(result.allowed).toBe(false)
      expect(result.blockReason).toContain(instanceGuide)
      expect(result.blockReason).toContain('restart Polo AI')
      expect(result.blockReason).toContain('sync')
      expect(result.blockReason).toContain('reinstall')
    }
  })
  it('cannot substitute a global Read or repeated retries for the missing instance guide', () => {
    instanceGuideExists = false
    const manager = new PrerequisiteManager({ workspaceRootPath: '/test/workspace' })
    manager.trackReadTool({ file_path: globalGuide })
    expect(manager.hasRead(instanceGuide)).toBe(false)
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(false)
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(false)
  })
  it('continues to allow optional source and API guides that do not exist', () => {
    instanceGuideExists = false
    const manager = new PrerequisiteManager({ workspaceRootPath: '/test/workspace' })
    expect(manager.checkPrerequisites('mcp__example__read').allowed).toBe(true)
    expect(manager.checkPrerequisites('api_example').allowed).toBe(true)
  })
})


describe('browser guide Read attempt and recovery lifecycle', () => {
  it('does not record a failed missing-guide Read attempt from backend pre-tool tracking', () => {
    instanceGuideExists = false
    const manager = new PrerequisiteManager({ workspaceRootPath: '/test/workspace' })
    // Pi tool_start and Claude PreToolUse call this before the real Read result.
    manager.trackReadTool({ file_path: instanceGuide })
    expect(manager.hasRead(instanceGuide)).toBe(false)
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(false)
  })
  it('revokes a previous successful Read when the instance guide disappears', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/test/workspace' })
    manager.trackReadTool({ file_path: instanceGuide })
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(true)
    instanceGuideExists = false
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(false)
    expect(manager.hasRead(instanceGuide)).toBe(false)
    instanceGuideExists = true
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(false)
    manager.trackReadTool({ file_path: instanceGuide })
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(true)
  })
  it('requires a fresh Read after failed Read then normal docs sync recovery', () => {
    instanceGuideExists = false
    const manager = new PrerequisiteManager({ workspaceRootPath: '/test/workspace' })
    manager.trackReadTool({ path: instanceGuide })
    instanceGuideExists = true
    expect(manager.checkPrerequisites('mcp__session__browser_tool').allowed).toBe(false)
    manager.trackReadTool({ path: instanceGuide })
    expect(manager.checkPrerequisites('mcp__session__browser_tool').allowed).toBe(true)
  })
  it('treats a present but unreadable guide as a failed Read and revokes earlier receipts', () => {
    const manager = new PrerequisiteManager({ workspaceRootPath: '/test/workspace' })
    manager.trackReadTool({ file_path: instanceGuide })
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(true)
    instanceGuideReadable = false
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(false)
    manager.trackReadTool({ file_path: instanceGuide })
    expect(manager.hasRead(instanceGuide)).toBe(false)
    instanceGuideReadable = true
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(false)
    manager.trackReadTool({ file_path: instanceGuide })
    expect(manager.checkPrerequisites('browser_tool').allowed).toBe(true)
  })
})
