import { afterEach, afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { KbCollection, KbCollectionList, KbDocumentSummary } from '@polo-ai/shared/protocol'
import type { HandlerFn, RpcServer, RequestContext } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import type { ISessionManager } from '../../session-manager-interface'
import * as realCredentials from '@polo-ai/shared/credentials'
import {
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
  setRuntimeOfflineReadOnly,
  setRuntimeProductSpaceRestricted,
} from '../../../runtime/product-space-executions'
import {
  captureCompleteTrustedSessionScopeToken,
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../trusted-product-space-account'
import {
  registerKnowledgeBaseHandlers,
  resolveSessionKbReferences,
  resetKbActiveProductSpaceReaderForTests,
  resetKbSendResolveTimeoutForTests,
  setKbActiveProductSpaceReaderForTests,
  setKbSendResolveTimeoutForTests,
} from '../knowledge-base'
import {
  isCollectionPublished,
  kbCollectionUri,
  kbDocumentUri,
  readAudit,
  searchDocuments,
  KB_SERVICE_UNAVAILABLE_MESSAGE,
  type KbOpenVikingSpace,
  type KbSpaceBinding,
} from '../../../knowledge-base/store'
import { kbTenantAccountId, kbTenantAuth, readKbTenantCredential } from '../../../knowledge-base/tenant'
import { readOpenVikingConfig, resetOpenVikingTimeoutsForTests, setOpenVikingTimeoutsForTests } from '../../../knowledge-base/openviking-client'
import { FakeOpenVikingServer } from '../../../knowledge-base/__tests__/fake-openviking-server'

/**
 * RPC-surface tests for the enterprise knowledge base (POO-108 v3.1): scope
 * enforcement, enterprise isolation, the list/session contracts, the document
 * lifecycle over the REMOTE tenant and the send-time discipline. The storage
 * backend is the in-memory fake (`fake-openviking-server.ts`) — the tests
 * assert the neutral wire behavior, never the vendor's shapes.
 */

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = 'ws-one'
const SPACE_ID = 'ps-one'
const ENTERPRISE_ID = 'ent-one'
const ROOT_KEY = 'ok-root-key-kb-rpc-tests'

/**
 * The tenant credential is read through the shared CredentialManager
 * singleton, which no test can reach into — the module is retargeted with a
 * pass-through mock: when no fake is installed (any other test file in this
 * bun process) calls keep hitting the REAL manager.
 */
class FakeCredentialManager {
  private readonly entries = new Map<string, string>()

  async get(id: { type: string; name: string }): Promise<{ value: string } | null> {
    const value = this.entries.get(`${id.type}:${id.name}`)
    return value === undefined ? null : { value }
  }

  async set(id: { type: string; name: string }, credential: { value: string }): Promise<void> {
    this.entries.set(`${id.type}:${id.name}`, credential.value)
  }

  async delete(id: { type: string; name: string }): Promise<boolean> {
    return this.entries.delete(`${id.type}:${id.name}`)
  }

  async withExclusiveLease<T>(_scope: string, operation: () => Promise<T>): Promise<T> {
    return operation()
  }

  /** Simulates a fresh device: the cached binding is gone. */
  clear(): void {
    this.entries.clear()
  }
}

let credentialManagerOverride: FakeCredentialManager | null = null

mock.module('@polo-ai/shared/credentials', () => ({
  ...realCredentials,
  getCredentialManager: () => credentialManagerOverride ?? realCredentials.getCredentialManager(),
}))

function enterpriseSpace(
  role: 'owner' | 'manager' | 'member',
  overrides: { id?: string; enterpriseId?: string; accessMode?: 'active' | 'read_only' } = {},
) {
  return {
    id: overrides.id ?? SPACE_ID,
    kind: 'enterprise' as const,
    enterpriseId: overrides.enterpriseId ?? ENTERPRISE_ID,
    name: 'Example enterprise',
    role,
    accessMode: overrides.accessMode ?? ('active' as const),
    payer: { kind: 'enterprise' as const, enterpriseId: overrides.enterpriseId ?? ENTERPRISE_ID },
  }
}

let tempDir: string
let workspaceRoot: string

/** The fake backend every harness in this file talks to. */
const ov = FakeOpenVikingServer.start(ROOT_KEY)
afterAll(() => ov.stop())

/** The account id the D1 derivation produces for a space of this file's fixtures. */
function ovAccountId(productSpaceId: string, enterpriseId = ENTERPRISE_ID): string {
  return kbTenantAccountId({ productSpaceId, enterpriseId, spaceName: 'Example enterprise' })
}

const binding: KbSpaceBinding = { productSpaceId: SPACE_ID, enterpriseId: ENTERPRISE_ID }

interface HarnessOptions {
  role?: 'owner' | 'manager' | 'member'
  kind?: 'enterprise' | 'personal'
  accessMode?: 'active' | 'read_only'
  spaceId?: string
  enterpriseId?: string
}

function createHarness(options: HarnessOptions = {}) {
  const role = options.role ?? 'owner'
  const kind = options.kind ?? 'enterprise'
  const space = kind === 'enterprise'
    ? enterpriseSpace(role, {
        accessMode: options.accessMode,
        id: options.spaceId,
        enterpriseId: options.enterpriseId,
      })
    : {
        id: options.spaceId ?? SPACE_ID,
        kind: 'personal' as const,
        name: '我的空间',
        accessMode: 'active' as const,
        payer: { kind: 'account' as const },
      }
  // The active-space reader is module state — each harness pins it to its own
  // role/kind so two harnesses in one test see different identities. Like the
  // production reader it only answers for its OWN space id: a fence that has
  // moved to another space resolves to nothing.
  setKbActiveProductSpaceReaderForTests(
    (_accountId, productSpaceId) => (productSpaceId === space.id ? space : null) as never,
  )
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return null },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  // Session records carry the immutable scope triple — the KB session
  // boundaries compare them with the caller's trusted scope (review #2).
  interface SeedRecord {
    id: string
    accountId: string
    productSpaceId: string
    workspaceId: string
    kbCollectionIds: string[]
  }
  const records = new Map<string, SeedRecord>()
  const harnessSpaceId = space.id
  const harnessWorkspaceId = WORKSPACE_ID
  const ownRecord = (sessionId: string, kbCollectionIds: string[]): SeedRecord => ({
    id: sessionId,
    accountId: ACCOUNT_ID,
    productSpaceId: harnessSpaceId,
    workspaceId: harnessWorkspaceId,
    kbCollectionIds,
  })
  const sessionManager = {
    getWorkspaces: () => [{ id: WORKSPACE_ID, rootPath: workspaceRoot, name: 'Workspace One' }],
    getSessions: () => [...records.values()],
    getSession: async (sessionId: string) => records.get(sessionId),
    setSessionKbCollections: async (sessionId: string, collectionIds: string[]) => {
      const existing = records.get(sessionId)
      if (existing) existing.kbCollectionIds = collectionIds
      else records.set(sessionId, ownRecord(sessionId, collectionIds))
    },
  }
  const deps = {
    sessionManager,
    platform: { logger: { info: () => {}, warn: () => {}, error: () => {} } },
  } as unknown as HandlerDeps
  registerKnowledgeBaseHandlers(server, deps)
  const ctx = { clientId: 'client-1', workspaceId: WORKSPACE_ID, webContentsId: 1 } as unknown as RequestContext
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler for ${channel}`)
    return handler(ctx, ...args)
  }
  return {
    invoke,
    savedCollections: records,
    seedSession: (sessionId: string, kbCollectionIds: string[] = []) => {
      records.set(sessionId, ownRecord(sessionId, kbCollectionIds))
    },
    /** A session that exists but belongs to ANOTHER account/space/workspace. */
    seedForeignSession: (sessionId: string) => {
      records.set(sessionId, {
        id: sessionId,
        accountId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        productSpaceId: 'ps-foreign',
        workspaceId: 'ws-foreign',
        kbCollectionIds: [],
      })
    },
    sessionManager: sessionManager as unknown as ISessionManager,
  }
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'knowledge-base-rpc-'))
  workspaceRoot = join(tempDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  await ov.reset()
  credentialManagerOverride = new FakeCredentialManager()
  process.env.POLO_OPENVIKING_URL = ov.baseUrl
  process.env.POLO_OPENVIKING_ROOT_API_KEY = ROOT_KEY
  setRuntimeActiveProductSpace(SPACE_ID)
  setRuntimeActiveProductSpaceAccount(ACCOUNT_ID)
  setRuntimeOfflineReadOnly(false)
  setTrustedProductSpaceAccountProvider(async () => ACCOUNT_ID)
  setSyncTrustedProductSpaceAccountId(ACCOUNT_ID)
  setKbActiveProductSpaceReaderForTests(() => enterpriseSpace('owner') as never)
})

afterEach(() => {
  credentialManagerOverride = null
  resetKbActiveProductSpaceReaderForTests()
  resetKbSendResolveTimeoutForTests()
  resetOpenVikingTimeoutsForTests()
  setRuntimeProductSpaceRestricted(SPACE_ID, false)
  setRuntimeActiveProductSpace(null)
  setRuntimeActiveProductSpaceAccount(null)
  setRuntimeOfflineReadOnly(false)
  setTrustedProductSpaceAccountProvider(async () => null)
  setSyncTrustedProductSpaceAccountId(null)
  delete process.env.POLO_OPENVIKING_URL
  delete process.env.POLO_OPENVIKING_ROOT_API_KEY
  rmSync(tempDir, { recursive: true, force: true })
})

/** Creates a collection and uploads a draft document through the RPC layer. */
async function seedCollection(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  doc?: { title: string; content: string },
): Promise<{ collection: KbCollection; document: KbDocumentSummary | null }> {
  const collection = await invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
    workspaceId: WORKSPACE_ID, name: 'Handbook', description: 'Policies',
  }) as KbCollection
  let document: KbDocumentSummary | null = null
  if (doc) {
    document = await invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
      title: doc.title, content: doc.content,
    }) as KbDocumentSummary
  }
  return { collection, document }
}

async function publishDocument(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  document: KbDocumentSummary,
): Promise<void> {
  await invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
  await invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: document.id })
}

/** The remote uri a seeded collection/document lands under. */
function remoteDocumentUri(collection: KbCollection, document: { id: string; title: string }): string {
  return kbDocumentUri(kbCollectionUri(collection.name, collection.id), document.title, document.id)
}

/** The store binding for direct store-level budget tests (cache must be warm). */
async function kbSpaceForTests(productSpaceId = SPACE_ID, enterpriseId = ENTERPRISE_ID): Promise<KbOpenVikingSpace> {
  const config = readOpenVikingConfig()
  if (!config) throw new Error('the storage env is not configured')
  const credential = await readKbTenantCredential(productSpaceId, enterpriseId)
  if (!credential) throw new Error('the tenant credential is not cached')
  return {
    config,
    auth: kbTenantAuth(credential),
    binding: { productSpaceId, enterpriseId },
    workspaceRoot,
    spaceName: 'Example enterprise',
    actor: ACCOUNT_ID,
  }
}

describe('knowledge-base scope enforcement', () => {
  it('rejects every call from a personal space with the explicit error code', async () => {
    const { invoke } = createHarness({ kind: 'personal' })
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }))
      .rejects.toMatchObject({ code: 'kb_unavailable_in_personal' })
    await expect(invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'X', description: '',
    })).rejects.toMatchObject({ code: 'kb_unavailable_in_personal' })
    await expect(invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'anything',
    })).rejects.toMatchObject({ code: 'kb_unavailable_in_personal' })
    // Nothing was provisioned for a personal caller — the remote plane is
    // never touched by a refused request.
    expect(ov.requests).toEqual([])
  })

  it('rejects calls without a committed product space fence', async () => {
    setRuntimeActiveProductSpace(null)
    const { invoke } = createHarness()
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }))
      .rejects.toMatchObject({ code: 'PRODUCT_SPACE_CONTEXT_REQUIRED' })
  })

  it('rejects calls when the workspace does not match the bound context', async () => {
    const { invoke } = createHarness()
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: 'ws-other' }))
      .rejects.toMatchObject({ code: 'workspace_context_mismatch' })
  })

  it('rejects mutations while offline read-only is engaged', async () => {
    const { invoke } = createHarness()
    setRuntimeOfflineReadOnly(true)
    await expect(invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'X', description: '',
    })).rejects.toMatchObject({ code: 'OFFLINE_READ_ONLY' })
    setRuntimeOfflineReadOnly(false)
    // The refusal preceded the tenant work: no provisioning happened.
    expect(ov.requests).toEqual([])
  })

  it('rejects mutations on an online read_only space and on a runtime restriction, keeping reads (review #4)', async () => {
    // Seed while the space is active (provisioning is a WRITE, so it must run
    // before the read-only projection engages), then flip the reader.
    const seeded = createHarness()
    const { collection } = await seedCollection(seeded.invoke)
    setKbActiveProductSpaceReaderForTests(
      (_accountId, productSpaceId) =>
        (productSpaceId === SPACE_ID ? enterpriseSpace('owner', { accessMode: 'read_only' }) : null) as never,
    )
    await expect(seeded.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'X', description: '',
    })).rejects.toMatchObject({ code: 'kb_space_read_only' })
    await expect(seeded.invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: 'kb-x',
    })).rejects.toMatchObject({ code: 'kb_space_read_only' })
    // The read side stays usable for the restricted projection.
    const list = await seeded.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }) as KbCollectionList
    expect(list.canManage).toBe(true)
    expect(list.collections.map(row => row.id)).toEqual([collection.id])

    // The runtime restriction reads the same on an active space.
    const runtime = createHarness()
    setRuntimeProductSpaceRestricted(SPACE_ID, true)
    await expect(runtime.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'X', description: '',
    })).rejects.toMatchObject({ code: 'kb_space_read_only' })
    await expect(runtime.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }))
      .resolves.toBeTruthy()
  })

  it('fails a mutation whose authorization spans a fence revoke (review #3)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    // The trusted-account lookup stalls: the revoke lands INSIDE the await.
    setTrustedProductSpaceAccountProvider(async () => {
      await gate
      return ACCOUNT_ID
    })
    const { invoke } = createHarness()
    const pending = invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Too late', description: '',
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    setRuntimeActiveProductSpace(null)
    release()
    await expect(pending).rejects.toMatchObject({ code: 'PRODUCT_SPACE_CONTEXT_REQUIRED' })
    // Nothing was written: no tenant provisioning, no audit trail.
    expect(ov.requests).toEqual([])
    expect(readAudit(workspaceRoot, binding)).toEqual([])
  })

  it('fails a mutation whose fence is revoked between authorization and the handler body (review #3)', async () => {
    const { invoke } = createHarness()
    // The reader runs INSIDE requireKbScope after its internal CAS but
    // before the handler resumes: revoking here is exactly the window
    // between "authorized" and "about to write".
    setKbActiveProductSpaceReaderForTests((_accountId, productSpaceId) => {
      if (productSpaceId !== SPACE_ID) return null
      setRuntimeActiveProductSpace(null)
      return enterpriseSpace('owner') as never
    })
    await expect(invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Revoked mid-entry', description: '',
    })).rejects.toMatchObject({ code: 'PRODUCT_SPACE_CONTEXT_REQUIRED' })
    expect(ov.requests).toEqual([])

    // The same window may not leave a session-scope write behind either.
    setRuntimeActiveProductSpace(SPACE_ID)
    setRuntimeActiveProductSpaceAccount(ACCOUNT_ID)
    const second = createHarness()
    second.seedSession('session-1')
    const seeded = await seedCollection(second.invoke, { title: 'Policy', content: 'Rules.' })
    if (!seeded.document) throw new Error('seed document missing')
    await publishDocument(second.invoke, seeded.document)
    setKbActiveProductSpaceReaderForTests((_accountId, productSpaceId) => {
      if (productSpaceId !== SPACE_ID) return null
      setRuntimeActiveProductSpace(null)
      return enterpriseSpace('owner') as never
    })
    await expect(second.invoke(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-1', collectionIds: [seeded.collection.id],
    })).rejects.toMatchObject({ code: 'PRODUCT_SPACE_CONTEXT_REQUIRED' })
    expect(second.savedCollections.get('session-1')?.kbCollectionIds).toEqual([])
    expect(readAudit(workspaceRoot, binding)
      .filter(entry => entry.action === 'session_scope.set')).toHaveLength(0)
  })
})

describe('knowledge-base enterprise isolation', () => {
  it('keeps one tenant per ProductSpace: another space gets its own empty KB, never the first space data (review #1)', async () => {
    const first = createHarness()
    const { collection, document } = await seedCollection(first.invoke, {
      title: 'Expense policy', content: 'Meals are reimbursed.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(first.invoke, document)

    // The same workspace, a DIFFERENT enterprise space fence: the second
    // space's management RPC brings up ITS OWN tenant — a separate account
    // the first space's data never appears in.
    setRuntimeActiveProductSpace('ps-two')
    const second = createHarness({ spaceId: 'ps-two', enterpriseId: 'ent-two' })
    const ownCollection = await second.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Second space KB', description: '',
    }) as KbCollection
    const list = await second.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }) as KbCollectionList
    expect(list.collections.map(row => row.id)).toEqual([ownCollection.id])
    expect(await second.invoke(RPC_CHANNELS.kb.SEARCH, { workspaceId: WORKSPACE_ID, query: 'Meals' })).toEqual([])
    // A document of ANOTHER space reads as "no such document" — the missing
    // document contract, which discloses nothing about the first space.
    expect(await second.invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).toBeNull()
    await expect(second.invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).rejects.toMatchObject({ code: 'kb_document_not_found' })

    // Two accounts exist, and the first space's collection lives only in its
    // own tenant's tree.
    expect(ov.hasAccount(ovAccountId(SPACE_ID))).toBe(true)
    expect(ov.hasAccount(ovAccountId('ps-two', 'ent-two'))).toBe(true)
    expect(ov.tree(ovAccountId(SPACE_ID)).has(kbCollectionUri('Handbook', collection.id))).toBe(true)
    expect(ov.tree(ovAccountId('ps-two', 'ent-two')).has(kbCollectionUri('Handbook', collection.id))).toBe(false)

    // Back on the first space's fence, its data is untouched.
    setRuntimeActiveProductSpace(SPACE_ID)
    setKbActiveProductSpaceReaderForTests(
      (_accountId, productSpaceId) =>
        (productSpaceId === SPACE_ID ? enterpriseSpace('owner') : null) as never,
    )
    const back = await first.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }) as KbCollectionList
    expect(back.collections).toHaveLength(1)
  })

  it('refuses a foreign enterprise claim on the same ProductSpace id (review #1)', async () => {
    const { invoke } = createHarness()
    await seedCollection(invoke)
    // Same ProductSpace id, but the verified context now claims a different
    // enterprise: the cached binding fails closed BEFORE any remote call.
    setKbActiveProductSpaceReaderForTests(
      () => enterpriseSpace('owner', { enterpriseId: 'ent-evil' }) as never,
    )
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }))
      .rejects.toMatchObject({ code: 'kb_space_mismatch' })
    await expect(invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'X', description: '',
    })).rejects.toMatchObject({ code: 'kb_space_mismatch' })
  })

  it('never lets the root key near the data plane (brief D2)', async () => {
    const { invoke } = createHarness()
    await seedCollection(invoke)
    // Every data-plane request the surface issued carried the TENANT user
    // key; the root key appeared only on the admin-plane account calls.
    const tenantKey = ov.userKey(ovAccountId(SPACE_ID))
    const dataPlane = ov.requests.filter(request => !request.path.startsWith('/api/v1/admin/'))
    expect(dataPlane.length).toBeGreaterThan(0)
    for (const request of dataPlane) {
      expect(request.authorization).toBe(`Bearer ${tenantKey}`)
    }
    expect(ov.requests.some(request => request.authorization === `Bearer ${ROOT_KEY}`)).toBe(true)
    // ...and the fake itself refuses the root key on the data plane.
    const probe = await fetch(`${ov.baseUrl}/api/v1/fs/attrs?uri=viking://resources/`, {
      headers: { authorization: `Bearer ${ROOT_KEY}` },
    })
    expect(probe.status).toBe(403)
  })
})

