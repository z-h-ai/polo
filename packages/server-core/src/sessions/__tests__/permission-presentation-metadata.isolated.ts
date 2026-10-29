/**
 * POO-179 permission presentation metadata — server-core side.
 *
 * Proves the REAL guarded `agent.onPermissionRequest` wiring (guard inventory +
 * trusted-scope assert) forwards the agent-originated `canRememberForSession`
 * presentation metadata to the renderer event verbatim for true/false/missing,
 * that a stale origin publishes nothing, and that the response path gains NO
 * renderer-supplied presentation capability (`PermissionResponseOptions`
 * unchanged, no grant/remember behavior change).
 */
import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { setRuntimeActiveProductSpace, setRuntimeActiveProductSpaceAccount } = await import('../../runtime/product-space-executions')
const { setSyncTrustedProductSpaceAccountId, setTrustedProductSpaceAccountProvider } = await import('../../handlers/rpc/trusted-product-space-account')
const { SessionManager, createManagedSession } = await import('../SessionManager.ts')

const TEST_ACCOUNT_ID = 'account-poo179'
const TEST_SPACE_ID = 'space-poo179'

type PermissionRequestPayload = {
  requestId: string
  toolName: string
  command?: string
  description: string
  type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval' | 'browser_action'
  canRememberForSession?: boolean
  [key: string]: unknown
}

describe('POO-179 permission presentation metadata (server-core side)', () => {
  let tmpRoot: string
  let sm: InstanceType<typeof import('../SessionManager').SessionManager>
  let events: Array<Record<string, unknown>>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-poo179-perm-'))
    sm = new SessionManager()
    events = []
    setSyncTrustedProductSpaceAccountId(TEST_ACCOUNT_ID)
    setRuntimeActiveProductSpaceAccount(TEST_ACCOUNT_ID)
    setRuntimeActiveProductSpace(TEST_SPACE_ID)
    setTrustedProductSpaceAccountProvider(async () => TEST_ACCOUNT_ID)
    sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event)
    }) as never)
  })

  afterEach(() => {
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.clear()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    setRuntimeActiveProductSpace(null)
    setRuntimeActiveProductSpaceAccount(null)
    setSyncTrustedProductSpaceAccountId(null)
  })

  function buildWorkspace() {
    return {
      id: 'ws_poo179',
      name: 'Poo179 Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    } as never
  }

  function seedManaged(sessionId: string, agent?: { respondToPermission: (requestId: string, allowed: boolean, alwaysAllow: boolean) => void }) {
    const managed = createManagedSession(
      { id: sessionId, name: 'poo179 perm session', createdAt: Date.now() },
      buildWorkspace(),
      { productSpaceId: TEST_SPACE_ID, accountId: TEST_ACCOUNT_ID },
    )
    if (agent) {
      ;(managed as unknown as { agent: unknown }).agent = agent
    }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    return managed
  }

  /** Install the SAME guarded wiring production uses (guard inventory + scope assert). */
  function installGuardedPermissionHandler(managed: ReturnType<typeof createManagedSession>) {
    const handler = (request: PermissionRequestPayload) => {
      ;(sm as unknown as {
        handleAgentPermissionRequest: (managed: unknown, request: PermissionRequestPayload) => void
      }).handleAgentPermissionRequest(managed, request)
    }
    return (sm as unknown as {
      guardManagedCallback: (managed: unknown, name: string, fn: (request: PermissionRequestPayload) => void) => (request: PermissionRequestPayload) => void
    }).guardManagedCallback(managed, 'agent.onPermissionRequest', handler)
  }

  function publishedPermissionRequests(): PermissionRequestPayload[] {
    return events
      .filter((event) => event.type === 'permission_request')
      .map((event) => event.request as PermissionRequestPayload)
  }

  it('forwards canRememberForSession true/false/missing verbatim and keeps every other request field intact', () => {
    const managed = seedManaged('poo179-perm-forward')
    const guarded = installGuardedPermissionHandler(managed)

    const baseRequest = {
      requestId: 'perm-poo179-1',
      toolName: 'Bash',
      command: 'npm run build',
      description: 'Execute: npm run build',
      type: 'bash' as const,
    }
    guarded({ ...baseRequest, canRememberForSession: true })
    guarded({ ...baseRequest, requestId: 'perm-poo179-2', canRememberForSession: false })
    guarded({ ...baseRequest, requestId: 'perm-poo179-3' })

    const published = publishedPermissionRequests()
    expect(published).toHaveLength(3)
    expect(published[0]!.canRememberForSession).toBe(true)
    expect(published[1]!.canRememberForSession).toBe(false)
    expect('canRememberForSession' in published[2]!).toBe(false)

    // Payload invariance: the spread adds only the session id, never rewrites
    // or drops agent-originated fields.
    const { canRememberForSession, ...rest } = published[0]!
    expect(canRememberForSession).toBe(true)
    expect(rest).toEqual({ ...baseRequest, sessionId: managed.id })
    expect(published[2]!.sessionId).toBe(managed.id)
  })

  it('a stale/out-of-trust origin publishes nothing and registers no pending request', () => {
    const managed = seedManaged('poo179-perm-stale')
    const guarded = installGuardedPermissionHandler(managed)

    // Drop the trusted runtime scope: the guard must fail closed before the
    // handler body runs (no event, no pending entry).
    setRuntimeActiveProductSpace(null)
    try {
      expect(() =>
        guarded({ requestId: 'perm-poo179-stale', toolName: 'Bash', description: 'x', canRememberForSession: true }),
      ).toThrow()
    } finally {
      setRuntimeActiveProductSpace(TEST_SPACE_ID)
    }

    expect(publishedPermissionRequests()).toHaveLength(0)
    expect(
      (sm as unknown as { pendingPermissionRequests: Map<string, unknown> }).pendingPermissionRequests.has('perm-poo179-stale'),
    ).toBe(false)
  })

  it('respond gains no renderer-supplied presentation capability: extra option keys are ignored and grant behavior is unchanged', () => {
    const respondCalls: Array<[string, boolean, boolean]> = []
    const managed = seedManaged('poo179-perm-respond', {
      respondToPermission: (requestId, allowed, alwaysAllow) => {
        respondCalls.push([requestId, allowed, alwaysAllow])
      },
    })
    const guarded = installGuardedPermissionHandler(managed)
    guarded({
      requestId: 'perm-poo179-resp',
      toolName: 'Bash',
      command: 'npm run build',
      description: 'Execute: npm run build',
      type: 'bash',
      canRememberForSession: true,
    })
    expect(publishedPermissionRequests()).toHaveLength(1)

    // A renderer self-reporting "canRememberForSession" in the response options
    // must not change what the agent is told: only (allowed, alwaysAllow) pass.
    const delivered = sm.respondToPermission(
      managed.id,
      'perm-poo179-resp',
      true,
      true,
      { canRememberForSession: true } as never,
    )
    expect(delivered).toBe(true)
    expect(respondCalls).toEqual([['perm-poo179-resp', true, true]])
  })
})
