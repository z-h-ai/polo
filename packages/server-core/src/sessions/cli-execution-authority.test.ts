import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProcessBirthIdentity } from '@polo-ai/shared/utils'
import { CliExecutionAuthority } from './cli-execution-authority'
import { SessionManager } from './SessionManager'
import { getSessionScopedToolCallbackGuard } from '@polo-ai/shared/agent/session-scoped-tool-callback-registry'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'polo-policy-'))
  const threadRoot = join(root, 'global', 'executions', 'thread')
  const snapshot = join(threadRoot, 'config-snapshot')
  mkdirSync(snapshot, { recursive: true })
  mkdirSync(join(threadRoot, 'sessions'))
  const ownerFile = join(threadRoot, 'owner.json')
  const owner = { pid: process.ppid, ownerFile, leaseId: 'lease', processIdentity: getProcessBirthIdentity(process.ppid)! }
  writeFileSync(ownerFile, JSON.stringify({ cliPid: owner.pid, cliProcessIdentity: owner.processIdentity, leaseId: owner.leaseId }))
  writeFileSync(join(threadRoot, 'thread.json'), JSON.stringify({ threadId: 'thread', origin: 'cli-exec', configurationScopeId: 'global', mainSessionId: 'root-session' }))
  const workspace = { id: 'global', slug: 'global', name: 'Global', rootPath: snapshot, createdAt: 0 }
  const bootstrap = { threadId: 'thread', threadRoot, sessionsRoot: join(threadRoot, 'sessions'), controlledRoot: root, workspace, origin: 'cli-exec' as const, expectedSessionId: 'root-session', connection: { slug: 'owned', name: 'Owned', providerType: 'pi' as const, authType: 'api_key' as const, createdAt: 0 } }
  const authority = CliExecutionAuthority.fromParent(bootstrap, owner)
  return { root, ownerFile, owner, bootstrap, authority, close: () => rmSync(root, { recursive: true, force: true }) }
}

test('CLI callback and registry guards share owner, generation and exact operation policy; events revoke with it', () => {
  const f = fixture()
  try {
    f.authority.assertClient('global', 'client')
    const manager = new SessionManager({ profile: 'cli-one-shot', workspace: f.bootstrap.workspace, sessionStorage: f.authority.storage, cliAuthority: f.authority }) as any
    const managed = { id: 'root-session', workspace: f.bootstrap.workspace, runtimeOwnerToken: 'generation-1' }
    manager.sessions.set(managed.id, managed)
    let called = 0
    const callback = manager.guardManagedCallback(managed, 'agent.onDebug', () => ++called)
    manager.installManagedSessionCallbackGuard(managed)
    const registry = getSessionScopedToolCallbackGuard(managed.id)!
    expect(callback()).toBe(1)
    expect(() => registry(`${managed.id}.queryFn`)).not.toThrow()
    expect(() => registry(`${managed.id}.spawnSessionFn`)).toThrow('CLI_CALLBACK_UNSUPPORTED')
    expect(() => registry(`foreign.${managed.id}.queryFn`)).toThrow('CLI_CALLBACK_UNSUPPORTED')
    const pushed: any[] = []
    manager.setEventSink((...args: any[]) => pushed.push(args))
    manager.sendEvent({ type: 'complete', sessionId: managed.id }, 'global')
    expect(pushed.length).toBe(1)
    manager.queueDelta(managed.id, 'global', 'old', 'turn')
    managed.runtimeOwnerToken = 'generation-2'
    expect(callback).toThrow('CLI_EXECUTION_GENERATION_REVOKED')
    expect(() => registry(`${managed.id}.queryFn`)).toThrow('CLI_EXECUTION_GENERATION_REVOKED')
    manager.flushDelta(managed.id, 'global')
    expect(pushed.length).toBe(1)
    const replacement: typeof managed & { productSpaceId?: string } = { ...managed }
    manager.sessions.set(managed.id, replacement)
    expect(callback).toThrow('CLI_EXECUTION_GENERATION_REVOKED')
    replacement.productSpaceId = 'business'
    expect(() => manager.assertCliSessionOwned(managed.id)).toThrow('CLI_EXECUTION_SESSION_REQUIRED')
    delete replacement.productSpaceId
    f.authority.revoke()
    manager.sendEvent({ type: 'complete', sessionId: managed.id }, 'global')
    expect(pushed.length).toBe(1)
    expect(() => manager.guardManagedCallback(replacement, 'agent.onDebug', () => 1)()).toThrow('CLI_EXECUTION_OWNER_REVOKED')
    expect(called).toBe(1)
  } finally { f.close() }
})

