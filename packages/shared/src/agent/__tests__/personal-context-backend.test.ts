import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSystemPrompt } from '../../prompts/system.ts'
import { ClaudeAgent } from '../claude-agent.ts'
import { PiAgent } from '../pi-agent.ts'
import { setEnterpriseSessionKindReaderForTests } from '../base-agent.ts'
import {
  createMockBackendConfig,
  createMockSession,
  createMockWorkspace,
  TestAgent,
} from './test-utils.ts'

// POO-205 C7b (P1-5): an ENTERPRISE session never reads personal scope.
//
//   system prompt — the AGENTS.md/CLAUDE.md discovery prompt keys off the
//   session's working directory, so an enterprise session passes `undefined`
//   and personal context files never reach the model (Pi and Claude alike).
//
//   Claude SDK — an enterprise session spawns with `settingSources: []`
//   (isolation mode) so the SDK never loads the user's personal settings
//   cascade, and spawns from the session's OWN store directory — never from
//   a persisted sdkCwd or a parent fork's personal path.
//
// Personal sessions keep every behavior byte-for-byte.

const MARKER = 'POO205C7B-AGENTS-MARKER'
const CLAUDE_MARKER = 'POO205C7B-CLAUDE-MARKER'

const accountA = 'acc-c7b-backend'
const enterpriseSpaceId = 'space-ent-c7b-backend'
const personalSpaceId = 'space-personal-c7b-backend'

function seedKindReader(kind: 'enterprise' | 'personal' | null): void {
  setEnterpriseSessionKindReaderForTests((accountId, productSpaceId) => {
    if (accountId !== accountA) return null
    if (productSpaceId === enterpriseSpaceId) return kind === 'enterprise' ? 'enterprise' : null
    if (productSpaceId === personalSpaceId) return kind === 'personal' ? 'personal' : null
    return null
  })
}

const agents: Array<{ destroy(): void }> = []
function track<T extends { destroy(): void }>(agent: T): T {
  agents.push(agent)
  return agent
}

