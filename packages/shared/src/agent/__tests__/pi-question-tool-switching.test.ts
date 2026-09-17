/**
 * request_user_input per-turn capability switching — Pi path (review fix #1)
 *
 * Covers both halves of the desktop → messaging → desktop contract:
 *
 * 1. Main process (PiAgent): every turn re-registers the COMPLETE session
 *    tool set with scope 'session' — the payload includes
 *    mcp__session__request_user_input for desktop turns and omits it for
 *    non-desktop turns.
 * 2. Subprocess (ProxyToolRegistry): session-scope registration REPLACES the
 *    session tool set (a tool omitted after a desktop registration is
 *    actually removed — the old merge-by-name semantics kept it visible),
 *    while pool-scope (MCP/API source) tools are merged and preserved.
 */

import { describe, expect, it } from 'bun:test'
import { createMockBackendConfig, createMockWorkspace } from './test-utils.ts'
import { ProxyToolRegistry, type ProxyToolDef } from '../../../../pi-agent-server/src/proxy-tool-registry.ts'

const { PiAgent } = await import('../pi-agent.ts')
type PiAgentType = import('../pi-agent.ts').PiAgent

const RUI = 'mcp__session__request_user_input'
const OTHER_TOOL = 'mcp__session__config_validate'

function defs(allowRui: boolean): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const base = [{ name: OTHER_TOOL, description: 'validate', inputSchema: {} }]
  return allowRui
    ? [...base, { name: RUI, description: 'ask', inputSchema: {} }]
    : base
}

describe('request_user_input Pi capability switching (desktop → messaging → desktop)', () => {
  it('main process re-registers the full session tool set with the current capability bit each turn', async () => {
    const config = createMockBackendConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: 'pi' as any,
      model: '',
      isHeadless: true,
      workspace: createMockWorkspace({ rootPath: '/tmp/pi-switch-test' }),
    })
    const agent = new PiAgent(config) as PiAgentType
    const sent: Array<{ type: string; scope?: string; tools: Array<{ name: string }> }> = []
    ;(agent as unknown as { send: (cmd: unknown) => void }).send = (cmd: unknown) => {
      sent.push(cmd as { type: string; scope?: string; tools: Array<{ name: string }> })
    }

    const register = (allow: boolean) => {
      ;(agent as unknown as { allowRequestUserInput: boolean }).allowRequestUserInput = allow
      ;(agent as unknown as { sendSessionToolRegistration: () => void }).sendSessionToolRegistration()
    }

    // Desktop turn — tool visible
    register(true)
    // Messaging turn — tool must be omitted from the registration payload
    register(false)
    // Desktop again — tool must come back
    register(true)

    const registrations = sent.filter(m => m.type === 'register_tools' && m.scope === 'session')
    expect(registrations).toHaveLength(3)

    expect(registrations[0]!.tools.some(t => t.name === RUI)).toBe(true)
    expect(registrations[1]!.tools.some(t => t.name === RUI)).toBe(false)
    expect(registrations[2]!.tools.some(t => t.name === RUI)).toBe(true)

    // Session registrations never use the legacy merge scope
    expect(registrations.every(m => m.scope === 'session')).toBe(true)
  })

  it('subprocess replaces the session tool set and preserves pool tools across the switch', () => {
    const registry = new ProxyToolRegistry()
    const poolTool: ProxyToolDef = { name: 'mcp__linear__list_issues', description: 'issues', inputSchema: {} }

    // Desktop turn
    registry.register('session', defs(true))
    registry.register('pool', [poolTool])
    expect(registry.has(RUI)).toBe(true)
    expect(registry.has(OTHER_TOOL)).toBe(true)
    expect(registry.has(poolTool.name)).toBe(true)
    expect(registry.toolsChanged).toBe(true)
    registry.markConsumed()

    // Messaging turn — request_user_input must be REMOVED (old merge
    // semantics kept it registered; replace semantics fail closed)
    registry.register('session', defs(false))
    expect(registry.has(RUI)).toBe(false)
    expect(registry.has(OTHER_TOOL)).toBe(true)
    // Pool tool survives the session-scope replacement
    expect(registry.has(poolTool.name)).toBe(true)
    expect(registry.toolsChanged).toBe(true)
    registry.markConsumed()

    // Desktop again — tool returns
    registry.register('session', defs(true))
    expect(registry.has(RUI)).toBe(true)
    expect(registry.has(poolTool.name)).toBe(true)
  })

  it('pool-scope registration keeps merge semantics (no removal of other pool tools)', () => {
    const registry = new ProxyToolRegistry()
    const poolA: ProxyToolDef = { name: 'mcp__linear__list_issues', description: 'a', inputSchema: {} }
    const poolB: ProxyToolDef = { name: 'mcp__gmail__search', description: 'b', inputSchema: {} }

    registry.register('pool', [poolA])
    registry.register('pool', [poolB])
    expect(registry.has(poolA.name)).toBe(true)
    expect(registry.has(poolB.name)).toBe(true)

    // Re-registering poolA updates it in place without dropping poolB
    registry.register('pool', [{ ...poolA, description: 'a2' }])
    expect(registry.has(poolB.name)).toBe(true)
    const updated = registry.tools.find(t => t.name === poolA.name)
    expect(updated?.description).toBe('a2')
  })
})