test('profile and cli origin alone grant neither callbacks nor events', () => {
  const manager = new SessionManager({ profile: 'cli-one-shot' }) as any
  const managed = { id: 'untrusted', origin: 'cli-exec', runtimeOwnerToken: 'forged', workspace: { id: 'global' } }
  manager.sessions.set(managed.id, managed)
  expect(manager.guardManagedCallback(managed, 'agent.onDebug', () => true)).toThrow('SESSION_OUT_OF_TRUSTED_SCOPE')
  expect(() => manager.assertCliSessionOwned(managed.id)).toThrow('CLI_EXECUTION_AUTHORITY_REQUIRED')
})

test('lease replacement revokes monotonically, symlink roots and managed history fail closed', () => {
  const f = fixture()
  try {
    writeFileSync(f.ownerFile, JSON.stringify({ leaseId: 'successor' }))
    expect(() => f.authority.assertSession('root-session')).toThrow('CLI_EXECUTION_OWNER_REVOKED')
    writeFileSync(f.ownerFile, JSON.stringify({ cliPid: f.owner.pid, cliProcessIdentity: f.owner.processIdentity, leaseId: f.owner.leaseId }))
    expect(() => f.authority.assertSession('root-session')).toThrow('CLI_EXECUTION_OWNER_REVOKED')
    expect(() => CliExecutionAuthority.fromParent({ ...f.bootstrap, connectionProvenance: { kind: 'managed' } }, f.owner)).toThrow('CLI_MANAGED_CONTEXT_REQUIRED')
    rmSync(f.bootstrap.workspace.rootPath, { recursive: true })
    symlinkSync(tmpdir(), f.bootstrap.workspace.rootPath)
    expect(() => CliExecutionAuthority.fromParent(f.bootstrap, f.owner)).toThrow('symlink')
  } finally { f.close() }
})

test('an async core callback cannot return a result after its generation is replaced', async () => {
  const f = fixture()
  try {
    const manager = new SessionManager({ profile: 'cli-one-shot', workspace: f.bootstrap.workspace, sessionStorage: f.authority.storage, cliAuthority: f.authority }) as any
    const managed = { id: 'root-session', workspace: f.bootstrap.workspace, runtimeOwnerToken: 'original' }
    manager.sessions.set(managed.id, managed)
    let resume!: () => void
    const pending = new Promise<void>(resolve => { resume = resolve })
    const callback = manager.guardManagedCallback(managed, 'agent.queryLlm', async () => { await pending; return 'late result' })
    const result = callback()
    managed.runtimeOwnerToken = 'successor'
    resume()
    await expect(result).rejects.toThrow('CLI_EXECUTION_GENERATION_REVOKED')
  } finally { f.close() }
})

for (const replacement of ['token', 'map'] as const) {
  for (const event of ['tool_start', 'terminal'] as const) {
    test(`CLI ${event} continuation rejects ${replacement} replacement across await`, async () => {
      const f = fixture()
      try {
        f.authority.assertClient('global', 'client')
        const manager = new SessionManager({ profile: 'cli-one-shot', workspace: f.bootstrap.workspace, sessionStorage: f.authority.storage, cliAuthority: f.authority }) as any
        const managed = { id: 'root-session', workspace: f.bootstrap.workspace, runtimeOwnerToken: 'original', messages: [], messageQueue: [], isProcessing: true }
        manager.sessions.set(managed.id, managed)
        manager.monotonic = () => 1
        manager.setProcessing = () => {}
        manager.isSessionBeingViewed = () => false
        manager.getLastFinalAssistantMessageId = () => undefined
        manager.persistSession = () => { throw new Error('stale persistence') }
        let resume!: () => void
        const barrier = new Promise<void>(r => { resume = r })
        manager.getBrowserPaneManagerForSession = () => event === 'terminal' ? { clearVisualsForSession: () => barrier, unbindAllForSession() {} } : undefined
        const pushed: unknown[] = []
        manager.setEventSink((...args: unknown[]) => pushed.push(args))
        const pending = event === 'terminal'
          ? manager.onProcessingStopped(managed.id, 'complete')
          : manager.processEvent(managed, { type: 'tool_start', toolName: 'Read', toolUseId: 'old-tool', input: { file_path: '/tmp/old-runtime-data' } })
        if (replacement === 'map') manager.sessions.set(managed.id, { ...managed, runtimeOwnerToken: 'successor', messages: [] })
        else managed.runtimeOwnerToken = 'successor'
        resume()
        await pending.catch((error: Error) => { expect(error.message).toContain('CLI_EXECUTION_GENERATION_REVOKED') })
        expect(pushed).toHaveLength(0)
        expect(managed.messages).toHaveLength(0)
      } finally { f.close() }
    })
  }
}
