import { afterEach, afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { KbCollectionList, KbDocument, KbDocumentSummary, KbSearchHit } from '@polo-ai/shared/protocol'
import * as realCredentials from '@polo-ai/shared/credentials'
import type { HandlerFn, RpcServer, RequestContext } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import {
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
  setRuntimeOfflineReadOnly,
  setRuntimeProductSpaceRestricted,
} from '../../../runtime/product-space-executions'
import {
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../trusted-product-space-account'
import {
  registerKnowledgeBaseHandlers,
  resetKbActiveProductSpaceReaderForTests,
  setKbActiveProductSpaceReaderForTests,
} from '../knowledge-base'
import {
  kbCollectionUri,
  kbDocumentUri,
  kbTagHexEncode,
  loadKbIndex,
  readAudit,
  resetKbDirectoryTagRetryDelayForTests,
  resetKbDirectoryTagWindowForTests,
  setKbDirectoryTagRetryDelayForTests,
  setKbDirectoryTagWindowForTests,
  KB_SERVICE_UNAVAILABLE_MESSAGE,
  type KbOpenVikingSpace,
} from '../../../knowledge-base/store'
import { resetOpenVikingTimeoutsForTests, setOpenVikingTimeoutsForTests } from '../../../knowledge-base/openviking-client'
import { kbTenantAccountId, kbTenantAuth, readKbTenantCredential } from '../../../knowledge-base/tenant'
import { FakeOpenVikingServer } from '../../../knowledge-base/__tests__/fake-openviking-server'

/**
 * End-to-end tenant integration tests for the enterprise knowledge base
 * (POO-108 v3.1) — the layer ABOVE the RPC tests in `knowledge-base.test.ts`.
 * They exercise the multi-tenant lifecycle against the in-memory OpenViking
 * fake: the idempotent provisioning (fresh create, `ALREADY_EXISTS` recovery,
 * the fail-closed ownership check), the cross-device convergence on ONE
 * account, the recycle contract as the fake's dot-visibility rules expose it,
 * the retrieval scoping, and the credential-plane discipline.
 */

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = 'ws-one'
const SPACE_ID = 'ps-one'
const ENTERPRISE_ID = 'ent-one'
const ROOT_KEY = 'ok-root-key-kb-ov-tests'

/**
 * The tenant credential flows through the shared CredentialManager singleton
 * (the real one talks to the OS keychain). The module is retargeted with a
 * pass-through mock so ONLY this file's window uses the fake — any other test
 * file sharing this bun process keeps hitting the real manager.
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

  /** Simulates a second device (or a wiped keychain): the binding is gone. */
  clear(): void {
    this.entries.clear()
  }
}

let credentialManagerOverride: FakeCredentialManager | null = null

mock.module('@polo-ai/shared/credentials', () => ({
  ...realCredentials,
  getCredentialManager: () => credentialManagerOverride ?? realCredentials.getCredentialManager(),
}))

/** The fake backend every test in this file talks to; one root key guards it. */
const ov = FakeOpenVikingServer.start(ROOT_KEY)
afterAll(() => ov.stop())

/** The account id the D1 derivation produces for this file's fixture space. */
const ACCOUNT_DERIVED = kbTenantAccountId({
  productSpaceId: SPACE_ID,
  enterpriseId: ENTERPRISE_ID,
  spaceName: 'Example enterprise',
})

const binding = { productSpaceId: SPACE_ID, enterpriseId: ENTERPRISE_ID }

/** The owner identity every device in this file acts as. */
function ownerSpace(productSpaceId = SPACE_ID, enterpriseId = ENTERPRISE_ID) {
  return {
    id: productSpaceId,
    kind: 'enterprise' as const,
    enterpriseId,
    name: 'Example enterprise',
    role: 'owner' as const,
    accessMode: 'active' as const,
    payer: { kind: 'enterprise' as const, enterpriseId },
  }
}

/** Pins ownership tags onto an EXISTING account's root (the marker check's input). */
function pinMarker(accountId: string, tags: string[]): void {
  const root = ov.tree(accountId).get('viking://resources/')
  if (!root) throw new Error('the account root is missing')
  root.tags = tags
}

interface Harness {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  workspaceRoot: string
  credentials: FakeCredentialManager
}

let tempDir: string
/** One root per registered device — each device keeps its own audit trail. */
let deviceRoots: string[]
let currentDeviceRoot: string
let currentCredentials: FakeCredentialManager

/**
 * Registers ONE device: a fresh workspace root plus its own handler table,
 * over the SHARED fake server — which is what makes two devices converge on
 * one derived account.
 */
function useDevice(): Harness {
  const workspaceRoot = join(tempDir, `device-${deviceRoots.length}`)
  deviceRoots.push(workspaceRoot)
  mkdirSync(workspaceRoot, { recursive: true })
  currentDeviceRoot = workspaceRoot

  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return null },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const sessionManager = {
    getWorkspaces: () => [{ id: WORKSPACE_ID, rootPath: currentDeviceRoot, name: 'Workspace One' }],
    getSessions: () => [],
    getSession: async () => null,
    setSessionKbCollections: async () => {},
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
  return { invoke, workspaceRoot, credentials: currentCredentials }
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'knowledge-base-ov-'))
  deviceRoots = []
  await ov.reset()
  currentCredentials = new FakeCredentialManager()
  credentialManagerOverride = currentCredentials
  process.env.POLO_OPENVIKING_URL = ov.baseUrl
  process.env.POLO_OPENVIKING_ROOT_API_KEY = ROOT_KEY
  setRuntimeActiveProductSpace(SPACE_ID)
  setRuntimeActiveProductSpaceAccount(ACCOUNT_ID)
  setRuntimeOfflineReadOnly(false)
  setTrustedProductSpaceAccountProvider(async () => ACCOUNT_ID)
  setSyncTrustedProductSpaceAccountId(ACCOUNT_ID)
  setKbActiveProductSpaceReaderForTests(
    (_accountId, productSpaceId) => (productSpaceId === SPACE_ID
      ? ownerSpace()
      : ownerSpace(productSpaceId, 'ent-two')) as never,
  )
})

afterEach(() => {
  credentialManagerOverride = null
  resetKbActiveProductSpaceReaderForTests()
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

/** Creates one collection through the RPC. */
async function createCollection(harness: Harness, name: string): Promise<{ id: string; name: string }> {
  return await harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
    workspaceId: WORKSPACE_ID, name, description: '',
  }) as { id: string; name: string }
}

/** The store binding for direct store-level assertions (cache must be warm). */
async function ovSpace(): Promise<KbOpenVikingSpace> {
  const credential = await readKbTenantCredential(SPACE_ID, ENTERPRISE_ID)
  if (!credential) throw new Error('the tenant credential is not cached')
  return {
    config: { baseUrl: ov.baseUrl, processingMode: 'vectors_only' },
    auth: kbTenantAuth(credential),
    binding,
    workspaceRoot: currentDeviceRoot,
    spaceName: 'Example enterprise',
    actor: ACCOUNT_ID,
  }
}

/** Uploads one document into an EXISTING collection and publishes it. */
async function publishInto(
  harness: Harness,
  collection: { id: string },
  doc: { title: string; content: string },
): Promise<KbDocumentSummary> {
  const document = await harness.invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
    workspaceId: WORKSPACE_ID, collectionId: collection.id,
    title: doc.title, content: doc.content,
  }) as KbDocumentSummary
  await harness.invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
  await harness.invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: document.id })
  return document
}

/** Convenience: one fresh collection with one published document in it. */
async function seedPublished(
  harness: Harness,
  name: string,
  doc: { title: string; content: string },
): Promise<KbDocumentSummary> {
  return await publishInto(harness, await createCollection(harness, name), doc)
}

