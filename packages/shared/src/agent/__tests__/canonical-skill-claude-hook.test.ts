import { expect, it, mock } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@polo-ai/core/types'
import type { SdkAutomationCallback } from '../../automations/types.ts'
import { createMockBackendConfig, createMockWorkspace, createMockSession } from './test-utils.ts'

const sdk = await import('@anthropic-ai/claude-agent-sdk')
let duringQuery: ((options: NonNullable<typeof captured>) => Promise<void>) | undefined
let captured: { abortController?: AbortController; hooks?: Record<string, Array<{ hooks: SdkAutomationCallback[] }>> } | undefined
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...sdk, query: ({ options }: { options: typeof captured }) => {
  captured = options
  return { async *[Symbol.asyncIterator]() { if (duringQuery && options) await duringQuery(options); yield { type: 'result', subtype: 'success', result: 'unit result', usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0, duration_ms: 0, duration_api_ms: 0, num_turns: 1, session_id: 'sdk-unit' } }, close() {} }
} }))
const { ClaudeAgent } = await import('../claude-agent.ts')
async function drain(turn: AsyncGenerator<AgentEvent>) {
  const errors: unknown[] = []
  for await (const event of turn) if (event.type === 'error') errors.push(event)
  expect(errors).toEqual([])
}

it('actual Claude constructor preserves canonical authority and SDK hook refuses cold image before resize', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canonical-claude-hook-'))
  let resized = 0, loaded = 0
  const authority = { load: async () => { loaded++; return [] }, authorize: async () => { throw new Error('cold') }, finish: async () => {} }
  const agent = new ClaudeAgent({ ...createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }), session: createMockSession({ id: 'claude-hook-unit', workspaceRootPath: root, workingDirectory: root }), canonicalSkills: authority }), sessionCallbackOwnerToken: 'canonical-hook-owner', onImageResize: async () => { resized++; return join(root, 'resized.png') } })
  try {
    const image = join(root, '.polo/canonical-skills', 'a'.repeat(64), 'skills/original-slug/large.png')
    await mkdir(join(image, '..'), { recursive: true }); await writeFile(image, new Uint8Array(4 * 1024 * 1024))
    duringQuery = async options => {
      const hook = options.hooks?.PreToolUse?.[0]?.hooks[0]
      expect(hook).toBeDefined()
      const result = await hook!({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'read-cold', tool_input: { file_path: image } }, 'read-cold', {})
      expect(result.continue).toBe(false)
      expect(resized).toBe(0)
    }
    await drain(agent.chat('unit capture only'))
    expect(loaded).toBe(1)
  } finally { duringQuery = undefined; agent.destroy(); await rm(root, { recursive: true, force: true }) }
})