describe('knowledge-base availability semantics', () => {
  it('reads stay unavailable and never provision before the first management RPC (brief D2)', async () => {
    const { invoke } = createHarness()
    // A fresh device has no cached binding: a READ is the neutral
    // availability failure — it must not trigger a remote write.
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }))
      .rejects.toMatchObject({ code: 'kb_service_unavailable', message: KB_SERVICE_UNAVAILABLE_MESSAGE })
    await expect(invoke(RPC_CHANNELS.kb.SEARCH, { workspaceId: WORKSPACE_ID, query: 'flights' }))
      .rejects.toMatchObject({ code: 'kb_service_unavailable' })
    expect(ov.requests).toEqual([])

    // The neutral error never names the vendor, a URI or a raw response.
    try {
      await invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID })
      throw new Error('expected the read to fail')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toBe(KB_SERVICE_UNAVAILABLE_MESSAGE)
      expect(message.toLowerCase()).not.toContain('viking')
      expect(message.toLowerCase()).not.toContain('openviking')
    }

    // The first MANAGEMENT RPC provisions, and after it the reads work.
    await invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Handbook', description: '',
    })
    const list = await invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }) as KbCollectionList
    expect(list.collections).toHaveLength(1)
  })

  it('maps a storage outage to the neutral availability error without vendor names (brief D7)', async () => {
    const { invoke } = createHarness()
    await seedCollection(invoke)
    // The listing stalls past its own read timeout: the store maps the
    // failure to the neutral code; the raw cause stays server-side.
    ov.setDelay('/api/v1/fs/ls', 200)
    setOpenVikingTimeoutsForTests({ readMs: 25 })
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }))
      .rejects.toMatchObject({ code: 'kb_service_unavailable', message: KB_SERVICE_UNAVAILABLE_MESSAGE })
  })
})

