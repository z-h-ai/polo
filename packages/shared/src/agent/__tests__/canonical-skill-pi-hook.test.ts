import { expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAgent } from '../pi-agent.ts'
import { createMockBackendConfig, createMockWorkspace, createMockSession } from './test-utils.ts'
import type { AgentEvent } from '@polo-ai/core/types'

class PausedPi extends PiAgent { protected async *chatImpl(): AsyncGenerator<AgentEvent> { yield { type: 'complete' } } }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

it('actual Pi PreToolUse never borrows B receipt after A automation wait and rejects missing original UUID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canonical-pi-turn-'))
  const path = join(root, '.polo/canonical-skills', 'a'.repeat(64), 'skills/slug')
  const checks: string[] = [], finished: string[] = []
  const authority = { load: async () => [{ slug: `canonical-${'a'.repeat(64)}`, metadata: { name: 'slug', description: 'unit' }, content: 'instructions', path, source: 'workspace' as const }], authorize: async (_: readonly string[], id: string) => { checks.push(id) }, finish: async (id: string) => { finished.push(id) } }
  const agent = new PausedPi(createMockBackendConfig({ provider: 'pi', workspace: createMockWorkspace({ rootPath: root }), session: createMockSession({ id: 'pi-turn-unit', workspaceRootPath: root, workingDirectory: root }), canonicalSkills: authority }))
  const internals = agent as unknown as { send: (r: Record<string, unknown>) => void; emitAutomationEvent: () => Promise<void>; handlePreToolUseRequest: (r: Record<string, unknown>) => Promise<void>; handleToolExecuteRequest: (r: Record<string, unknown>) => Promise<void>; routeToolCall: () => Promise<{content:string;isError:boolean}>; handleLine: (r: string) => void; handleSubprocessEvent: () => void }
  const sent: Record<string, unknown>[] = []; internals.send = r => { sent.push(r) }
  try {
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), '---\nname: slug\ndescription: unit\n---\ninstructions')
    const a = agent.chat(`[skill:canonical-${'a'.repeat(64)}] first`); await a.next(); const aId = checks[0]!
    const arrived = deferred(), release = deferred(); internals.emitAutomationEvent = async () => { arrived.resolve(); await release.promise }
    const oldRequest = internals.handlePreToolUseRequest({ requestId: 'old-A', canonicalTurnId: aId, toolName: 'Read', input: { file_path: join(path, 'SKILL.md') } })
    await arrived.promise; await a.return(undefined as never); expect(finished).toEqual([aId])
    const b = agent.chat(`[skill:canonical-${'a'.repeat(64)}] second`); await b.next(); const bId = checks.at(-1)!
    const bChecks = checks.filter(id => id === bId).length
    release.resolve(); await oldRequest
    expect(sent.at(-1)?.action).toBe('block'); expect(String(sent.at(-1)?.reason)).toContain('original tool turn')
    expect(checks.filter(id => id === bId)).toHaveLength(bChecks)
    internals.emitAutomationEvent = async () => {}
    await internals.handlePreToolUseRequest({ requestId: 'no-origin', toolName: 'Read', input: { file_path: join(path, 'SKILL.md') } })
    expect(sent.at(-1)?.action).toBe('block')
    await internals.handlePreToolUseRequest({ requestId: 'current-B', canonicalTurnId: bId, toolName: 'Read', input: { file_path: join(path, 'SKILL.md') } })
    expect(sent.at(-1)?.action).not.toBe('block')
    let executed = 0; internals.routeToolCall = async () => { executed++; return { content: 'unit', isError: false } }
    await internals.handleToolExecuteRequest({ requestId: 'proxy-old-A', canonicalTurnId: aId, toolName: 'unit', args: {} })
    expect(executed).toBe(0); expect((sent.at(-1)?.result as {isError:boolean}).isError).toBe(true)
    let forwarded = 0; internals.handleSubprocessEvent = () => { forwarded++ }
    internals.handleLine(JSON.stringify({ type: 'event', canonicalTurnId: aId, event: { type: 'agent_end' } }))
    expect(forwarded).toBe(0)
    internals.handleLine(JSON.stringify({ type: 'event', canonicalTurnId: bId, event: { type: 'agent_end' } }))
    expect(forwarded).toBe(1)
    await b.return(undefined as never)
  } finally { agent.destroy(); await rm(root, { recursive: true, force: true }) }
})