it('actual Claude resized-input early return still reauthorizes selected Skill and old query hook cannot borrow new turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canonical-claude-resize-'))
  const path = join(root, '.polo/canonical-skills', 'b'.repeat(64), 'skills/slug')
  let allowed = true, resized = 0, loaded = 0, queried = 0
  const ids: string[] = []
  const authority = { load: async () => { loaded++; return [{ slug: `canonical-${'b'.repeat(64)}`, metadata: { name: 'slug', description: 'unit' }, content: 'unit', path, source: 'workspace' as const }] }, authorize: async (_: string[], id: string) => { ids.push(id); if (!allowed) throw new Error('revoked') }, finish: async () => {} }
  const agent = new ClaudeAgent({ ...createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }), session: createMockSession({ id: 'claude-resize-unit', workspaceRootPath: root, workingDirectory: root }), canonicalSkills: authority }), sessionCallbackOwnerToken: 'resize-owner', onImageResize: async () => { resized++; allowed = false; return join(root, 'resized.png') } })
  // Isolate the whole-hook contract from the separate constructor-copy defect.
  // The actual query and hook still come from the production ClaudeAgent.
  const fixtureConfig = (agent as unknown as { config: { canonicalSkills: typeof authority; onImageResize: (path: string) => Promise<string> } }).config
  fixtureConfig.canonicalSkills = authority
  fixtureConfig.onImageResize = async () => { resized++; allowed = false; return join(root, 'resized.png') }
  try {
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), '---\nname: slug\ndescription: unit\n---\nunit')
    const image = join(path, 'large.png'); await writeFile(image, new Uint8Array(4 * 1024 * 1024))
    let oldHook!: SdkAutomationCallback
    duringQuery = async options => {
      queried++; oldHook = options.hooks!.PreToolUse![0]!.hooks[0]!
      const result = await oldHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'resize', tool_input: { file_path: image } }, 'resize', {})
      expect(resized).toBe(1); expect(result.continue).toBe(false); expect(ids.length).toBeGreaterThanOrEqual(3)
    }
    await drain(agent.chat(`[skill:canonical-${'b'.repeat(64)}] first`))
    const aId = ids[0]!; allowed = true
    let previousBHook: SdkAutomationCallback | undefined, previousBSignal: AbortSignal | undefined
    duringQuery = async options => {
      queried++
      if (previousBHook) {
        const count = ids.length
        const lateSameTurn = await previousBHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'same-turn-old-query', tool_input: { file_path: join(path, 'SKILL.md') } }, 'same-turn-old-query', {})
        expect(lateSameTurn.continue).toBe(false); expect(previousBSignal?.aborted).toBe(true); expect(ids).toHaveLength(count)
      }
      previousBHook = options.hooks!.PreToolUse![0]!.hooks[0]!
      previousBSignal = options.abortController?.signal
      const before = ids.length
      const old = await oldHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'late-A', tool_input: { file_path: join(path, 'SKILL.md') } }, 'late-A', {})
      expect(old.continue).toBe(false); expect(ids).toHaveLength(before)
      const current = await options.hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'current-B', tool_input: { file_path: join(path, 'SKILL.md') } }, 'current-B', {})
      expect(current.continue).toBe(true); expect(ids.at(-1)).not.toBe(aId)
    }
    await drain(agent.chat(`[skill:canonical-${'b'.repeat(64)}] second`))
    expect(queried).toBe(3) // Empty resumed SDK stream retries once inside the SAME Base turn.
    expect(loaded).toBe(2) // Internal retry does not reload/hot-replace the selected Skill.
  } finally { duringQuery = undefined; agent.destroy(); await rm(root, { recursive: true, force: true }) }
})

it('actual Claude image stat/authority await cannot resize after its original query aborts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canonical-claude-stat-abort-'))
  const path = join(root, '.polo/canonical-skills', 'c'.repeat(64), 'skills/slug')
  let checks = 0, resized = 0, controller: AbortController | undefined
  const authority = { load: async () => [{ slug: `canonical-${'c'.repeat(64)}`, metadata: { name: 'slug', description: 'unit' }, content: 'unit', path, source: 'workspace' as const }], authorize: async () => { checks++; if (checks === 3) controller!.abort() }, finish: async () => {} }
  const agent = new ClaudeAgent({ ...createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }), session: createMockSession({ id: 'claude-stat-abort-unit', workspaceRootPath: root, workingDirectory: root }), canonicalSkills: authority }), sessionCallbackOwnerToken: 'stat-abort-owner', onImageResize: async () => { resized++; return join(root, 'resized.png') } })
  try {
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), '---\nname: slug\ndescription: unit\n---\nunit')
    const image = join(path, 'large.png'); await writeFile(image, new Uint8Array(4 * 1024 * 1024))
    duringQuery = async options => {
      controller = options.abortController
      const result = await options.hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'stat-abort', tool_input: { file_path: image } }, 'stat-abort', {})
      expect(controller?.signal.aborted).toBe(true); expect(result.continue).toBe(false); expect(resized).toBe(0)
    }
    await drain(agent.chat(`[skill:canonical-${'c'.repeat(64)}] test`))
  } finally { duringQuery = undefined; agent.destroy(); await rm(root, { recursive: true, force: true }) }
})