describe('knowledge-base list contract', () => {
  it('parses the bridged input object and reports the space capability, not data presence (reviews #5/#6)', async () => {
    const { invoke } = createHarness()
    // The renderer/channel-map passes ONE object; a bare string is invalid.
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, WORKSPACE_ID))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })

    const { collection } = await seedCollection(invoke)
    const list = await invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }) as KbCollectionList
    expect(list.canManage).toBe(true)
    expect(list.collections).toHaveLength(1)
    expect(list.collections[0].id).toBe(collection.id)

    const member = createHarness({ role: 'member' })
    const memberList = await member.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }) as KbCollectionList
    expect(memberList.canManage).toBe(false)
    expect(memberList.collections).toHaveLength(1)
  })

  it('offers members only collections that hold published documents (review #16)', async () => {
    const { invoke } = createHarness()
    const withDocs = await seedCollection(invoke, { title: 'Policy', content: 'Rules.' })
    await invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Empty', description: '',
    })

    const unfiltered = await invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }) as KbCollectionList
    expect(unfiltered.collections).toHaveLength(2)

    const publishedOnly = await invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, publishedOnly: true,
    }) as KbCollectionList
    expect(publishedOnly.collections.map(row => row.id)).toEqual([])

    await publishDocument(invoke, withDocs.document as KbDocumentSummary)
    const afterPublish = await invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, publishedOnly: true,
    }) as KbCollectionList
    expect(afterPublish.collections.map(row => row.id)).toEqual([withDocs.collection.id])
  })
})

