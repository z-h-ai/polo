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
  readAudit,
  KB_SERVICE_UNAVAILABLE_MESSAGE,
} from '../../../knowledge-base/store'
import { kbTenantAccountId, readKbTenantCredential } from '../../../knowledge-base/tenant'
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
    expect(root?.tags).toContain(`polo_space=${SPACE_ID}`)
    expect(root?.tags).toContain(`polo_enterprise=${ENTERPRISE_ID}`)
    // The binding is cached for the NEXT call — reads and sends never
    // re-enter the admin plane.
    const credential = await readKbTenantCredential(SPACE_ID, ENTERPRISE_ID)
    expect(credential?.accountId).toBe(ACCOUNT_DERIVED)
    expect(credential?.apiKey).toBe(ov.userKey(ACCOUNT_DERIVED))
  })

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

    // Device B: fresh workspace, wiped credential store — reads refuse (they
    // never provision); one managing RPC restores the binding.
    currentCredentials.clear()
    const deviceB = useDevice()
    await expect(deviceB.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }))
      .rejects.toMatchObject({ code: 'kb_service_unavailable' })
    await deviceB.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Policies', description: '',
    })

    // One shared tenant: B sees A's collection AND document.
    const listing = await deviceB.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, {
      workspaceId: WORKSPACE_ID,
    }) as KbCollectionList
    expect(listing.collections.map(collection => collection.name).sort()).toEqual(['Handbook', 'Policies'])
    const fetched = await deviceB.invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    }) as KbDocument
    expect(fetched.title).toBe('Vacation policy')
    expect(fetched.content).toContain('twenty days')
    // Both devices derived the SAME account — one tree, not two.
    expect(ov.hasAccount(ACCOUNT_DERIVED)).toBe(true)
    expect(await readKbTenantCredential(SPACE_ID, ENTERPRISE_ID).then(credential => credential?.accountId))
      .toBe(ACCOUNT_DERIVED)
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
    // …and retrieval cannot reach it (the fake hides dot content from find).
    const hits = await harness.invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'vacation policy',
    }) as KbSearchHit[]
    expect(hits).toEqual([])
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
    expect(hits.map(hit => hit.title)).toEqual(['Vacation policy'])
  })
})
