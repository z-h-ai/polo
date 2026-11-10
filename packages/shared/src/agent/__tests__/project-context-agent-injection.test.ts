import { afterEach, describe, expect, it } from 'bun:test'
import { ClaudeAgent } from '../claude-agent.ts'
import { PiAgent } from '../pi-agent.ts'
import { createMockBackendConfig, createMockSession, createMockWorkspace } from './test-utils.ts'

// POO-205 C7a (R9/R12): the project-context system-prompt block rides EVERY
// turn of a project-bound session on BOTH backends, in the same format, and
// the live override pushed by the session layer (`updateProjectContext`,
// after the per-send membership re-proof) shadows the session-config
// snapshot — instruction edits take effect on the CURRENT turn. Both
// backends rebuild their system prompt per chat call and read the effective
// context through BaseAgent.

const V1 = { name: 'Project One', purpose: 'First purpose', instructions: 'Always answer in Chinese.' }
const V2 = { name: 'Project One Renamed', purpose: 'Second purpose', instructions: 'Always answer in English.' }

function piAgent(projectContext?: typeof V1): PiAgent {
  return new PiAgent(createMockBackendConfig({
    provider: 'pi',
    workspace: createMockWorkspace(),
    session: createMockSession({
      id: 'pi-ctx-session',
      ...(projectContext ? { projectContext } : {}),
    } as never),
  }))
}

function claudeAgent(projectContext?: typeof V1): ClaudeAgent {
  return new ClaudeAgent({
    ...createMockBackendConfig({
      workspace: createMockWorkspace(),
      session: createMockSession({
        id: 'claude-ctx-session',
        ...(projectContext ? { projectContext } : {}),
      } as never),
    }),
    // The runtime owner token is mandatory at construction (fail closed);
    // tests are the runtime owner of this instance.
    sessionCallbackOwnerToken: 'c7a-injection-test-owner',
  } as never)
}

const backends: Array<{ destroy(): void }> = []
function track<T extends { destroy(): void }>(agent: T): T {
  backends.push(agent)
  return agent
}

afterEach(() => {
  for (const agent of backends.splice(0)) agent.destroy()
})

describe('project context injection into system prompts (POO-205 C7a)', () => {
  // ------------------------------------------------------------------
  // Pi — per-turn system-prompt assembly (buildTurnSystemPrompt)
  // ------------------------------------------------------------------

  it('Pi: a project-bound session rides <project_context> with the instruction body on EVERY turn', () => {
    const agent = track(piAgent(V1))
    const prompt = (agent as unknown as { buildTurnSystemPrompt(b: string): string }).buildTurnSystemPrompt('BASE-PROMPT')
    expect(prompt.startsWith('BASE-PROMPT\n\n<project_context>')).toBe(true)
    expect(prompt).toContain('Project name: Project One')
    expect(prompt).toContain('Project introduction: First purpose')
    expect(prompt).toContain('<project_instructions>')
    expect(prompt).toContain('Always answer in Chinese.')
    expect(prompt).toContain('</project_instructions>')
  })

  it('Pi: updateProjectContext takes effect on the NEXT assembly (v1 → v2)', () => {
    const agent = track(piAgent(V1))
    const build = (agent as unknown as { buildTurnSystemPrompt(b: string): string }).buildTurnSystemPrompt.bind(agent)
    expect(build('BASE')).toContain('First purpose')
    // The session layer re-proved membership and pushes the fresh snapshot.
    agent.updateProjectContext(V2)
    const next = build('BASE')
    expect(next).toContain('Always answer in English.')
    expect(next).toContain('Project One Renamed')
    expect(next).not.toContain('First purpose')
  })

  it('Pi: updateProjectContext(undefined) falls back to the session-config snapshot', () => {
    const agent = track(piAgent(V1))
    const build = (agent as unknown as { buildTurnSystemPrompt(b: string): string }).buildTurnSystemPrompt.bind(agent)
    agent.updateProjectContext(V2)
    expect(build('BASE')).toContain('Second purpose')
    agent.updateProjectContext(undefined)
    expect(build('BASE')).toContain('First purpose')
  })

  it('Pi: no projectContext anywhere → the bare base prompt (negative control)', () => {
    const agent = track(piAgent(undefined))
    const prompt = (agent as unknown as { buildTurnSystemPrompt(b: string): string }).buildTurnSystemPrompt('BASE-PROMPT')
    expect(prompt).toBe('BASE-PROMPT')
    expect(prompt).not.toContain('<project_context>')
  })

  // ------------------------------------------------------------------
  // Claude — per-chat `options.systemPrompt.append` assembly
  // ------------------------------------------------------------------

  it('Claude: the preset append carries the same <project_context> block', () => {
    const agent = track(claudeAgent(V1))
    const append = (agent as unknown as { buildPresetAppendSystemPrompt(): string }).buildPresetAppendSystemPrompt()
    expect(append).toContain('<project_context>')
    expect(append).toContain('Project name: Project One')
    expect(append).toContain('Project introduction: First purpose')
    expect(append).toContain('Always answer in Chinese.')
    expect(append).toContain('</project_context>')
  })

  it('Claude: updateProjectContext rebuilds the append with the new snapshot', () => {
    const agent = track(claudeAgent(V1))
    const build = (agent as unknown as { buildPresetAppendSystemPrompt(): string }).buildPresetAppendSystemPrompt.bind(agent)
    expect(build()).toContain('First purpose')
    agent.updateProjectContext(V2)
    const next = build()
    expect(next).toContain('Always answer in English.')
    expect(next).not.toContain('First purpose')
  })

  it('Claude: no projectContext → the append has no context block (negative control)', () => {
    const agent = track(claudeAgent(undefined))
    const append = (agent as unknown as { buildPresetAppendSystemPrompt(): string }).buildPresetAppendSystemPrompt()
    expect(append).not.toContain('<project_context>')
    expect(append).not.toContain('project_instructions')
    // Still a real base prompt (preferences module), not an empty string.
    expect(append.length).toBeGreaterThan(100)
  })

  // ------------------------------------------------------------------
  // Shared base semantics
  // ------------------------------------------------------------------

  it('BaseAgent: the override shadows the config snapshot for both backends (R12)', async () => {
    for (const agent of [track(piAgent(V1)), track(claudeAgent(V1))]) {
      const effective = (agent as unknown as { effectiveProjectContext(): unknown }).effectiveProjectContext()
      expect(effective).toEqual(V1)
      agent.updateProjectContext(V2)
      expect((agent as unknown as { effectiveProjectContext(): unknown }).effectiveProjectContext()).toEqual(V2)
    }
  })
})