describe('enterprise sessions never read personal scope (POO-205 C7b)', () => {
  let tmpRoot: string
  let sessionDir: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'c7b-backend-'))
    sessionDir = join(tmpRoot, 'session-store')
    mkdirSync(sessionDir, { recursive: true })
    // Personal-looking context files in the personal working directory.
    writeFileSync(join(tmpRoot, 'AGENTS.md'), `# agents\n${MARKER}\n`)
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), `# claude\n${CLAUDE_MARKER}\n`)
    seedKindReader('enterprise')
  })

  afterEach(() => {
    for (const agent of agents.splice(0)) agent.destroy()
    rmSync(tmpRoot, { recursive: true, force: true })
    setEnterpriseSessionKindReaderForTests(null)
  })

  // ------------------------------------------------------------------
  // BaseAgent.isEnterpriseSession — the one predicate every branch uses
  // ------------------------------------------------------------------

  describe('isEnterpriseSession predicate', () => {
    function testAgent(session: Record<string, unknown>): TestAgent {
      return new TestAgent(createMockBackendConfig({
        session: createMockSession(session as never),
      }))
    }

    it('a project binding alone makes the session enterprise', () => {
      expect(testAgent({ id: 's1', projectId: 'proj-1' })['isEnterpriseSession']()).toBe(true)
    })

    it('an enterprise committed space makes the session enterprise', () => {
      expect(testAgent({ id: 's2', productSpaceId: enterpriseSpaceId, accountId: accountA })['isEnterpriseSession']()).toBe(true)
    })

    it('a personal committed space does NOT', () => {
      seedKindReader('personal')
      expect(testAgent({ id: 's3', productSpaceId: personalSpaceId, accountId: accountA })['isEnterpriseSession']()).toBe(false)
    })

    it('no space binding at all does NOT (plain personal session)', () => {
      expect(testAgent({ id: 's4' })['isEnterpriseSession']()).toBe(false)
    })
  })

  // ------------------------------------------------------------------
  // AGENTS.md / CLAUDE.md discovery — Pi and Claude both cut
  // ------------------------------------------------------------------

  describe('working-directory context files (AGENTS.md / CLAUDE.md)', () => {
    it('Claude: a personal session discovers the personal context files', () => {
      const agent = track(new ClaudeAgent({
        ...createMockBackendConfig({
          workspace: createMockWorkspace(),
          session: createMockSession({ id: 'claude-personal', workingDirectory: tmpRoot } as never),
        }),
        sessionCallbackOwnerToken: 'c7b-backend-owner',
      } as never))
      const prompt = (agent as unknown as { buildPresetAppendSystemPrompt(): string }).buildPresetAppendSystemPrompt()
      // The discovery prompt injects the FILE LIST (never the content): the
      // personal directory identity is what reaches the model.
      expect(prompt).toContain(`<project_context_files working_directory="${tmpRoot}">`)
      expect(prompt).toContain('AGENTS.md')
      expect(prompt).toContain('CLAUDE.md')
    })

    it('Claude: an enterprise session does NOT discover them, even with a personal workingDirectory on the record', () => {
      const agent = track(new ClaudeAgent({
        ...createMockBackendConfig({
          workspace: createMockWorkspace(),
          session: createMockSession({
            id: 'claude-ent',
            workingDirectory: tmpRoot, // a pre-C7b header could still carry it
            projectId: 'proj-1',
            projectContext: { name: 'Enterprise Project', instructions: 'Use the project instructions.' },
          } as never),
        }),
        sessionCallbackOwnerToken: 'c7b-backend-owner',
      } as never))
      const prompt = (agent as unknown as { buildPresetAppendSystemPrompt(): string }).buildPresetAppendSystemPrompt()
      // The base preset mentions the tag prose-style; only an ACTUAL injection
      // carries the working_directory attribute form.
      expect(prompt).not.toContain('<project_context_files working_directory=')
      expect(prompt).not.toContain(tmpRoot)
      // The project identity block is still there — that is the session's OWN context.
      expect(prompt).toContain('<project_context>')
      expect(prompt).toContain('Enterprise Project')
    })

    it('Pi: a personal session discovers the personal context files', () => {
      const prompt = getSystemPrompt(
        undefined,
        undefined,
        '/test/workspace',
        tmpRoot, // personal session working directory
        undefined,
        'Polo AI Backend',
        false,
      )
      expect(prompt).toContain(`<project_context_files working_directory="${tmpRoot}">`)
      expect(prompt).toContain('AGENTS.md')
      expect(prompt).toContain('CLAUDE.md')
    })

    it('Pi: an enterprise session passes NO working directory, so nothing is discovered', () => {
      // Mirrors pi-agent chatImpl after C7b: the argument reads as absent.
      const prompt = getSystemPrompt(
        undefined,
        undefined,
        '/test/workspace',
        undefined,
        undefined,
        'Polo AI Backend',
        false,
      )
      expect(prompt).not.toContain('<project_context_files working_directory=')
      expect(prompt).not.toContain(tmpRoot)
    })

    it('Pi: the subprocess spawns in the session store directory for an enterprise session', () => {
      const agent = track(new PiAgent(createMockBackendConfig({
        provider: 'pi',
        workspace: createMockWorkspace(),
        session: createMockSession({ id: 'pi-ent', projectId: 'proj-1', workingDirectory: tmpRoot } as never),
        sessionDir,
      })))
      const cwd = (agent as unknown as { resolvedCwd(): string }).resolvedCwd()
      expect(cwd).toBe(sessionDir)
    })

    it('Pi: a personal session keeps its configured working directory as the subprocess cwd', () => {
      const agent = track(new PiAgent(createMockBackendConfig({
        provider: 'pi',
        workspace: createMockWorkspace(),
        session: createMockSession({ id: 'pi-personal', workingDirectory: tmpRoot } as never),
        sessionDir,
      })))
      const cwd = (agent as unknown as { resolvedCwd(): string }).resolvedCwd()
      expect(cwd).toBe(tmpRoot)
    })
  })

  // ------------------------------------------------------------------
  // Claude SDK — isolation mode + spawn cwd
  // ------------------------------------------------------------------

  describe('Claude SDK invocation options', () => {
    function claude(session: Record<string, unknown>): ClaudeAgent {
      return track(new ClaudeAgent({
        ...createMockBackendConfig({
          workspace: createMockWorkspace(),
          session: createMockSession(session as never),
        }),
        sessionCallbackOwnerToken: 'c7b-backend-owner',
      } as never))
    }

    it('an enterprise session gets settingSources: [] (SDK isolation mode)', () => {
      const overrides = (claude({ id: 'sdk-ent', projectId: 'proj-1' }) as unknown as {
        enterpriseSdkOptionOverrides(): Record<string, unknown>
      }).enterpriseSdkOptionOverrides()
      expect(overrides.settingSources).toEqual([])
    })

    it('a personal session gets NO overrides (byte-for-byte today behavior)', () => {
      const overrides = (claude({ id: 'sdk-personal' }) as unknown as {
        enterpriseSdkOptionOverrides(): Record<string, unknown>
      }).enterpriseSdkOptionOverrides()
      expect(Object.keys(overrides).length).toBe(0)
    })

    it('an enterprise session spawns from the session store directory even with a personal sdkCwd on the record', () => {
      const agent = track(new ClaudeAgent({
        ...createMockBackendConfig({
          workspace: createMockWorkspace(),
          session: createMockSession({ id: 'cwd-ent', projectId: 'proj-1', sdkCwd: tmpRoot } as never),
          // The session layer reports the store directory through the storage
          // seam; here it maps to a REAL directory so the existence check passes.
          sessionStorage: { getSessionPath: () => sessionDir } as never,
        }),
        sessionCallbackOwnerToken: 'c7b-backend-owner',
      } as never))
      const cwd = (agent as unknown as {
        resolveSpawnCwd(input: { isRetry: boolean; sessionId: string | null }): string
      }).resolveSpawnCwd({ isRetry: false, sessionId: 'cwd-ent' })
      expect(cwd).toBe(sessionDir)
    })

    it('a personal session keeps the sdkCwd candidate (unchanged behavior)', () => {
      const agent = claude({ id: 'cwd-personal', sdkCwd: tmpRoot } as never)
      const cwd = (agent as unknown as {
        resolveSpawnCwd(input: { isRetry: boolean; sessionId: string | null }): string
      }).resolveSpawnCwd({ isRetry: false, sessionId: 'cwd-personal' })
      expect(cwd).toBe(tmpRoot)
    })
  })

  // ------------------------------------------------------------------
  // spawn_session help — no personal data sources
  // ------------------------------------------------------------------

  describe('spawn_session help source list', () => {
    it('an enterprise session lists NO sources; a personal session lists the workspace ones', () => {
      const sourceDir = join(tmpRoot, 'sources', 'c7b-personal-src')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
        id: 'c7b-src-1',
        name: 'C7B Personal Source',
        slug: 'c7b-personal-src',
        enabled: true,
        provider: 'test',
        type: 'local',
      }))
      expect(existsSync(join(sourceDir, 'config.json'))).toBe(true)

      const enterprise = new TestAgent(createMockBackendConfig({
        workspace: createMockWorkspace({ rootPath: tmpRoot }),
        session: createMockSession({ id: 'help-ent', projectId: 'proj-1' } as never),
      }))
      const enterpriseHelp = (enterprise as unknown as { getSpawnSessionHelp(): { sources: unknown[] } }).getSpawnSessionHelp()
      expect(enterpriseHelp.sources.length).toBe(0)

      const personal = new TestAgent(createMockBackendConfig({
        workspace: createMockWorkspace({ rootPath: tmpRoot }),
        session: createMockSession({ id: 'help-personal' } as never),
      }))
      const personalHelp = (personal as unknown as { getSpawnSessionHelp(): { sources: unknown[] } }).getSpawnSessionHelp()
      expect(personalHelp.sources.length).toBe(1)
    })
  })
})