describe('knowledge-base session scope authorization', () => {
  it('refuses reads and writes for sessions outside the caller scope (review #2)', async () => {
    const { invoke, seedForeignSession, savedCollections } = createHarness()
    // An unknown session id is outside the scope by construction.
    await expect(invoke(RPC_CHANNELS.kb.GET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-of-another-space',
    })).rejects.toMatchObject({ code: 'PRODUCT_SPACE_CONTEXT_REQUIRED' })
    await expect(invoke(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-of-another-space', collectionIds: [],
    })).rejects.toMatchObject({ code: 'PRODUCT_SPACE_CONTEXT_REQUIRED' })
    expect(savedCollections.has('session-of-another-space')).toBe(false)

    // A session that EXISTS but carries another account/space/workspace never
    // matches the caller scope — its KB scope can be neither read nor set.
    seedForeignSession('session-foreign-record')
    await expect(invoke(RPC_CHANNELS.kb.GET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-foreign-record',
    })).rejects.toMatchObject({ code: 'PRODUCT_SPACE_CONTEXT_REQUIRED' })
    await expect(invoke(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-foreign-record',
      collectionIds: ['kb-x'],
    })).rejects.toMatchObject({ code: 'PRODUCT_SPACE_CONTEXT_REQUIRED' })
    expect(savedCollections.get('session-foreign-record')?.kbCollectionIds).toEqual([])
  })

  it('only accepts collections that hold a published document and dedupes', async () => {
    const { invoke, seedSession } = createHarness()
    seedSession('session-1')
    const { collection, document } = await seedCollection(invoke, {
      title: 'Policy', content: 'Rules.',
    })
    if (!document) throw new Error('seed document missing')
    const empty = await invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Empty', description: '',
    }) as KbCollection

    await expect(invoke(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-1', collectionIds: [empty.id],
    })).rejects.toMatchObject({ code: 'kb_collection_not_published' })

    await publishDocument(invoke, document)

    const saved = await invoke(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-1',
      collectionIds: [collection.id, collection.id],
    }) as { collectionIds: string[] }
    expect(saved.collectionIds).toEqual([collection.id])

    expect(await invoke(RPC_CHANNELS.kb.GET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-1',
    })).toEqual({ collectionIds: [collection.id] })
  })

  it('audits every session-scope write with actor, target and the actual change (review #15)', async () => {
    const { invoke, seedSession } = createHarness()
    seedSession('session-1')
    const { collection, document } = await seedCollection(invoke, {
      title: 'Policy', content: 'Rules.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(invoke, document)

    await invoke(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-1', collectionIds: [collection.id],
    })
    const scopeEntries = readAudit(workspaceRoot, binding)
      .filter(entry => entry.action === 'session_scope.set')
    expect(scopeEntries).toHaveLength(1)
    expect(scopeEntries[0]).toMatchObject({
      actor: ACCOUNT_ID,
      action: 'session_scope.set',
      target: 'session-1',
      detail: { from: [], to: [collection.id] },
    })

    // Clearing writes the reverse change.
    await invoke(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-1', collectionIds: [],
    })
    const afterClear = readAudit(workspaceRoot, binding)
      .filter(entry => entry.action === 'session_scope.set')
    expect(afterClear).toHaveLength(2)
    expect(afterClear[1].detail).toMatchObject({ from: [collection.id], to: [] })
  })

  it('never leaves a mutated scope without its audit entry, even when the fence moves mid-write (review #15)', async () => {
    const { invoke, seedSession, savedCollections, sessionManager } = createHarness()
    seedSession('session-1')
    const { collection, document } = await seedCollection(invoke, {
      title: 'Policy', content: 'Rules.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(invoke, document)
    // The setter revokes the fence AFTER the mutation has landed — the exact
    // window where the previous order (mutate → CAS → audit) recorded zero.
    const mutableManager = sessionManager as unknown as {
      setSessionKbCollections: (sessionId: string, ids: string[]) => Promise<void>
    }
    const original = mutableManager.setSessionKbCollections.bind(mutableManager)
    mutableManager.setSessionKbCollections = async (sessionId, ids) => {
      await original(sessionId, ids)
      setRuntimeActiveProductSpace(null)
    }

    const saved = await invoke(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-1', collectionIds: [collection.id],
    }) as { ok: boolean; collectionIds: string[] }
    // The write was authorized at initiation, so it succeeded — and the trail
    // MUST have been written ahead of it.
    expect(saved).toMatchObject({ ok: true, collectionIds: [collection.id] })
    expect(savedCollections.get('session-1')?.kbCollectionIds).toEqual([collection.id])
    const entries = readAudit(workspaceRoot, binding)
      .filter(entry => entry.action === 'session_scope.set')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      actor: ACCOUNT_ID,
      target: 'session-1',
      detail: { from: [], to: [collection.id] },
    })
  })
})

