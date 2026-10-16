import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { RootedSessionStorage } from '@polo-ai/shared/sessions'
import { processIdentityMatches } from '@polo-ai/shared/utils'
import type { LlmConnection, Workspace } from '@polo-ai/shared/config'
import { assertOwnedCliConnection, type CliConnectionProvenance } from '@polo-ai/shared/config'

export interface CliExecutionBootstrap {
  threadId: string
  /** Explicit parent-owned local discovery root; never an enterprise Skill grant. */
  globalSkillsRoot?: string
  threadRoot: string
  sessionsRoot: string
  controlledRoot: string
  workspace: Workspace
  expectedSessionId?: string
  origin: 'cli-exec' | 'cli-run'
  connection?: LlmConnection
  connectionProvenance?: CliConnectionProvenance
}
export interface CliExecutionOwner {
  pid: number
  ownerFile: string
  leaseId: string
  processIdentity: string
}

/** Future managed brokers must mint a separate, verified admission authority.
 * A profile, origin, RPC argument or managedBy value cannot select authority. */
export interface CliExecutionBroker {
  admit(bootstrap: CliExecutionBootstrap, owner: CliExecutionOwner): CliExecutionAuthority
}

// Explicit local execution callback inventory. Cross-session/business/browser
// operations deliberately have no permission in this authority.
const LOCAL_CALLBACKS = new Set([
  'backend.assertExecutionCurrent', 'backend.onSdkSessionIdUpdate', 'backend.onSdkSessionIdCleared',
  'backend.onBranchForkInvalidated', 'backend.getRecoveryMessages',
  'backend.getBranchFallbackMessages', 'backend.getBranchSeedMessages',
  'backend.markBranchSeedApplied', 'backend.getTransferredSessionSummary',
  'backend.markTransferredSessionSummaryApplied', 'backend.onImageResize',
  'backend.canonicalSkills.allowLocalSkills', 'backend.canonicalSkills.load',
  'backend.canonicalSkills.authorize', 'agent.queryLlm', 'agent.onDebug',
  'agent.onBackendAuthRequired', 'agent.onPermissionRequest',
  'agent.onPermissionModeChange', 'agent.onPlanSubmitted', 'agent.onAuthRequest',
  'agent.onQuestionRequested', 'getTurnGeneration', 'queryFn',
  'onPlanSubmitted', 'onAuthRequest', 'onQuestionRequested',
])

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child)
    Object.freeze(value)
  }
  return value
}

/** Constructed only from the validated parent pipe before the RPC listener.
 * Revocation is monotonic. All RPC/callback/event paths consult this object. */
export class CliExecutionAuthority {
  readonly bootstrap: Readonly<CliExecutionBootstrap>
  readonly owner: Readonly<CliExecutionOwner>
  private active = true
  private sessionId?: string
  private clientId?: string
  private creating = false
  private constructor(bootstrap: CliExecutionBootstrap, owner: CliExecutionOwner, readonly storage: RootedSessionStorage) {
    this.bootstrap = freezeTree(structuredClone(bootstrap))
    this.owner = Object.freeze({ ...owner })
    this.sessionId = bootstrap.expectedSessionId
  }