describe('tenant provisioning', () => {
  it('provisions one derived account and pins the ownership marker on its root', async () => {
    const harness = useDevice()
    await harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Handbook', description: '',
    })
    expect(ov.hasAccount(ACCOUNT_DERIVED)).toBe(true)
    const root = ov.tree(ACCOUNT_DERIVED).get('viking://resources/')
    // E2 (measured 2026-10-21): the marker values are exact ids the server's
    // tag lower-casing would distort, so they travel hex-encoded.
    expect(root?.tags).toContain(`polo_space=${kbTagHexEncode(SPACE_ID)}`)
    expect(root?.tags).toContain(`polo_enterprise=${kbTagHexEncode(ENTERPRISE_ID)}`)
    // The binding is cached for the NEXT call — reads and sends never
    // re-enter the admin plane.
    const credential = await readKbTenantCredential(SPACE_ID, ENTERPRISE_ID)
    expect(credential?.accountId).toBe(ACCOUNT_DERIVED)
    expect(credential?.apiKey).toBe(ov.userKey(ACCOUNT_DERIVED))
  })

  it('pins the ownership marker past the account-creation pipeline (e2e E1)', async () => {
    // The account's resource root is a freshly created directory: its own
    // ingestion pipeline wiped the marker written right after the creation on
    // the real instance, which would fail-closed EVERY later provisioning
    // (`binding_mismatch`, marker missing). The provisioning write runs the
    // same verified loop — wait the pipeline out, then write, then verify.
    ov.setDirectoryTagLossWindow(600)
    try {
      const harness = useDevice()
      await harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
        workspaceId: WORKSPACE_ID, name: 'Handbook', description: '',
      })
      const root = ov.tree(ACCOUNT_DERIVED).get('viking://resources/')
      expect(root?.tags).toContain(`polo_space=${kbTagHexEncode(SPACE_ID)}`)
      expect(root?.tags).toContain(`polo_enterprise=${kbTagHexEncode(ENTERPRISE_ID)}`)
      // One write, after the wait: the drained pipeline took the marker.
      const markerWrites = ov.requests.filter(request =>
        request.method === 'POST'
        && request.path === '/api/v1/fs/attrs/set_tags'
        && JSON.stringify(request.body).includes('polo_space='))
      expect(markerWrites).toHaveLength(1)
      const verified = readAudit(harness.workspaceRoot, binding)
        .filter(entry => entry.action === 'remote.directory_tags.result'
          && entry.target === 'viking://resources/')
      expect(verified).toHaveLength(1)
      expect(verified[0]?.detail).toMatchObject({ outcome: 'success', attempts: 1 })
    } finally {
      ov.setDirectoryTagLossWindow(0)
    }
  }, 15_000)

  it('serves later calls from the cache without re-entering the admin plane', async () => {
    const harness = useDevice()
    await harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Handbook', description: '',
    })
    const adminCallsAfterFirst = ov.requests.filter(request => request.path.startsWith('/api/v1/admin/')).length
    await harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Policies', description: '',
    })
    // The second creation rode the cached binding: zero new admin-plane calls.
    expect(ov.requests.filter(request => request.path.startsWith('/api/v1/admin/')).length)
      .toBe(adminCallsAfterFirst)
    // The tenant key appeared on the data plane; the root key NEVER did.
    const dataPlane = ov.requests.filter(request => !request.path.startsWith('/api/v1/admin/'))
    expect(dataPlane.length).toBeGreaterThan(0)
    expect(dataPlane.every(request => request.authorization === `Bearer ${ov.userKey(ACCOUNT_DERIVED)}`)).toBe(true)
  })

  it('recovers an existing tenant through ALREADY_EXISTS by reading the key back', async () => {
    // Another device provisioned this space already: the account exists, the
    // marker is pinned, and THIS device has no cached binding.
    ov.createAccount(ACCOUNT_DERIVED, 'polo-service')
    pinMarker(ACCOUNT_DERIVED, [`polo_space=${SPACE_ID}`, `polo_enterprise=${ENTERPRISE_ID}`])
    const existingKey = ov.userKey(ACCOUNT_DERIVED)
    currentCredentials.clear()

    const harness = useDevice()
    await harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Handbook', description: '',
    })

    // Recovery re-adopted the account: the cached key IS the existing key —
    // re-signing would invalidate the key every other device holds.
    const credential = await readKbTenantCredential(SPACE_ID, ENTERPRISE_ID)
    expect(credential?.apiKey).toBe(existingKey)
    const actions = readAudit(harness.workspaceRoot, binding).map(entry => entry.action)
    expect(actions).toContain('openviking.tenant_recovered')
    expect(actions).not.toContain('openviking.tenant_provisioned')
    // The marker was verified through a READ; it was never rewritten.
    const markerWrites = ov.requests.filter(request =>
      request.path === '/api/v1/fs/attrs/set_tags'
      && JSON.stringify(request.body).includes('polo_space='))
    expect(markerWrites).toEqual([])
  })

  it('fails closed when an existing account carries no ownership marker', async () => {
    // An orphan: created but its marker never landed (a crash between create
    // and setTags). Adoption MUST refuse instead of taking the account over.
    ov.createAccount(ACCOUNT_DERIVED, 'polo-service')
    currentCredentials.clear()

    const harness = useDevice()
    await expect(harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Handbook', description: '',
    })).rejects.toMatchObject({ code: 'kb_service_unavailable', message: KB_SERVICE_UNAVAILABLE_MESSAGE })

    const mismatch = readAudit(harness.workspaceRoot, binding)
      .find(entry => entry.action === 'openviking.binding_mismatch')
    expect(mismatch).toBeDefined()
    expect(mismatch?.detail).toMatchObject({ markerSpace: null, markerEnterprise: null })
    // Nothing was cached, so reads stay unavailable rather than re-provision.
    expect(await readKbTenantCredential(SPACE_ID, ENTERPRISE_ID)).toBeNull()
    await expect(harness.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }))
      .rejects.toMatchObject({ code: 'kb_service_unavailable' })
  })

  it('fails closed when the marker names a foreign space', async () => {
    ov.createAccount(ACCOUNT_DERIVED, 'polo-service')
    pinMarker(ACCOUNT_DERIVED, ['polo_space=ps-other', 'polo_enterprise=ent-other'])
    currentCredentials.clear()

    const harness = useDevice()
    await expect(harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Handbook', description: '',
    })).rejects.toMatchObject({ code: 'kb_service_unavailable' })
    const mismatch = readAudit(harness.workspaceRoot, binding)
      .find(entry => entry.action === 'openviking.binding_mismatch')
    expect(mismatch?.detail).toMatchObject({ markerSpace: 'ps-other', markerEnterprise: 'ent-other' })
  })
})