describe('knowledge-base document lifecycle', () => {
  it('walks draft → in_review → rejected → draft → published, with the state machine gates', async () => {
    const { invoke } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Onboarding', content: 'Welcome to the company.',
    })
    if (!document) throw new Error('seed document missing')

    const inReview = await invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    }) as KbDocumentSummary
    expect(inReview.status).toBe('in_review')

    // Reviewing documents cannot be deleted — the deletion contract covers
    // draft/published/rejected only (review #14).
    await expect(invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).rejects.toMatchObject({ code: 'kb_delete_not_allowed' })

    // The state machine refuses the illegal move (in_review cannot re-submit).
    await expect(invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).rejects.toMatchObject({ code: 'kb_invalid_transition' })

    // rejected → draft → in_review → published
    await invoke(RPC_CHANNELS.kb.REJECT_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id, reason: 'needs work',
    })
    const reverted = await invoke(RPC_CHANNELS.kb.REVERT_TO_DRAFT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    }) as KbDocumentSummary
    expect(reverted.status).toBe('draft')
    await invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
    const published = await invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    }) as KbDocumentSummary
    expect(published.status).toBe('published')
    expect(published.publishedAt).not.toBeNull()
    expect(published.rejectReason).toBeNull()
    expect(published.version).toBe(1)

    // A published document is terminal: no further transitions.
    await expect(invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).rejects.toMatchObject({ code: 'kb_invalid_transition' })

    // The body lives in the tenant — no local versions tree anymore.
    const fetched = await invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    }) as { content: string }
    expect(fetched.content).toBe('Welcome to the company.')
    expect(ov.tree(ovAccountId(SPACE_ID)).get(remoteDocumentUri(collection, document))?.content)
      .toBe('Welcome to the company.')
  })

  it('hides drafts from search until published, then ranks title hits first', async () => {
    const { invoke } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Flights policy', content: 'Flights must be booked economy.',
    })
    if (!document) throw new Error('seed document missing')

    // Draft and in_review content is not searchable — the status filter is
    // enforced by the storage call itself (brief D5).
    expect(await invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'flights',
    })).toEqual([])

    await invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
    expect(await invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'flights',
    })).toEqual([])

    await invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: document.id })

    // A second published doc whose body mentions the term more, but whose
    // title does not — the title hit must rank first.
    const second = await invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
      title: 'Per diem', content: 'flights flights flights',
    }) as KbDocumentSummary
    await invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: second.id })
    await invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: second.id })

    const hits = await invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'flights',
    }) as { docId: string; title: string; snippet: string; score: number }[]
    expect(hits).toHaveLength(2)
    expect(hits[0].docId).toBe(document.id)
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
    expect(hits[0].snippet.toLowerCase()).toContain('flights')

    // Collection filter + empty result behavior.
    expect(await invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'flights', collectionIds: ['kb-missing'],
    })).toEqual([])
    expect(await invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: '   ',
    })).toEqual([])
  })

  it('refuses content above the 2MB cap', async () => {
    const { invoke } = createHarness()
    const { collection } = await seedCollection(invoke)
    // Multibyte content stays under the schema's character cap while its UTF-8
    // byte size crosses KB_MAX_CONTENT_BYTES — the store enforces bytes.
    const multibyte = '€'.repeat(750_000) // 750k chars, 2.25MB UTF-8
    await expect(invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
      title: 'Too big', content: multibyte,
    })).rejects.toMatchObject({ code: 'kb_content_too_large' })
  })

  it('recycles deleted documents out of the live tenant (brief D4)', async () => {
    const { invoke } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Obsolete', content: 'Out of date.',
    })
    if (!document) throw new Error('seed document missing')

    await invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })
    const rows = await invoke(RPC_CHANNELS.kb.LIST_DOCUMENTS, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
    }) as KbDocumentSummary[]
    expect(rows).toEqual([])
    expect(await invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).toBeNull()
    // The soft delete moved the node under the hidden recycle directory.
    const tree = ov.tree(ovAccountId(SPACE_ID))
    const documentUri = remoteDocumentUri(collection, document)
    const recycledUri = `viking://resources/.recycle/${documentUri.slice(documentUri.lastIndexOf('/') + 1)}`
    expect(tree.has(recycledUri)).toBe(true)
    expect(tree.has(documentUri)).toBe(false)
    // The recycled copy left the retrieval face with its status: the node
    // carries the storage-only deleted state.
    expect(tree.get(recycledUri)?.tags.join(' ')).toContain('status=deleted')
  })

  it('appends an audit entry for every mutation', async () => {
    const { invoke } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Audited', content: 'Body.',
    })
    if (!document) throw new Error('seed document missing')
    await invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
    await invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: document.id })
    await invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: document.id })

    const entries = readAudit(workspaceRoot, binding)
    expect(entries.map(entry => entry.action)).toEqual([
      'openviking.tenant_provisioned',
      'collection.create', 'document.upload', 'document.submit', 'document.publish', 'document.delete',
    ])
    const provisioned = entries[0]
    expect(provisioned.actor).toBe(ACCOUNT_ID)
    const created = entries.find(entry => entry.action === 'collection.create')
    expect(created).toMatchObject({ actor: ACCOUNT_ID, target: collection.id })
    const uploaded = entries.find(entry => entry.action === 'document.upload')
    expect(uploaded?.detail).toMatchObject({ collectionId: collection.id, title: 'Audited' })
    const submitted = entries.find(entry => entry.action === 'document.submit')
    expect(submitted?.detail).toMatchObject({ from: 'draft', status: 'in_review' })
    const deleted = entries.find(entry => entry.action === 'document.delete')
    expect(deleted?.detail).toMatchObject({ previousStatus: 'published' })
  })
})