  static fromParent(bootstrap: CliExecutionBootstrap, owner: CliExecutionOwner): CliExecutionAuthority {
    const fail = () => { throw new Error('CLI_EXECUTION_BOOTSTRAP_REJECTED') }
    if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || process.ppid !== owner.pid
      || !owner.leaseId || !owner.processIdentity || !processIdentityMatches(owner.pid, owner.processIdentity)) fail()
    for (const path of [bootstrap.controlledRoot, bootstrap.threadRoot, bootstrap.sessionsRoot, bootstrap.workspace?.rootPath, owner.ownerFile]) {
      if (!path || !isAbsolute(path) || resolve(path) !== path) fail()
    }
    if (bootstrap.globalSkillsRoot && (!isAbsolute(bootstrap.globalSkillsRoot) || resolve(bootstrap.globalSkillsRoot) !== bootstrap.globalSkillsRoot)) fail()
    if (!bootstrap.threadId || !bootstrap.workspace.id || !['cli-run', 'cli-exec'].includes(bootstrap.origin)
      || bootstrap.sessionsRoot !== join(bootstrap.threadRoot, 'sessions')
      || bootstrap.workspace.rootPath !== join(bootstrap.threadRoot, 'config-snapshot')
      || owner.ownerFile !== join(bootstrap.threadRoot, 'owner.json')) fail()
    assertOwnedCliConnection(bootstrap.connection, bootstrap.connectionProvenance)
    const storage = new RootedSessionStorage(bootstrap.sessionsRoot, { controlledRoot: bootstrap.controlledRoot })
    for (const path of [bootstrap.threadRoot, bootstrap.workspace.rootPath, owner.ownerFile]) storage.assertSafeFilePath(path, false)
    storage.assertSafeFilePath(join(bootstrap.threadRoot, 'thread.json'), false)
    const metadata = JSON.parse(readFileSync(join(bootstrap.threadRoot, 'thread.json'), 'utf8'))
    if (metadata.threadId !== bootstrap.threadId || metadata.origin !== bootstrap.origin || metadata.mainSessionId !== bootstrap.expectedSessionId) fail()
    if (bootstrap.threadRoot !== join(bootstrap.controlledRoot, metadata.configurationScopeId, 'executions', bootstrap.threadId)) fail()
    assertOwnedCliConnection(metadata.connection, metadata.connection?.provenance)
    const authority = new CliExecutionAuthority(bootstrap, owner, storage)
    authority.assertActive()
    return authority
  }

  revoke(): void { this.active = false }

  assertActive(): void {
    try {
      if (!this.active || process.ppid !== this.owner.pid) throw new Error()
      this.storage.assertSafeFilePath(this.owner.ownerFile, false)
      this.storage.assertSafeFilePath(this.bootstrap.workspace.rootPath, false)
      const owner = JSON.parse(readFileSync(this.owner.ownerFile, 'utf8'))
      if (owner.leaseId !== this.owner.leaseId || owner.cliPid !== this.owner.pid
        || owner.cliProcessIdentity !== this.owner.processIdentity) throw new Error()
    } catch { this.revoke(); throw new Error('CLI_EXECUTION_OWNER_REVOKED') }
  }

  assertClient(workspaceId: string | null, clientId: string): void {
    this.assertActive()
    if (workspaceId !== this.bootstrap.workspace.id || (this.clientId && clientId !== this.clientId)) throw new Error('CLI_EXECUTION_SCOPE_REQUIRED')
    this.clientId ??= clientId
  }
  get eventClientId(): string | undefined { return this.clientId }
  get rootSessionId(): string | undefined { return this.sessionId }
  beginCreate(): void {
    this.assertActive()
    if (this.sessionId || this.creating) throw new Error('CLI_ROOT_SESSION_ALREADY_BOUND')
    this.creating = true
  }
  bindCreated(sessionId: string): void {
    this.assertActive()
    if (!this.creating || this.sessionId) throw new Error('CLI_ROOT_SESSION_ALREADY_BOUND')
    this.storage.getSessionPath(this.bootstrap.workspace.rootPath, sessionId)
    this.sessionId = sessionId
  }
  assertSession(sessionId: string): void {
    this.assertActive()
    if (!sessionId || sessionId !== this.sessionId) throw new Error('CLI_EXECUTION_SESSION_REQUIRED')
    this.storage.getSessionPath(this.bootstrap.workspace.rootPath, sessionId)
  }
  assertConnection(connection: LlmConnection | null | undefined): void {
    this.assertActive()
    assertOwnedCliConnection(connection, this.bootstrap.connectionProvenance)
    if (!connection || connection.slug !== this.bootstrap.connection?.slug) throw new Error('CLI_EXECUTION_CONNECTION_REQUIRED')
  }
  assertCallback(sessionId: string, name: string): void {
    this.assertSession(sessionId)
    // Registry names use exactly the trusted session prefix, not a substring.
    const normalized = name.startsWith(`${sessionId}.`) ? name.slice(sessionId.length + 1) : name
    if (!LOCAL_CALLBACKS.has(normalized)) throw new Error(`CLI_CALLBACK_UNSUPPORTED (${normalized})`)
  }
}

/** Server composition chooses this trusted broker, never an RPC/profile field. */
export const ownedCliExecutionBroker: CliExecutionBroker = {
  admit: (bootstrap, owner) => CliExecutionAuthority.fromParent(bootstrap, owner),
}