describe('cross-device convergence', () => {
  it('recovers a lost binding through a managing RPC and keeps the data', async () => {
    // Device A provisions and fills the tenant.
    const deviceA = useDevice()
    const document = await seedPublished(deviceA, 'Handbook', {
      title: 'Vacation policy', content: 'Every employee gets twenty days of paid vacation.',
    })

    // Device B: fresh workspace, wiped credential store. A managing LIST is
    // the restore path (review fix round B1): it re-derives the SAME account,
    // adopts the existing service key through the verified ALREADY_EXISTS
    // path, and — because the storage holds the real data — the listing comes
    // back populated, not empty.
    currentCredentials.clear()
    const deviceB = useDevice()
    const listing = await deviceB.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, {
      workspaceId: WORKSPACE_ID,
    }) as KbCollectionList
    expect(listing.canManage).toBe(true)
    expect(listing.collections.map(collection => collection.name).sort()).toEqual(['Handbook'])

    // B keeps working: its create lands in the SAME tenant, and both devices
    // now see one shared space.
    await deviceB.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Policies', description: '',
    })
    const reListed = await deviceB.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, {
      workspaceId: WORKSPACE_ID,
    }) as KbCollectionList
    expect(reListed.collections.map(collection => collection.name).sort()).toEqual(['Handbook', 'Policies'])
    const fetched = await deviceB.invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    }) as KbDocument
    expect(fetched.title).toBe('Vacation policy')
    expect(fetched.content).toContain('twenty days')
    // Both devices derived the SAME account — one tree, not two. The recovery
    // read the EXISTING key back; it never re-signed one.
    expect(ov.hasAccount(ACCOUNT_DERIVED)).toBe(true)
    expect(await readKbTenantCredential(SPACE_ID, ENTERPRISE_ID).then(credential => credential?.accountId))
      .toBe(ACCOUNT_DERIVED)
    const auditTrail = readAudit(deviceB.workspaceRoot, binding)
    expect(auditTrail.some(entry => entry.action === 'openviking.tenant_recovered')).toBe(true)
    expect(auditTrail.some(entry => entry.action === 'openviking.binding_mismatch')).toBe(false)
  })

  it('keeps two enterprise spaces in two accounts with disjoint trees', async () => {
    const harness = useDevice()
    await seedPublished(harness, 'Handbook', {
      title: 'Vacation policy', content: 'Twenty days of paid vacation.',
    })

    // A DIFFERENT enterprise space: its own derivation, its own account.
    // The reader maps ps-two to the OTHER enterprise's owner view.
    setRuntimeActiveProductSpace('ps-two')
    // The test reader keeps the fixture name for every space, so the derived
    // account reuses the same slug with the OTHER space's hash.
    const otherAccount = kbTenantAccountId({
      productSpaceId: 'ps-two', enterpriseId: 'ent-two', spaceName: 'Example enterprise',
    })
    const otherCollection = await harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Other Handbook', description: '',
    }) as { id: string }
    expect(otherAccount).not.toBe(ACCOUNT_DERIVED)
    expect(ov.hasAccount(otherAccount)).toBe(true)

    // Back in the first space: the other space's collection is invisible.
    setRuntimeActiveProductSpace(SPACE_ID)
    const listing = await harness.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, {
      workspaceId: WORKSPACE_ID,
    }) as KbCollectionList
    expect(listing.collections.map(collection => collection.id)).not.toContain(otherCollection.id)
    const hits = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'vacation',
    }) as KbSearchHit[]
    expect(hits).toHaveLength(1)
    expect(hits[0]?.title).toBe('Vacation policy')
  })
})