describe('knowledge-base send-time reference resolution', () => {
  function sendDeps(harness: ReturnType<typeof createHarness>): HandlerDeps {
    return {
      sessionManager: harness.sessionManager,
      platform: { logger: { info: () => {}, warn: () => {}, error: () => {} } },
    } as never
  }

  it('resolves send-time references from the session scope and commits the first-send draft', async () => {
    const { invoke, sessionManager } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Travel policy', content: 'Flights are economy only.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(invoke, document)
    // The session already exists (created before its first send) with an
    // empty KB scope.
    await sessionManager.setSessionKbCollections('session-9', [])

    // First send with a composer draft: the draft scope is committed and hits resolve.
    const references = await resolveSessionKbReferences(
      sendDeps({ sessionManager } as ReturnType<typeof createHarness>),
      'session-9', 'how do I book flights?', [collection.id],
    )
    expect(references).toHaveLength(1)
    expect(references?.[0]).toMatchObject({ docId: document.id, collectionId: collection.id })
    expect(await sessionManager.getSession('session-9')).toMatchObject({
      kbCollectionIds: [collection.id],
    })

    // Later sends read the persisted scope — no draft argument needed.
    const later = await resolveSessionKbReferences(
      sendDeps({ sessionManager } as ReturnType<typeof createHarness>),
      'session-9', 'flights again',
    )
    expect(later).toHaveLength(1)

    // Clearing the scope silences references without mutating past messages.
    await invoke(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-9', collectionIds: [],
    })
    expect(await resolveSessionKbReferences(
      sendDeps({ sessionManager } as ReturnType<typeof createHarness>),
      'session-9', 'flights again',
    )).toBeUndefined()
  })

  it('exits before any await when the session has no KB scope (review #7)', async () => {
    const { sessionManager } = createHarness()
    // Auth never resolves: an empty scope must still return immediately.
    setTrustedProductSpaceAccountProvider(() => new Promise(() => {}))
    setSyncTrustedProductSpaceAccountId(null)
    const result = await resolveSessionKbReferences(
      sendDeps({ sessionManager } as ReturnType<typeof createHarness>),
      'session-empty', 'anything',
    )
    expect(result).toBeUndefined()
  })

  it('degrades to no references when the session does not exist', async () => {
    const { sessionManager } = createHarness()
    const result = await resolveSessionKbReferences(
      sendDeps({ sessionManager } as ReturnType<typeof createHarness>),
      'session-missing', 'anything',
    )
    expect(result).toBeUndefined()
  })

  it('races a hung authorization against the send wall clock instead of blocking forever (review #7)', async () => {
    const { invoke, sessionManager } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Travel policy', content: 'Flights are economy only.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(invoke, document)
    // The session exists WITH a stored scope, so resolution reaches the hung
    // authorization instead of exiting on the fast path.
    await sessionManager.setSessionKbCollections('session-9', [collection.id])

    setKbSendResolveTimeoutForTests(25)
    setTrustedProductSpaceAccountProvider(() => new Promise(() => {}))
    const started = Date.now()
    const result = await resolveSessionKbReferences(
      sendDeps({ sessionManager } as ReturnType<typeof createHarness>),
      'session-9', 'flights?', [collection.id],
    )
    expect(result).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('audits the first-send draft commit as a session-scope write (review #15)', async () => {
    const { invoke, sessionManager } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Travel policy', content: 'Flights are economy only.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(invoke, document)
    // The pre-existing session carries an empty scope; the composer draft is
    // what commits the scope on this first send.
    await sessionManager.setSessionKbCollections('session-draft', [])

    await resolveSessionKbReferences(
      sendDeps({ sessionManager } as ReturnType<typeof createHarness>),
      'session-draft', 'flights?', [collection.id],
    )
    const entries = readAudit(workspaceRoot, binding)
      .filter(entry => entry.action === 'session_scope.set')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      actor: ACCOUNT_ID,
      target: 'session-draft',
      detail: { from: [], to: [collection.id], source: 'send_draft_commit' },
    })
  })

  it('truncates an oversized send text to the search query ceiling (review #7)', async () => {
    const { invoke, sessionManager } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Travel policy', content: 'Flights are economy only.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(invoke, document)
    await sessionManager.setSessionKbCollections('session-9', [collection.id])

    // 48k characters — beyond the ceiling the SEARCH schema enforces; the
    // send path applies the same bound to the raw message.
    const oversized = 'flights '.repeat(6_000)
    const references = await resolveSessionKbReferences(
      sendDeps({ sessionManager } as ReturnType<typeof createHarness>),
      'session-9', oversized,
    )
    expect(references).toHaveLength(1)
    expect(references?.[0]).toMatchObject({ docId: document.id })
  })

  it('degrades a send to no references when the tenant is unreachable — the send still resolves (brief D7)', async () => {
    const { invoke, sessionManager } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Travel policy', content: 'Flights are economy only.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(invoke, document)
    await sessionManager.setSessionKbCollections('session-9', [collection.id])

    // The retrieval endpoint stalls past its own timeout: phase 2 fails, the
    // resolution degrades to undefined and the draft stays committed.
    ov.setDelay('/api/v1/search/find', 300)
    setOpenVikingTimeoutsForTests({ findMs: 30 })
    const references = await resolveSessionKbReferences(
      sendDeps({ sessionManager } as ReturnType<typeof createHarness>),
      'session-9', 'flights?',
    )
    expect(references).toBeUndefined()
    expect(await sessionManager.getSession('session-9')).toMatchObject({
      kbCollectionIds: [collection.id],
    })
  })

  it('yields no references when the binding is missing — and provisions nothing (brief D2)', async () => {
    const { invoke, sessionManager } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Travel policy', content: 'Flights are economy only.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(invoke, document)
    await sessionManager.setSessionKbCollections('session-9', [collection.id])

    // A fresh device: the cached binding is gone. The send must not provision
    // (no admin-plane calls at all) and must still resolve — to nothing.
    credentialManagerOverride?.clear()
    ov.requests.length = 0
    const references = await resolveSessionKbReferences(
      sendDeps({ sessionManager } as ReturnType<typeof createHarness>),
      'session-9', 'flights?',
    )
    expect(references).toBeUndefined()
    expect(ov.requests).toEqual([])
    // Reads lose their binding the same way — the neutral unavailability,
    // never a provisioning side effect from a read path.
    await expect(invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).rejects.toMatchObject({ code: 'kb_service_unavailable' })
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }))
      .rejects.toMatchObject({ code: 'kb_service_unavailable' })
    void collection
  })
})

describe('knowledge-base send-time read-only and timeout discipline', () => {
  /** Seeds a session with stored scope `[stored]` plus a second published collection. */
  async function seedScopedSession(harness: ReturnType<typeof createHarness>) {
    const { invoke, sessionManager } = harness
    const stored = await seedCollection(invoke, { title: 'Travel policy', content: 'Flights are economy only.' })
    if (!stored.document) throw new Error('seed document missing')
    await publishDocument(invoke, stored.document)
    const draftCollection = await invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Other', description: '',
    }) as KbCollection
    const draftDoc = await invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: draftCollection.id,
      title: 'Other policy', content: 'Nothing about flights.',
    }) as KbDocumentSummary
    await publishDocument(invoke, draftDoc)
    await sessionManager.setSessionKbCollections('session-ro', [stored.collection.id])
    return { stored: stored.collection, draftCollection }
  }

  function sendDeps(harness: ReturnType<typeof createHarness>): HandlerDeps {
    return {
      sessionManager: harness.sessionManager,
      platform: { logger: { info: () => {}, warn: () => {}, error: () => {} } },
    } as never
  }

  function resolveFor(harness: ReturnType<typeof createHarness>, message: string, draft?: string[]) {
    return resolveSessionKbReferences(sendDeps(harness), 'session-ro', message, draft)
  }

  it('ignores the composer draft while the space is read-only and resolves from the stored scope (review #4)', async () => {
    const scenarios: Array<() => void> = [
      () => setRuntimeOfflineReadOnly(true),
      () => setRuntimeProductSpaceRestricted(SPACE_ID, true),
    ]
    for (const engage of scenarios) {
      const harness = createHarness()
      const { stored, draftCollection } = await seedScopedSession(harness)
      engage()
      const references = await resolveFor(harness, 'flights', [draftCollection.id])
      // References still resolve — from the STORED scope, never the draft.
      expect(references?.map(hit => hit.collectionId)).toEqual([stored.id])
      // The draft never reached the session scope, and nothing was audited.
      expect(await harness.sessionManager.getSession('session-ro'))
        .toMatchObject({ kbCollectionIds: [stored.id] })
      expect(readAudit(workspaceRoot, binding).filter(entry => entry.action === 'session_scope.set'))
        .toHaveLength(0)
      setRuntimeOfflineReadOnly(false)
      setRuntimeProductSpaceRestricted(SPACE_ID, false)
    }

    // Same contract for an online `read_only` accessMode space: seed while
    // active, then flip the space's accessMode.
    const readOnly = createHarness()
    const readOnlySeed = await seedScopedSession(readOnly)
    setKbActiveProductSpaceReaderForTests(
      (_accountId, productSpaceId) =>
        (productSpaceId === SPACE_ID ? enterpriseSpace('owner', { accessMode: 'read_only' }) : null) as never,
    )
    const stored = readOnlySeed.stored
    const draftCollection = readOnlySeed.draftCollection
    const references = await resolveFor(readOnly, 'flights', [draftCollection.id])
    expect(references?.map(hit => hit.collectionId)).toEqual([stored.id])
    expect(await readOnly.sessionManager.getSession('session-ro'))
      .toMatchObject({ kbCollectionIds: [stored.id] })
    expect(readAudit(workspaceRoot, binding).filter(entry => entry.action === 'session_scope.set'))
      .toHaveLength(0)
  })

  it('a send that times out may not commit its draft afterwards (review N1)', async () => {
    const harness = createHarness()
    const { stored, draftCollection } = await seedScopedSession(harness)
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    // The trusted-account lookup hangs past the send deadline.
    setTrustedProductSpaceAccountProvider(async () => {
      await gate
      return ACCOUNT_ID
    })
    setKbSendResolveTimeoutForTests(25)
    const result = await resolveFor(harness, 'flights', [draftCollection.id])
    expect(result).toBeUndefined()
    // The deadline has fired; now the stale authorization resumes — with the
    // fence STILL on this space, so only the abandonment guard stops it.
    release()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(await harness.sessionManager.getSession('session-ro'))
      .toMatchObject({ kbCollectionIds: [stored.id] })
    expect(readAudit(workspaceRoot, binding)
      .filter(entry => entry.action === 'session_scope.set')).toHaveLength(0)
  })

  it('an exhausted publish budget commits nothing — the write gate re-checks the deadline (review N1)', async () => {
    const harness = createHarness()
    const { stored, draftCollection } = await seedScopedSession(harness)
    // The publish loop runs SYNCHRONOUSLY over a pre-loaded index, so the
    // abandonment timer cannot fire inside it — the faithful repro of the gap
    // shifts the wall clock past the deadline during the commit phase's
    // session read: every deadline check from there on (the loop AND the
    // pre-write gate) sees an exhausted budget, while the REAL race timer has
    // not fired, so `abandoned` is still false and only the absolute deadline
    // can stop the write of the truncated scope.
    const realNow = Date.now.bind(Date)
    const manager = harness.sessionManager as unknown as {
      getSession: (sessionId: string) => Promise<unknown>
    }
    const original = manager.getSession.bind(manager)
    let sessionReads = 0
    manager.getSession = async sessionId => {
      const record = await original(sessionId)
      sessionReads += 1
      // 1st read: the capture phase (budget intact). 2nd read: the commit
      // phase — from here on the budget counts as exhausted.
      if (sessionReads === 2) Date.now = () => realNow() + 60_000
      return record
    }
    setKbSendResolveTimeoutForTests(25_000)
    try {
      // Phase 2 sees the same exhausted clock and resolves nothing — the
      // send degrades, it does not fail.
      const result = await resolveFor(harness, 'flights', [draftCollection.id])
      expect(result).toBeUndefined()
      // The truncated draft was NOT committed: scope unchanged, zero audit.
      expect(await harness.sessionManager.getSession('session-ro'))
        .toMatchObject({ kbCollectionIds: [stored.id] })
      expect(readAudit(workspaceRoot, binding).filter(entry => entry.action === 'session_scope.set'))
        .toHaveLength(0)
    } finally {
      Date.now = realNow
    }
  })

  it('authorizes the whole resolution against the ENTRY token only (reviews #3/N1)', async () => {
    const harness = createHarness()
    const { stored, draftCollection } = await seedScopedSession(harness)
    // The SEND entry captured its token BEFORE the resolution started.
    const entryToken = captureCompleteTrustedSessionScopeToken(WORKSPACE_ID)
    if (!entryToken) throw new Error('entry token missing')
    // The revoke-and-recommit lands INSIDE the awaited session read: a FRESH
    // capture after it would authorize again (same account, same space, same
    // fence), but the send was admitted under the entry token — the
    // resolution must hold it to that token and commit nothing. The previous
    // capture-after-first-await order picked up the re-armed token and wrote
    // the draft into the scope of a send the entry had already rejected.
    const manager = harness.sessionManager as unknown as {
      getSession: (sessionId: string) => Promise<unknown>
    }
    const original = manager.getSession.bind(manager)
    manager.getSession = async sessionId => {
      const record = await original(sessionId)
      setSyncTrustedProductSpaceAccountId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
      setSyncTrustedProductSpaceAccountId(ACCOUNT_ID)
      return record
    }
    const result = await resolveSessionKbReferences(
      sendDeps(harness),
      'session-ro', 'flights?', [draftCollection.id], WORKSPACE_ID, entryToken,
    )
    expect(result).toBeUndefined()
    expect(await harness.sessionManager.getSession('session-ro'))
      .toMatchObject({ kbCollectionIds: [stored.id] })
    expect(readAudit(workspaceRoot, binding)
      .filter(entry => entry.action === 'session_scope.set')).toHaveLength(0)
  })

  it('commits an explicit empty draft as a scope clear before resolving (review #12 regression)', async () => {
    const { invoke, sessionManager } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Travel policy', content: 'Flights are economy only.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(invoke, document)
    await sessionManager.setSessionKbCollections('session-9', [collection.id])

    // The user cleared the selection and sent: the explicit [] is a clear,
    // not "no draft". The previous `draft.length > 0` guard skipped the
    // commit entirely, so the send kept resolving from the scope the user
    // had just emptied.
    const references = await resolveSessionKbReferences(
      sendDeps({ sessionManager } as ReturnType<typeof createHarness>),
      'session-9', 'flights?', [],
    )
    expect(references).toBeUndefined()
    expect(await sessionManager.getSession('session-9')).toMatchObject({ kbCollectionIds: [] })
    expect(readAudit(workspaceRoot, binding)
      .filter(entry => entry.action === 'session_scope.set')).toHaveLength(1)
  })

  it('a resolution resuming after a space switch writes neither scope nor audit into the wrong space (review N1)', async () => {
    const harness = createHarness()
    const { stored, draftCollection } = await seedScopedSession(harness)
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    setTrustedProductSpaceAccountProvider(async () => {
      await gate
      return ACCOUNT_ID
    })
    const pending = resolveFor(harness, 'flights?', [draftCollection.id])
    await new Promise(resolve => setTimeout(resolve, 10))
    // The account moves to ANOTHER enterprise space while the old
    // authorization is still pending — inside the wall clock. The reader
    // answers for BOTH spaces, so the captured-scope token check is the only
    // thing that can stop the stale continuation.
    setRuntimeActiveProductSpace('ps-two')
    setKbActiveProductSpaceReaderForTests(
      (_accountId, productSpaceId) =>
        (productSpaceId === 'ps-two'
          ? enterpriseSpace('owner', { id: 'ps-two', enterpriseId: 'ent-two' })
          : productSpaceId === SPACE_ID
            ? enterpriseSpace('owner')
            : null) as never,
    )
    release()
    const result = await pending
    expect(result).toBeUndefined()
    // Session A's scope was never overwritten with another space's draft.
    expect(await harness.sessionManager.getSession('session-ro'))
      .toMatchObject({ kbCollectionIds: [stored.id] })
    // And no audit entry landed in EITHER space's KB.
    for (const spaceBinding of [
      { productSpaceId: SPACE_ID, enterpriseId: ENTERPRISE_ID },
      { productSpaceId: 'ps-two', enterpriseId: 'ent-two' },
    ]) {
      expect(readAudit(workspaceRoot, spaceBinding).filter(entry => entry.action === 'session_scope.set'))
        .toHaveLength(0)
    }
  })
})