describe('the recycle contract', () => {
  it('hides a deleted document from every listing while keeping it recoverable', async () => {
    const harness = useDevice()
    const collection = await harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Handbook', description: '',
    }) as { id: string; name: string }
    const document = await harness.invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
      title: 'Vacation policy', content: 'Twenty days.',
    }) as KbDocumentSummary
    await harness.invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
    await harness.invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: document.id })
    await harness.invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: document.id })

    // The soft delete is a real move into the hidden `.recycle/` subtree,
    // with the deleted status stamped on the moved file.
    const originalUri = kbDocumentUri(kbCollectionUri(collection.name, collection.id), document.title, document.id)
    const tree = ov.tree(ACCOUNT_DERIVED)
    expect(tree.has(originalUri)).toBe(false)
    const recycledName = originalUri.slice(originalUri.lastIndexOf('/') + 1)
    const recycled = tree.get(`viking://resources/.recycle/${recycledName}`)
    expect(recycled?.tags).toContain('status=deleted')
    // …the document endpoint no longer answers for it…
    expect(await harness.invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).toBeNull()
    // …the listing counts no published copy…
    const listing = await harness.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, {
      workspaceId: WORKSPACE_ID,
    }) as KbCollectionList
    expect(listing.collections[0]?.documentCounts.published).toBe(0)
    // …and retrieval cannot reach it. find itself WOULD index the recycled
    // node — the measured server behavior (brief §1) has no dot-visibility
    // filter — so what keeps it out is the contract: the store's
    // `status=published` tag filter, the collection-scope targets, and the
    // hit-attribution check all fail for a tombstoned file outside every
    // collection.
    const hits = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'vacation policy',
    }) as KbSearchHit[]
    expect(hits).toEqual([])
    // The claim above is checked against the fake directly: find with NO tag
    // filter does surface the recycled copy (dot content IS indexed).
    const raw = await fetch(`${ov.baseUrl}/api/v1/search/find`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ov.userKey(ACCOUNT_DERIVED)}` },
      body: JSON.stringify({ query: 'vacation', read_content: false }),
    })
    const payload = await raw.json() as { status: string; result: { resources: Array<{ uri: string }> } }
    expect(payload.status).toBe('ok')
    expect(payload.result.resources
      .some(resource => resource.uri.startsWith('viking://resources/.recycle/'))).toBe(true)
  })
})

describe('retrieval scoping', () => {
  it('restricts hits to the requested collections and ranks the title match first', async () => {
    const harness = useDevice()
    const first = await createCollection(harness, 'Handbook')
    const second = await createCollection(harness, 'Policies')
    await publishInto(harness, first, {
      title: 'Vacation policy', content: 'Twenty days of paid vacation for every employee.',
    })
    await publishInto(harness, second, {
      title: 'Equipment policy', content: 'Vacation laptops must be returned on exit.',
    })

    // Unscoped: both collections answer; the exact-title hit outranks the
    // body-only mention.
    const all = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'vacation',
    }) as KbSearchHit[]
    expect(all).toHaveLength(2)
    expect(all[0]?.title).toBe('Vacation policy')
    // Scoped to the second collection: only its document comes back.
    const scoped = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'vacation', collectionIds: [second.id],
    }) as KbSearchHit[]
    expect(scoped).toHaveLength(1)
    expect(scoped[0]?.collectionId).toBe(second.id)
    // Both scopes together are simply the union again.
    const union = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'vacation', collectionIds: [first.id, second.id],
    }) as KbSearchHit[]
    expect(union).toHaveLength(2)
  })

  it('drops find rows that no longer map into the space', async () => {
    const harness = useDevice()
    const collection = await createCollection(harness, 'Handbook')
    const document = await publishInto(harness, collection, {
      title: 'Vacation policy', content: 'Twenty days of paid vacation.',
    })
    // The backend answered with rows the index cannot map — a foreign uri, an
    // unknown doc id, a recycled one — plus the ONE row that really maps.
    const realUri = kbDocumentUri(
      kbCollectionUri(collection.name, collection.id), document.title, document.id,
    )
    // The mappable row carries the tags the store really wrote (the strict
    // parse needs doc/collection/title, not just the status).
    const realTags = [...(ov.tree(ACCOUNT_DERIVED).get(realUri)?.tags ?? [])]
    ov.setFindOverride([
      { uri: 'viking://resources/Foreign-kb-x/Gone-kb-y.md', score: 0.9, tags: realTags, content: 'foreign' },
      { uri: 'viking://resources/Handbook-kb-1/Unknown-kb-z.md', score: 0.8, tags: realTags, content: 'unknown' },
      { uri: 'viking://resources/.recycle/hidden-kb-r.md', score: 0.7, tags: realTags, content: 'hidden' },
      { uri: realUri, score: 0.6, tags: realTags, content: 'Twenty days of paid vacation.' },
    ])
    const hits = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'vacation',
    }) as KbSearchHit[]
    // The unmappable rows are gone and the survivor is THE document —
    // identity fields included, not just the title (review fix round B10:
    // a title-only assertion passed even when every row was foreign).
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ docId: document.id, collectionId: collection.id, title: 'Vacation policy' })
    // None of the injected rows' uris or bodies leaked through.
    const serialized = JSON.stringify(hits)
    expect(serialized).not.toContain('Foreign-kb-x')
    expect(serialized).not.toContain('Unknown-kb-z')
    expect(serialized).not.toContain('hidden-kb-r')
    expect(serialized).not.toContain('foreign')
    expect(serialized).not.toContain('.recycle')
  })

  it('drops find rows whose tags were rewritten to claim a foreign collection (review fix round B5)', async () => {
    // A backend row can carry tags that name a DIFFERENT collection than the
    // uri it arrived under — a stale, corrupted or hostile index. Attribution
    // re-derives the home collection from the uri itself and refuses the row
    // when the two disagree.
    const harness = useDevice()
    const first = await createCollection(harness, 'Handbook')
    const second = await createCollection(harness, 'Policies')
    const ours = await publishInto(harness, first, {
      title: 'Vacation policy', content: 'Twenty days of paid vacation.',
    })
    const theirs = await publishInto(harness, second, {
      title: 'Equipment policy', content: 'Vacation laptops must be returned on exit.',
    })
    const secondUri = kbDocumentUri(
      kbCollectionUri('Policies', second.id), theirs.title, theirs.id,
    )
    // Rewrite the row so its TAGS claim our first collection while its uri
    // still lives under the second one — the exact mismatch the check owns.
    const tree = ov.tree(ACCOUNT_DERIVED)
    const forgedTags = (tree.get(secondUri)?.tags ?? []).map(tag =>
      tag.startsWith('collection=') ? `collection=${first.id}` : tag)
    tree.set(secondUri, { ...(tree.get(secondUri)!), tags: forgedTags })
    ov.setFindOverride([
      { uri: secondUri, score: 0.95, tags: forgedTags, content: 'Vacation laptops must be returned on exit.' },
      {
        uri: kbDocumentUri(kbCollectionUri('Handbook', first.id), ours.title, ours.id),
        score: 0.5,
        tags: [...(tree.get(kbDocumentUri(kbCollectionUri('Handbook', first.id), ours.title, ours.id))?.tags ?? [])],
        content: 'Twenty days of paid vacation.',
      },
    ])
    const hits = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'vacation',
    }) as KbSearchHit[]
    // Only the row whose uri and tags agree survives; the forged row's body
    // never reaches the result.
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ docId: ours.id, collectionId: first.id })
    expect(JSON.stringify(hits)).not.toContain('laptops')
  })

  it('drops a forged SAME-collection row carrying a known document\'s full tag set (review fix round B5 residual)', async () => {
    // The prefix check alone cannot see an impostor INSIDE the real
    // collection directory: a file planted there with the published
    // document's complete tag set passes the doc-id, collection and uri-
    // prefix checks while disclosing a body the space never wrote. Only the
    // index's EXACT document uri pins the hit to the real body.
    const harness = useDevice()
    const collection = await createCollection(harness, 'Handbook')
    const document = await publishInto(harness, collection, {
      title: 'Vacation policy', content: 'Twenty days of paid vacation.',
    })
    // The impostor lives under the LIVE collection uri — every prefix agrees.
    const forgedUri = `${kbCollectionUri(collection.name, collection.id)}/Impostor-kb-00000000-0000-4000-8000-000000000000.md`
    const realUri = kbDocumentUri(kbCollectionUri(collection.name, collection.id), document.title, document.id)
    const realTags = [...(ov.tree(ACCOUNT_DERIVED).get(realUri)?.tags ?? [])]
    if (realTags.length === 0) throw new Error('real document tags missing')
    ov.setFindOverride([
      { uri: forgedUri, score: 0.99, tags: realTags, content: 'FORGED BODY — never disclosed' },
    ])
    const hits = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'vacation',
    }) as KbSearchHit[]
    expect(hits).toEqual([])
    expect(JSON.stringify(hits)).not.toContain('FORGED')
  })
})

/**
 * The review-fix-round hardening: each test reproduces the exact window a
 * review BLOCKER exposed, against the real request flow over the fake.
 */
describe('review fix round hardening', () => {
  /** The live uri of a document uploaded into a collection. */
  function liveUri(collection: { id: string; name: string }, document: { id: string; title: string }): string {
    return kbDocumentUri(kbCollectionUri(collection.name, collection.id), document.title, document.id)
  }

  it('refuses the write that follows an await once the space turns read-only (review fix round B2)', async () => {
    // The entry check passed, the delete began, and THEN the space turned
    // read-only (a verified-refresh restriction landing mid-flight). The
    // store must re-assert writability before EVERY remote write — the
    // status write may have landed, but nothing after it may leave.
    const harness = useDevice()
    const collection = await createCollection(harness, 'Handbook')
    const document = await harness.invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
      title: 'Vacation policy', content: 'Twenty days.',
    }) as KbDocumentSummary
    await harness.invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
    await harness.invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: document.id })

    // The delete flow: attrs → set_tags(status=deleted) → mkdir(.recycle) →
    // mv. The restriction lands while the fake serves the mkdir — between
    // two remote awaits, exactly where the old code stayed permissive.
    ov.armMutation({ method: 'POST', pathPrefix: '/api/v1/fs/mkdir' }, () => {
      setRuntimeProductSpaceRestricted(SPACE_ID, true)
    })
    // The publish above fires its transition log as a best-effort write that
    // settles asynchronously — let it land before the snapshot, or it would
    // show up as a post-mkdir content write it is not.
    await new Promise(resolve => setTimeout(resolve, 25))
    const requestsBefore = ov.requests.length
    await expect(harness.invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).rejects.toMatchObject({ code: 'kb_space_read_only' })

    // The mv never left: no request after the mkdir mutated anything, and
    // the live node still holds the partial deleted state (B7's resume input).
    const after = ov.requests.slice(requestsBefore)
    expect(after.some(request => request.path === '/api/v1/fs/mv')).toBe(false)
    expect(after.some(request => request.path === '/api/v1/content/write')).toBe(false)
    const tree = ov.tree(ACCOUNT_DERIVED)
    expect(tree.get(liveUri(collection, document))?.tags).toContain('status=deleted')
    expect(tree.has(`viking://resources/.recycle/${liveUri(collection, document).slice(liveUri(collection, document).lastIndexOf('/') + 1)}`)).toBe(false)
  })

  it('surfaces a same-status concurrent overwrite as kb_conflict on the read-back (review fix round B6)', async () => {
    // The publish flow: attrs (gate 1) → attrs (gate 2) → set_tags → attrs
    // (read-back). A concurrent writer lands BETWEEN the set_tags and the
    // read-back and overwrites the tags with the SAME status but its own
    // timestamps — invisible to a status-only comparison, caught by the
    // full-record one.
    const harness = useDevice()
    const collection = await createCollection(harness, 'Handbook')
    const document = await harness.invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
      title: 'Vacation policy', content: 'Twenty days.',
    }) as KbDocumentSummary
    await harness.invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })

    const uri = liveUri(collection, document)
    ov.armMutation({ method: 'GET', pathPrefix: '/api/v1/fs/attrs', nth: 3 }, tree => {
      const node = tree.get(uri)
      if (!node) throw new Error(`document node missing at ${uri}`)
      const stamped = encodeURIComponent('2030-01-01T00:00:00.000Z')
      node.tags = [
        ...node.tags.filter(tag => !tag.startsWith('updated=')),
        `updated=${stamped}`,
      ]
    })
    await expect(harness.invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).rejects.toMatchObject({ code: 'kb_conflict' })
    // The conflict detail names WHAT differed — diagnosable server-side,
    // neutral on the wire.
    const auditTrail = readAudit(harness.workspaceRoot, binding)
    const applied = auditTrail.find(entry => entry.action === 'document.publish')
    expect(applied).toBeUndefined()
  })

  it('resumes an interrupted soft delete when the retry runs (review fix round B7)', async () => {
    const harness = useDevice()
    const collection = await createCollection(harness, 'Handbook')
    const document = await publishInto(harness, collection, {
      title: 'Vacation policy', content: 'Twenty days.',
    })
    const uri = liveUri(collection, document)
    const recycledUri = `viking://resources/.recycle/${uri.slice(uri.lastIndexOf('/') + 1)}`
    // The mv times out ONCE: the store cannot know whether it landed
    // (outcome `unknown`), surfaces the failure, and the state is exactly
    // the interrupted one — status=deleted at the live uri, no recycled copy.
    ov.armFault({
      method: 'POST', pathPrefix: '/api/v1/fs/mv', times: 1,
      status: 504, code: 'DEADLINE_EXCEEDED', message: 'gateway timeout',
    })
    await expect(harness.invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).rejects.toMatchObject({ code: 'kb_service_unavailable' })
    expect(ov.tree(ACCOUNT_DERIVED).get(uri)?.tags).toContain('status=deleted')
    expect(ov.tree(ACCOUNT_DERIVED).has(recycledUri)).toBe(false)

    // The retry sees the tombstone at the live uri and RESUMES: no second
    // status write, straight to the move — and it completes.
    await harness.invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })
    const tree = ov.tree(ACCOUNT_DERIVED)
    expect(tree.has(uri)).toBe(false)
    expect(tree.get(recycledUri)?.tags).toContain('status=deleted')
    expect(await harness.invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).toBeNull()
    const deleteEntries = readAudit(harness.workspaceRoot, binding)
      .filter(entry => entry.action === 'document.delete')
    // The interrupted attempt left only its remote.mv intent/result pair —
    // the mutation entry follows the SUCCESS (review #15's ordering), so the
    // resumed completion is the one `document.delete` the trail holds.
    expect(deleteEntries).toHaveLength(1)
    expect(deleteEntries[0]?.detail).toMatchObject({ resumed: true })
    // The first attempt's move is on the trail as an `unknown` outcome: the
    // timeout means the move MAY have landed.
    const mvResults = readAudit(harness.workspaceRoot, binding)
      .filter(entry => entry.action === 'remote.mv.result')
    expect(mvResults[0]?.detail).toMatchObject({ outcome: 'unknown' })
    expect(mvResults.at(-1)?.detail).toMatchObject({ outcome: 'success' })
  })

  it('records a failed remote write as intent → failed result with one request id (review fix round B8)', async () => {
    const harness = useDevice()
    const collection = await createCollection(harness, 'Handbook')
    const document = await harness.invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
      title: 'Vacation policy', content: 'Twenty days.',
    }) as KbDocumentSummary
    await harness.invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
    // The publish's set_tags fails server-side: the audit must carry the
    // intent, THEN the failed result — correlated, with the raw reason kept
    // off the wire but in the trail.
    ov.armFault({
      method: 'POST', pathPrefix: '/api/v1/fs/attrs/set_tags', times: 1,
      status: 500, code: 'INTERNAL', message: 'storage exploded',
    })
    await expect(harness.invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).rejects.toMatchObject({ code: 'kb_service_unavailable' })

    const auditTrail = readAudit(harness.workspaceRoot, binding)
    const tagIntents = auditTrail.filter(entry => entry.action === 'remote.set_tags.intent')
    const tagResults = auditTrail.filter(entry => entry.action === 'remote.set_tags.result')
    expect(tagIntents.length).toBe(tagResults.length)
    const failed = tagResults.at(-1)
    expect(failed?.detail).toMatchObject({ outcome: 'failed' })
    expect(JSON.stringify(failed?.detail)).toContain('storage exploded')
    const matchingIntent = tagIntents.find(entry => entry.detail?.requestId === failed?.detail?.requestId)
    expect(matchingIntent).toBeDefined()
    expect(auditTrail.indexOf(matchingIntent!)).toBeLessThan(auditTrail.indexOf(failed!))
    // The document never became published.
    expect(ov.tree(ACCOUNT_DERIVED).get(liveUri(collection, document))?.tags).toContain('status=in_review')
  })

  it('keeps the established binding when the space is renamed (review fix round R1)', async () => {
    const harness = useDevice()
    await createCollection(harness, 'Handbook')
    const adminCalls = () => ov.requests.filter(request => request.path.startsWith('/api/v1/admin/')).length
    const adminCallsBefore = adminCalls()

    // Rename: the reader reports a new name, so the slug part of the
    // derivation changes while the hash — and therefore the real account —
    // stays the same.
    setKbActiveProductSpaceReaderForTests(
      (_accountId, productSpaceId) => (productSpaceId === SPACE_ID
        ? { ...ownerSpace(), name: 'Renamed Enterprise' }
        : null) as never,
    )
    const renamedDerived = kbTenantAccountId({
      productSpaceId: SPACE_ID, enterpriseId: ENTERPRISE_ID, spaceName: 'Renamed Enterprise',
    })
    expect(renamedDerived).not.toBe(ACCOUNT_DERIVED)
    await createCollection(harness, 'Policies')

    // The binding was REUSED, never rebuilt: no second account, no new
    // admin-plane call, and the drift is recorded as an audit entry.
    expect(ov.hasAccount(renamedDerived)).toBe(false)
    expect(await readKbTenantCredential(SPACE_ID, ENTERPRISE_ID).then(credential => credential?.accountId))
      .toBe(ACCOUNT_DERIVED)
    expect(adminCalls()).toBe(adminCallsBefore)
    const drift = readAudit(harness.workspaceRoot, binding)
      .find(entry => entry.action === 'openviking.binding_name_drift')
    expect(drift?.detail).toMatchObject({ derived: renamedDerived, bound: ACCOUNT_DERIVED })
    // The renamed space's collection landed in the SAME account.
    const listing = await harness.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, {
      workspaceId: WORKSPACE_ID,
    }) as KbCollectionList
    expect(listing.collections.map(entry => entry.name).sort()).toEqual(['Handbook', 'Policies'])
  })

  it('counts a tenant larger than one ls page exactly once (review fix round R2)', async () => {
    // KB_LS_PAGE_NODES is 2000: seeding 2050 published documents forces the
    // walk across the page boundary. An off-by-one page walk (a skipped or
    // duplicated tail page) would miss or double-count the boundary docs.
    const harness = useDevice()
    const collection = await createCollection(harness, 'Handbook')
    const collectionUri = kbCollectionUri(collection.name, collection.id)
    const TOTAL = 2050
    const stamp = encodeURIComponent(new Date().toISOString())
    for (let index = 0; index < TOTAL; index += 1) {
      const docId = `kb-r2-${String(index).padStart(5, '0')}`
      ov.putNode(ACCOUNT_DERIVED, {
        uri: `${collectionUri}/R2 bulk ${String(index).padStart(5, '0')} ${docId}.md`,
        type: 'file',
        content: `Bulk document ${index}.`,
        tags: [
          `doc=${docId}`,
          `collection=${collection.id}`,
          'status=published',
          `title=${encodeURIComponent(`R2 bulk ${String(index).padStart(5, '0')}`)}`,
          'v=1',
          `created=${stamp}`,
          `updated=${stamp}`,
          `published=${stamp}`,
        ],
      })
    }
    const listing = await harness.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, {
      workspaceId: WORKSPACE_ID,
    }) as KbCollectionList
    expect(listing.collections.find(entry => entry.id === collection.id)?.documentCounts.published).toBe(TOTAL)
    // Retrieval still works across the boundary — the walk feeds attribution.
    const hits = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'R2 bulk 02049',
    }) as KbSearchHit[]
    expect(hits.map(hit => hit.title)).toContain('R2 bulk 02049')
  })

  it('confirms a recycle move that landed past its own response (review fix round B7 residual a)', async () => {
    // The 504 fault of the earlier test covers "the move never left". THIS
    // side of the same B7 window is the opposite: the move EXECUTED but its
    // response was lost. The mutation hook performs the move for real, so
    // the actual mv request arrives to find `from` gone and fails with 404 —
    // then the read-back of the recycle target must recognize the moved
    // tombstone (which the strict wire parser rejects) as success.
    const harness = useDevice()
    const collection = await createCollection(harness, 'Handbook')
    const document = await publishInto(harness, collection, {
      title: 'Vacation policy', content: 'Twenty days.',
    })
    const uri = liveUri(collection, document)
    const recycledUri = `viking://resources/.recycle/${uri.slice(uri.lastIndexOf('/') + 1)}`
    ov.armMutation({ method: 'POST', pathPrefix: '/api/v1/fs/mv' }, tree => {
      const node = tree.get(uri)
      if (!node) return
      tree.delete(uri)
      tree.set(recycledUri, { ...node, uri: recycledUri })
    })
    await harness.invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })
    const tree = ov.tree(ACCOUNT_DERIVED)
    expect(tree.has(uri)).toBe(false)
    expect(tree.get(recycledUri)?.tags).toContain('status=deleted')
    expect(await harness.invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).toBeNull()
  })

  it('answers an already-recycled document with idempotent success, never not-found (review fix round B7 residual b)', async () => {
    // Both the move AND its confirmation were lost: the live uri holds
    // nothing while `.recycle/` holds the tombstone. A retry that only
    // resolves the live path answers kb_document_not_found forever — the
    // recycle-side lookup completes the delete instead.
    const harness = useDevice()
    const collection = await createCollection(harness, 'Handbook')
    const document = await publishInto(harness, collection, {
      title: 'Vacation policy', content: 'Twenty days.',
    })
    const uri = liveUri(collection, document)
    const recycledUri = `viking://resources/.recycle/${uri.slice(uri.lastIndexOf('/') + 1)}`
    const tree = ov.tree(ACCOUNT_DERIVED)
    const node = tree.get(uri)
    if (!node) throw new Error('the document node is missing')
    tree.delete(uri)
    tree.set(recycledUri, {
      ...node,
      uri: recycledUri,
      tags: node.tags.map(tag => tag.startsWith('status=') ? 'status=deleted' : tag),
    })
    await harness.invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })
    expect(readAudit(harness.workspaceRoot, binding)
      .some(entry => entry.action === 'document.delete' && entry.detail?.alreadyRecycled === true))
      .toBe(true)
    expect(await harness.invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).toBeNull()
  })

  it('rides the lost-response chain: the retry confirms the move the failed call already landed (review fix round B7 residual c)', async () => {
    // Residual a ends happy INSIDE one call: the store's read-back absorbs a
    // lost mv answer. This is the longer chain the wire really produces when
    // BOTH answers are lost — the mv executed server-side, its own response
    // never reached the client, and the read-back confirmation died with it.
    // The first call must surface the failure (the store cannot know the move
    // landed), and the RETRY must confirm from the recycle path — never
    // not-found.
    const harness = useDevice()
    const collection = await createCollection(harness, 'Handbook')
    const document = await publishInto(harness, collection, {
      title: 'Vacation policy', content: 'Twenty days.',
    })
    const uri = liveUri(collection, document)
    const recycledUri = `viking://resources/.recycle/${uri.slice(uri.lastIndexOf('/') + 1)}`
    // The mutation hook IS the mv executing for real: the node leaves the live
    // path and lands in `.recycle/` with the tombstone the status write wrote.
    // It fires when the fake SERVES the mv — after the delay below — so the
    // store's own read-back confirmation runs EARLIER, while the move is still
    // in flight, and reads an empty recycle target: both answers are lost (the
    // response as a timeout, the confirmation as a miss), which is exactly the
    // interrupted state residual a's single-call read-back would have absorbed.
    ov.armMutation({ method: 'POST', pathPrefix: '/api/v1/fs/mv' }, tree => {
      const node = tree.get(uri)
      if (!node) return
      tree.delete(uri)
      tree.set(recycledUri, { ...node, uri: recycledUri })
    })
    ov.setDelay('/api/v1/fs/mv', 400)
    setOpenVikingTimeoutsForTests({ writeMs: 100 })
    try {
      // Call 1: the client sees the failure — no mv answer ever arrived, and
      // the confirmation read died with it.
      await expect(harness.invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
        workspaceId: WORKSPACE_ID, docId: document.id,
      })).rejects.toMatchObject({ code: 'kb_service_unavailable' })
    } finally {
      // The shrunken deadline must not outlive the window, whatever it did.
      resetOpenVikingTimeoutsForTests()
      ov.setDelay('/api/v1/fs/mv', 0)
    }
    // The move is still in flight server-side: the fake serves it after the
    // delay, past the client's give-up — that IS the lost-response window.
    for (let waitedMs = 0; !ov.tree(ACCOUNT_DERIVED).has(recycledUri) && waitedMs < 2_000; waitedMs += 20) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    // ...and the storage side holds the completed recycle.
    const tree = ov.tree(ACCOUNT_DERIVED)
    expect(tree.has(uri)).toBe(false)
    expect(tree.get(recycledUri)?.tags).toContain('status=deleted')
    // The lost answer is on the trail as `unknown` — the move MAY have landed
    // (B8's classification) — and the failed attempt never claimed the delete.
    const mvResults = readAudit(harness.workspaceRoot, binding)
      .filter(entry => entry.action === 'remote.mv.result')
    expect(mvResults).toHaveLength(1)
    expect(mvResults[0]?.detail).toMatchObject({ outcome: 'unknown' })
    expect(readAudit(harness.workspaceRoot, binding)
      .some(entry => entry.action === 'document.delete')).toBe(false)
    // Call 2 (the retry): confirmed from the recycle path — the SAME
    // `{recycled: true}` a fresh delete answers, never not-found.
    expect(await harness.invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).toEqual({ recycled: true })
    const deleteEntries = readAudit(harness.workspaceRoot, binding)
      .filter(entry => entry.action === 'document.delete')
    expect(deleteEntries).toHaveLength(1)
    expect(deleteEntries[0]?.detail).toMatchObject({ alreadyRecycled: true })
    // And the tombstone never resurfaces on the live face.
    expect(await harness.invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).toBeNull()
  })

  it('audits the provisioning writes with the intent/result discipline (review fix round B8 residual)', async () => {
    const harness = useDevice()
    await harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Handbook', description: '',
    })
    const trail = readAudit(harness.workspaceRoot, binding)
    // Account creation AND the ownership marker are remote writes that may
    // land past a timeout — both carry intent → result pairs correlated by
    // a request id, with the intent ahead of its result.
    for (const action of ['remote.create_account', 'remote.set_tags']) {
      const intents = trail.filter(entry => entry.action === `${action}.intent`)
      const results = trail.filter(entry => entry.action === `${action}.result`)
      expect(intents.length).toBeGreaterThan(0)
      expect(intents.length).toBe(results.length)
      for (const result of results) {
        expect(result.detail?.outcome).toBe('success')
        const intent = intents.find(entry => entry.detail?.requestId === result.detail?.requestId)
        expect(intent).toBeDefined()
        expect(trail.indexOf(intent!)).toBeLessThan(trail.indexOf(result))
      }
    }
    // The marker write is the audited set_tags against the account root.
    expect(trail.some(entry => entry.action === 'remote.set_tags.intent'
      && entry.target === 'viking://resources/')).toBe(true)
  })

  it('records a failed account creation as a failed audited result (review fix round B8 residual)', async () => {
    const harness = useDevice()
    ov.armFault({
      method: 'POST', pathPrefix: '/api/v1/admin/accounts', times: 1,
      status: 500, code: 'INTERNAL', message: 'admin plane exploded',
    })
    await expect(harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Handbook', description: '',
    })).rejects.toMatchObject({ code: 'kb_service_unavailable', message: KB_SERVICE_UNAVAILABLE_MESSAGE })
    const results = readAudit(harness.workspaceRoot, binding)
      .filter(entry => entry.action === 'remote.create_account.result')
    expect(results).toHaveLength(1)
    expect(results[0]?.detail).toMatchObject({ outcome: 'failed' })
    // The raw cause stays in the trail (server-side only), off the wire.
    expect(JSON.stringify(results[0]?.detail)).toContain('admin plane exploded')
    const intents = readAudit(harness.workspaceRoot, binding)
      .filter(entry => entry.action === 'remote.create_account.intent')
    expect(intents).toHaveLength(1)
  })

  it('marks a walk that hit the page cap as truncated with prefix-exact counts (review fix round R2 residual)', async () => {
    // The walk stops at 10 pages × 2000 nodes = 20000. A tenant ONE node past
    // that cap must report `truncated` and count EXACTLY the prefix — an
    // overlap would inflate, a skip would silently lose a document.
    const harness = useDevice()
    const collection = await createCollection(harness, 'Handbook')
    const collectionUri = kbCollectionUri(collection.name, collection.id)
    const CAP = 20_000
    const stamp = encodeURIComponent(new Date().toISOString())
    for (let index = 0; index < CAP + 1; index += 1) {
      const docId = `kb-cap-${String(index).padStart(6, '0')}`
      ov.putNode(ACCOUNT_DERIVED, {
        uri: `${collectionUri}/Cap bulk ${String(index).padStart(6, '0')} ${docId}.md`,
        type: 'file',
        content: `Cap bulk document ${index}.`,
        tags: [
          `doc=${docId}`,
          `collection=${collection.id}`,
          'status=published',
          `t=${Buffer.from(`Cap bulk ${String(index).padStart(6, '0')}`, 'utf-8').toString('hex')}`,
          `title=${encodeURIComponent(`Cap bulk ${String(index).padStart(6, '0')}`)}`,
          'v=1',
          `created=${stamp}`,
          `updated=${stamp}`,
          `published=${stamp}`,
        ],
      })
    }
    const index = await loadKbIndex(await ovSpace())
    expect(index.truncated).toBe(true)
    // The walk's 20000-node budget counts the collection directory too, so
    // the counted prefix is CAP minus that one directory. An overlap would
    // inflate past it, a skipped page would land short of it.
    expect(index.collections.get(collection.id)?.documentCounts.published).toBe(CAP - 1)
    // The prefix stays consistent for retrieval too — the last counted row
    // answers a search, the first row past the truncation line never does
    // (the scored query shares its other tokens with every row, so the
    // assertion is membership, not exclusivity).
    const hits = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'cap bulk 019998',
    }) as KbSearchHit[]
    expect(hits.map(hit => hit.title)).toContain('Cap bulk 019998')
    const pastTheLine = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'cap bulk 019999',
    }) as KbSearchHit[]
    expect(pastTheLine.map(hit => hit.title)).not.toContain('Cap bulk 019999')
  })
})