describe('knowledge-base search budget', () => {
  it('stops on an already-passed deadline before asking the storage anything (review #7)', async () => {
    const { invoke } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Travel policy', content: 'Flights are economy only.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(invoke, document)
    ov.requests.length = 0
    const hits = await searchDocuments(
      await kbSpaceForTests(), 'flights', [collection.id], { deadline: Date.now() - 1 },
    )
    expect(hits).toEqual([])
    expect(ov.requests).toEqual([])
  })

  it('maps a storage-side find timeout to the neutral availability error (review #7 follow-up)', async () => {
    const { invoke } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Travel policy', content: 'Flights are economy only.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(invoke, document)
    // The find stalls past its own bounded timeout: the SEARCH RPC surfaces
    // the neutral message — never the vendor, the URI or the raw response.
    ov.setDelay('/api/v1/search/find', 300)
    setOpenVikingTimeoutsForTests({ findMs: 30 })
    const failure = await invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'flights', collectionIds: [collection.id],
    }).catch((caught: unknown) => caught) as { code?: string; message?: string }
    expect(failure.code).toBe('kb_service_unavailable')
    expect(failure.message).toBe(KB_SERVICE_UNAVAILABLE_MESSAGE)
    void document
  })

  it('discloses nothing once the budget runs out mid-walk (review #7)', async () => {
    const { invoke } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Travel policy', content: 'Flights are economy only.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(invoke, document)
    // The walk is slowed past the shared budget: the loop that would disclose
    // hits re-checks the deadline per entry and stops before the first one.
    ov.setDelay('/api/v1/fs/ls', 100)
    const hits = await searchDocuments(
      await kbSpaceForTests(), 'flights', [collection.id], { deadline: Date.now() + 50 },
    )
    expect(hits).toEqual([])
  })

  it('fails the publish check closed once its shared budget is exhausted (review #7)', async () => {
    const { invoke } = createHarness()
    const seeded = await seedCollection(invoke, { title: 'Policy', content: 'Rules.' })
    if (!seeded.document) throw new Error('seed document missing')
    await publishDocument(invoke, seeded.document)
    const space = await kbSpaceForTests()
    // In budget the collection is proven published...
    expect(await isCollectionPublished(space, seeded.collection.id)).toBe(true)
    // ...while an exhausted budget degrades to "not proven published" instead
    // of walking the whole tenant past the send deadline.
    expect(await isCollectionPublished(space, seeded.collection.id, {
      deadline: Date.now() - 1,
    })).toBe(false)
  })
})