/**
 * The measured-instance round (brief §1, e2e 2026-10-21): two behaviors the
 * REAL OpenViking v0.5.1.1 exhibits that the fake originally did not — the
 * directory tag loss window (E1) and the tag value lower-casing (E2). Both
 * are pinned HERE against the fake that now reproduces them, so a future
 * regression on either side re-fails these.
 */
describe('measured instance hardening', () => {
  /** Counts the set_tags requests the store aimed at one uri. */
  function setTagsRequestsTo(uri: string): number {
    return ov.requests.filter(request => request.method === 'POST'
      && request.path === '/api/v1/fs/attrs/set_tags'
      && (request.body as { uri?: string } | null)?.uri === uri).length
  }

  it('waits the ingestion pipeline out and lands the collection tags on the first write (e2e E1, 4s window)', async () => {
    // The measured instance runs an ingestion pipeline over every fresh
    // directory and rebuilds its attributes on completion, wiping a set_tags
    // issued inside the window (~4s in semantic mode) while answering `ok`.
    // The verified write therefore waits the pipeline out through
    // `system/wait` FIRST, so the one write it issues sticks — the poll loop
    // below stays the fallback, not the plan.
    const harness = useDevice()
    ov.setDirectoryTagLossWindow(4_000)
    try {
      const collection = await createCollection(harness, 'Latency Handbook')
      const uri = kbCollectionUri(collection.name, collection.id)
      // The wait happened, and the write came after it — the pipeline was
      // already drained when the tags were written.
      const waitIndex = ov.requests.findIndex(request => request.method === 'POST'
        && request.path === '/api/v1/system/wait')
      const writeIndex = ov.requests.findIndex(request => request.method === 'POST'
        && request.path === '/api/v1/fs/attrs/set_tags'
        && (request.body as { uri?: string } | null)?.uri === uri)
      expect(waitIndex).toBeGreaterThanOrEqual(0)
      expect(writeIndex).toBeGreaterThan(waitIndex)
      // Exactly one write: the drained pipeline took it on the first attempt.
      expect(setTagsRequestsTo(uri)).toBe(1)
      // The tags are in place on the remote tree, byte-exact through the
      // lower-casing service (the hex keys are the authority, E2).
      const node = ov.tree(ACCOUNT_DERIVED).get(uri)
      expect(node?.tags).toContain(`collection=${collection.id}`)
      expect(node?.tags).toContain(`n=${kbTagHexEncode(collection.name)}`)
      // The verified write is one audited remote operation whose result
      // carries the retry detail — a first-attempt success here.
      const verified = readAudit(harness.workspaceRoot, binding)
        .filter(entry => entry.action === 'remote.directory_tags.result'
          && entry.target === uri)
      expect(verified).toHaveLength(1)
      expect(verified[0]?.detail).toMatchObject({ outcome: 'success', attempts: 1 })
      const listing = await harness.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, {
        workspaceId: WORKSPACE_ID,
      }) as KbCollectionList
      expect(listing.collections.find(entry => entry.id === collection.id)?.name).toBe('Latency Handbook')
    } finally {
      ov.setDirectoryTagLossWindow(0)
    }
  }, 20_000)

  it('gives up with kb_service_unavailable and audits the retry detail when the pipeline outlasts the window (e2e E1 bound)', async () => {
    const harness = useDevice()
    await createCollection(harness, 'Handbook')
    // A pipeline no bounded window outlives: the collection directory NEVER
    // takes its tags, so the write must fail loudly instead of listing a
    // collection whose identity tags are gone. The three bounds are the
    // production seams, shrunk to keep the wall clock out of the test: the
    // pipeline (30s > any client bound), the client's wait timeout (raced
    // out and ABSORBED — a failed wait is never fatal) and the 12s window
    // the poll loop runs inside.
    ov.setDirectoryTagLossWindow(30_000)
    setKbDirectoryTagWindowForTests(600)
    setKbDirectoryTagRetryDelayForTests(50)
    setOpenVikingTimeoutsForTests({ waitMs: 120 })
    try {
      await expect(harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
        workspaceId: WORKSPACE_ID, name: 'Frozen', description: '',
      })).rejects.toMatchObject({ code: 'kb_service_unavailable', message: KB_SERVICE_UNAVAILABLE_MESSAGE })
      // More than one write was attempted — the loop really polled — and the
      // failures were absorbed waits, each raced against the client timeout.
      const frozenAttempts = ov.requests.filter(request => request.method === 'POST'
        && request.path === '/api/v1/fs/attrs/set_tags'
        && (request.body as { uri?: string } | null)?.uri?.includes('Frozen')).length
      expect(frozenAttempts).toBeGreaterThanOrEqual(2)
      expect(ov.requests.filter(request => request.method === 'POST'
        && request.path === '/api/v1/system/wait').length).toBeGreaterThanOrEqual(frozenAttempts)
      // The loop's own audit pair carries the retry detail: how far the
      // window got, and that the waits failed rather than the writes.
      const results = readAudit(harness.workspaceRoot, binding)
        .filter(entry => entry.action === 'remote.directory_tags.result'
          && entry.target.includes('Frozen'))
      expect(results).toHaveLength(1)
      expect(results[0]?.detail).toMatchObject({
        outcome: 'failed',
        attempts: frozenAttempts,
        waitFailures: frozenAttempts,
      })
      // The raw cause rides in the same entry (B8) — the window, the attempt
      // count and the wait spend are all in the trail, off the wire.
      const cause = String(results[0]?.detail?.cause)
      expect(cause).toContain('did not stick within 600ms')
      expect(cause).toContain(String(frozenAttempts))
      // A collection whose tags never landed was never reported created.
      expect(readAudit(harness.workspaceRoot, binding)
        .filter(entry => entry.action === 'collection.create')
        .map(entry => entry.detail)).not.toContainEqual({ name: 'Frozen' })
    } finally {
      ov.setDirectoryTagLossWindow(0)
      resetKbDirectoryTagWindowForTests()
      resetKbDirectoryTagRetryDelayForTests()
      resetOpenVikingTimeoutsForTests()
    }
  }, 15_000)

  it('fails the run when a single request outlasts the window instead of reporting success (review round N1)', async () => {
    // The window used to bound only the waits BETWEEN requests: a write that
    // took 95ms against a 60ms window still handed back a verified success at
    // ~98ms — the promised bound was decorative. Now the write AND its
    // read-back race the remaining budget, so a window smaller than one
    // request exhausts the run: the loop must answer the neutral availability
    // error, never a success it could not verify inside the promise.
    const harness = useDevice()
    await createCollection(harness, 'Handbook')
    setKbDirectoryTagWindowForTests(60)
    // The retry interval stays at its production 1s, so the loop's wait step
    // draws no budget at all — the single slow request IS the whole story.
    ov.setDelay('/api/v1/fs/attrs/set_tags', 95)
    try {
      await expect(harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
        workspaceId: WORKSPACE_ID, name: 'Raced', description: '',
      })).rejects.toMatchObject({ code: 'kb_service_unavailable', message: KB_SERVICE_UNAVAILABLE_MESSAGE })
      // The attempt is counted even though the request threw past the budget:
      // the write was dispatched (its set_tags pair is on the trail), so the
      // result must report one attempt, not zero.
      const results = readAudit(harness.workspaceRoot, binding)
        .filter(entry => entry.action === 'remote.directory_tags.result'
          && entry.target.includes('Raced'))
      expect(results).toHaveLength(1)
      expect(results[0]?.detail).toMatchObject({ outcome: 'failed', attempts: 1 })
      // The request itself did leave — it was the budget that gave up on it.
      expect(ov.requests.some(request => request.method === 'POST'
        && request.path === '/api/v1/fs/attrs/set_tags'
        && ((request.body as { uri?: string } | null)?.uri ?? '').includes('Raced'))).toBe(true)
      // A collection whose tags were never verified inside the window was
      // never reported created.
      expect(readAudit(harness.workspaceRoot, binding)
        .filter(entry => entry.action === 'collection.create')
        .map(entry => entry.detail)).not.toContainEqual({ name: 'Raced' })
    } finally {
      ov.setDelay('/api/v1/fs/attrs/set_tags', 0)
      resetKbDirectoryTagWindowForTests()
    }
  }, 15_000)

  it('never lets the pipeline wait outlive the window — the write still gets its turn (e2e E1 bound)', async () => {
    // Review round M1, scenario A: the deadline used to be checked only at
    // the loop top, so a wait entering at t=11.9s ran to its own 12s timeout
    // and pushed the write to ~2× the promised window. The wait now draws a
    // budget of what REMAINS of the window minus one poll interval — pinned
    // here with the production waitMs (12s) against a 600ms window: the wait
    // must give up at ~550ms, absorbed, and the exhausted run must report the
    // window it actually spent, not the timeout it wanted.
    const harness = useDevice()
    await createCollection(harness, 'Handbook')
    ov.setDirectoryTagLossWindow(30_000)
    setKbDirectoryTagWindowForTests(600)
    setKbDirectoryTagRetryDelayForTests(50)
    try {
      await expect(harness.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
        workspaceId: WORKSPACE_ID, name: 'Bounded', description: '',
      })).rejects.toMatchObject({ code: 'kb_service_unavailable' })
      const results = readAudit(harness.workspaceRoot, binding)
        .filter(entry => entry.action === 'remote.directory_tags.result'
          && entry.target.includes('Bounded'))
      expect(results).toHaveLength(1)
      const detail = results[0]?.detail as { attempts?: number; waitedMs?: number; waitFailures?: number }
      expect(detail.attempts).toBe(1)
      expect(detail.waitFailures).toBe(1)
      // The wait spent the REMAINING window, never its own 12s ceiling.
      expect(detail.waitedMs).toBeLessThanOrEqual(600)
    } finally {
      ov.setDirectoryTagLossWindow(0)
      resetKbDirectoryTagWindowForTests()
      resetKbDirectoryTagRetryDelayForTests()
    }
  }, 15_000)

  it('polls a dropped write back onto the directory once the pipeline drains (e2e E1)', async () => {
    // Review round M1, scenario B: with the wait timeout at the window's
    // length the poll loop was unreachable — one silent wait ate everything.
    // Here the wait keeps timing out (120ms against a 1.75s pipeline — off
    // the poll cycle's multiples, so the drain never collides with a write)
    // while the 4s window has room to poll, so the tags land on a LATER
    // attempt: the poll is the fallback that actually catches a loss.
    const harness = useDevice()
    await createCollection(harness, 'Handbook')
    ov.setDirectoryTagLossWindow(1_750)
    setKbDirectoryTagWindowForTests(4_000)
    setKbDirectoryTagRetryDelayForTests(50)
    setOpenVikingTimeoutsForTests({ waitMs: 120 })
    try {
      const collection = await createCollection(harness, 'Polled Handbook')
      const uri = kbCollectionUri(collection.name, collection.id)
      const node = ov.tree(ACCOUNT_DERIVED).get(uri)
      expect(node?.tags).toContain(`collection=${collection.id}`)
      expect(node?.tags).toContain(`n=${kbTagHexEncode(collection.name)}`)
      // More than one write went out — the poll really ran — and every wait
      // along the way timed out against the pipeline rather than failing the
      // write (the absorbed-wait discipline).
      expect(setTagsRequestsTo(uri)).toBeGreaterThanOrEqual(2)
      const verified = readAudit(harness.workspaceRoot, binding)
        .filter(entry => entry.action === 'remote.directory_tags.result'
          && entry.target === uri)
      expect(verified).toHaveLength(1)
      const detail = verified[0]?.detail as { attempts?: number; waitFailures?: number; outcome?: string }
      expect(detail.outcome).toBe('success')
      expect(detail.attempts ?? 0).toBeGreaterThanOrEqual(2)
      expect(detail.waitFailures).toBe((detail.attempts ?? 1) - 1)
    } finally {
      ov.setDirectoryTagLossWindow(0)
      resetKbDirectoryTagWindowForTests()
      resetKbDirectoryTagRetryDelayForTests()
      resetOpenVikingTimeoutsForTests()
    }
  }, 15_000)

  it('keeps title, reject reason and collection name byte-exact past the lower-casing service (e2e E2)', async () => {
    // The measured instance lower-cases EVERY tag value. The readable
    // `title=`/`reject=`/`name=` copies therefore come back distorted — the
    // hex-carried `t=`/`r=`/`n=` keys are the authority, and every read path
    // must prefer them.
    const harness = useDevice()
    const NAME = 'Q3 Annual LEAVE Handbook'
    const TITLE = 'Annual LEAVE Policy'
    const REASON = 'Rejected By ADMIN'
    const collection = await createCollection(harness, NAME)
    const document = await harness.invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id, title: TITLE, content: 'Twenty days.',
    }) as KbDocumentSummary
    await harness.invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
    await harness.invoke(RPC_CHANNELS.kb.REJECT_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id, reason: REASON,
    })

    // The wire holds the distorted readable copy NEXT TO the exact hex value
    // — this is the anchor proving the lower-casing is really in play.
    const docUri = kbDocumentUri(kbCollectionUri(NAME, collection.id), TITLE, document.id)
    const docTags = ov.tree(ACCOUNT_DERIVED).get(docUri)?.tags ?? []
    expect(docTags).toContain(`t=${kbTagHexEncode(TITLE)}`)
    expect(docTags).toContain('title=annual%20leave%20policy')
    expect(docTags).toContain(`r=${kbTagHexEncode(REASON)}`)
    const collectionTags = ov.tree(ACCOUNT_DERIVED).get(kbCollectionUri(NAME, collection.id))?.tags ?? []
    expect(collectionTags).toContain(`n=${kbTagHexEncode(NAME)}`)
    expect(collectionTags).toContain('name=q3%20annual%20leave%20handbook')

    // Every read path decodes back to the byte-exact value.
    const rejected = await harness.invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    }) as KbDocument
    expect(rejected.title).toBe(TITLE)
    expect(rejected.rejectReason).toBe(REASON)
    // The state machine only re-opens a rejected document through draft.
    await harness.invoke(RPC_CHANNELS.kb.REVERT_TO_DRAFT, { workspaceId: WORKSPACE_ID, docId: document.id })
    await harness.invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
    await harness.invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: document.id })
    const published = await harness.invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    }) as KbDocument
    expect(published.title).toBe(TITLE)
    expect(published.rejectReason).toBeNull()
    const listing = await harness.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, {
      workspaceId: WORKSPACE_ID,
    }) as KbCollectionList
    expect(listing.collections.find(entry => entry.id === collection.id)?.name).toBe(NAME)
    const hits = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'annual leave',
    }) as KbSearchHit[]
    expect(hits.map(hit => hit.title)).toContain(TITLE)
  })
})
