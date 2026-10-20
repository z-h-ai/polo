import { afterEach, afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { KbCollection, KbDocument, KbDocumentSummary, KbSearchHit } from '@polo-ai/shared/protocol'
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
  kbRootPath,
  kbSpaceSegment,
  readAudit,
  readOpenVikingSpaceMeta,
} from '../../../knowledge-base/store'
import { resetOpenVikingTimeoutsForTests } from '../../../knowledge-base/openviking-client'

/**
 * OpenViking integration tests for the KB RPC surface (POO-108 v2): space
 * provisioning at collection creation, the publish sync and its failure
 * degradation, OpenViking-backed search with the local fallback, and the
 * best-effort remote cleanup on revert/delete. The stub asserts the verified
 * wire shapes literally.
 */

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = 'ws-one'
const SPACE_ID = 'ps-one'
const ENTERPRISE_ID = 'ent-one'

function enterpriseSpace() {
  return {
    id: SPACE_ID,
    kind: 'enterprise' as const,
    enterpriseId: ENTERPRISE_ID,
    name: 'Example enterprise',
    role: 'owner' as const,
    accessMode: 'active' as const,
    payer: { kind: 'enterprise' as const, enterpriseId: ENTERPRISE_ID },
  }
}

let tempDir: string
let workspaceRoot: string

function spaceDir(): string {
  return kbRootPath(workspaceRoot, { productSpaceId: SPACE_ID, enterpriseId: ENTERPRISE_ID })
}

function binding() {
  return { productSpaceId: SPACE_ID, enterpriseId: ENTERPRISE_ID }
}

function spaceRootUri(): string {
  return `viking://resources/entspace-${kbSpaceSegment(SPACE_ID)}`
}

/** The mutable stub behavior one test configures ahead of its RPC calls. */
const stub = {
  resources: [] as Array<{ uri: string; score: number; tags: string[] }>,
  failAddWith: null as number | null,
  failDeleteWith: null as number | null,
}

interface RecordedRequest {
  method: string
  path: string
  body: Record<string, unknown> | null
  file: { name: string; content: string } | null
}

const requests: RecordedRequest[] = []

const server = Bun.serve({
  port: 0,
  fetch: async request => {
    const url = new URL(request.url)
    const contentType = request.headers.get('content-type') ?? ''
    let body: Record<string, unknown> | null = null
    let file: { name: string; content: string } | null = null
    if (contentType.startsWith('multipart/form-data')) {
      // The Bun/undici `File` type vs the lib `FormData` entry value disagree,
      // so the file is read through the runtime shape it actually has.
      const uploaded = (await request.formData()).get('file') as File | null
      if (uploaded instanceof Blob) {
        file = { name: uploaded.name, content: await uploaded.text() }
      }
    } else {
      body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    }
    requests.push({ method: request.method, path: url.pathname, body, file })

    if (request.method === 'DELETE') {
      if (stub.failDeleteWith !== null) {
        return Response.json({ status: 'error', error: 'delete refused' }, { status: stub.failDeleteWith })
      }
      return Response.json({ status: 'ok', result: {} })
    }
    if (url.pathname === '/api/v1/resources/temp_upload') {
      return Response.json({ status: 'ok', result: { temp_file_id: `upload_${requests.length}.md` } })
    }
    if (url.pathname === '/api/v1/resources') {
      if (stub.failAddWith !== null) {
        return Response.json({ status: 'error', error: 'add refused' }, { status: stub.failAddWith })
      }
      return Response.json({ status: 'ok', result: { root_uri: String(body?.to ?? ''), status: 'success' } })
    }
    if (url.pathname === '/api/v1/search/find') {
      return Response.json({ status: 'ok', result: { resources: stub.resources } })
    }
    return Response.json({ status: 'error', error: `unexpected path ${url.pathname}` }, { status: 404 })
  },
})

function createHarness() {
  setKbActiveProductSpaceReaderForTests(
    (_accountId, productSpaceId) => (productSpaceId === SPACE_ID ? enterpriseSpace() : null) as never,
  )
  const handlers = new Map<string, HandlerFn>()
  const serverStub: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return null },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  interface SeedRecord {
    id: string
    accountId: string
    productSpaceId: string
    workspaceId: string
    kbCollectionIds: string[]
  }
  const records = new Map<string, SeedRecord>()
  const sessionManager = {
    getWorkspaces: () => [{ id: WORKSPACE_ID, rootPath: workspaceRoot, name: 'Workspace One' }],
    getSessions: () => [...records.values()],
    getSession: async (sessionId: string) => records.get(sessionId),
    setSessionKbCollections: async (sessionId: string, collectionIds: string[]) => {
      records.set(sessionId, {
        id: sessionId,
        accountId: ACCOUNT_ID,
        productSpaceId: SPACE_ID,
        workspaceId: WORKSPACE_ID,
        kbCollectionIds: collectionIds,
      })
    },
  }
  const deps = {
    sessionManager,
    platform: { logger: { info: () => {}, warn: () => {}, error: () => {} } },
  } as unknown as HandlerDeps
  registerKnowledgeBaseHandlers(serverStub, deps)
  const ctx = { clientId: 'client-1', workspaceId: WORKSPACE_ID, webContentsId: 1 } as unknown as RequestContext
  return {
    invoke: async (channel: string, input: unknown) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`missing handler for ${channel}`)
      return handler(ctx, input)
    },
  }
}

function setKbReaderRemoved(): void {}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'knowledge-base-openviking-'))
  workspaceRoot = join(tempDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  process.env.POLO_OPENVIKING_URL = `http://127.0.0.1:${server.port}`
  delete process.env.POLO_OPENVIKING_API_KEY
  stub.resources = []
  stub.failAddWith = null
  stub.failDeleteWith = null
  requests.length = 0
  setRuntimeActiveProductSpace(SPACE_ID)
  setRuntimeActiveProductSpaceAccount(ACCOUNT_ID)
  setRuntimeOfflineReadOnly(false)
  setTrustedProductSpaceAccountProvider(async () => ACCOUNT_ID)
  setSyncTrustedProductSpaceAccountId(ACCOUNT_ID)
})

afterEach(() => {
  delete process.env.POLO_OPENVIKING_URL
  delete process.env.POLO_OPENVIKING_API_KEY
  resetOpenVikingTimeoutsForTests()
  resetKbActiveProductSpaceReaderForTests()
  setRuntimeProductSpaceRestricted(SPACE_ID, false)
  setRuntimeActiveProductSpace(null)
  setRuntimeActiveProductSpaceAccount(null)
  setRuntimeOfflineReadOnly(false)
  setTrustedProductSpaceAccountProvider(async () => null)
  setSyncTrustedProductSpaceAccountId(null)
  rmSync(tempDir, { recursive: true, force: true })
})

afterAll(() => {
  server.stop(true)
})

/** Creates a collection, uploads a document and walks it to `published`. */
async function seedPublishedDocument(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
  doc: { title: string; content: string },
): Promise<{ collection: KbCollection; document: KbDocumentSummary; published: KbDocumentSummary }> {
  const collection = await invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
    workspaceId: WORKSPACE_ID, name: 'Handbook', description: 'Policies',
  }) as KbCollection
  const document = await invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
    workspaceId: WORKSPACE_ID, collectionId: collection.id, title: doc.title, content: doc.content,
  }) as KbDocumentSummary
  await invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
  const published = await invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, {
    workspaceId: WORKSPACE_ID, docId: document.id,
  }) as KbDocumentSummary
  return { collection, document, published }
}

describe('knowledge-base OpenViking space provisioning', () => {
  it('brings the space root up with the first collection, then stays idempotent', async () => {
    const { invoke } = createHarness()
    const collection = await invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Handbook', description: 'Policies',
    }) as KbCollection

    expect(requests.map(request => request.path)).toEqual([
      '/api/v1/resources/temp_upload',
      '/api/v1/resources',
    ])
    const add = requests[1].body as Record<string, unknown>
    expect(add.to).toBe(`${spaceRootUri()}/.space.md`)
    expect(add.create_parent).toBe(true)
    expect(add.wait).toBe(true)
    expect(add.processing_mode).toBe('vectors_only')
    expect(add.tags).toContain(`polo_space=${SPACE_ID}`)
    expect(typeof add.reason).toBe('string')
    // The manifest carries the enterprise space name / ids / creation time.
    const manifest = requests[0].file
    expect(manifest?.name).toBe('.space.md')
    expect(manifest?.content).toContain('Example enterprise')
    expect(manifest?.content).toContain(SPACE_ID)
    expect(manifest?.content).toContain(ENTERPRISE_ID)
    expect(manifest?.content).toContain('created_at')

    // The remote root is recorded in the space meta and audited.
    expect(readOpenVikingSpaceMeta(workspaceRoot, binding())).toMatchObject({
      rootUri: spaceRootUri(),
      productSpaceId: SPACE_ID,
      enterpriseId: ENTERPRISE_ID,
    })
    expect(readAudit(workspaceRoot, binding()).filter(entry => entry.action === 'openviking.space_provisioned'))
      .toHaveLength(1)

    // A second collection reuses the provisioned root — no further calls.
    requests.length = 0
    await invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Second', description: '',
    })
    expect(requests).toEqual([])
    expect(collection.name).toBe('Handbook')
  })

  it('survives a failed provisioning and keeps the local collection', async () => {
    stub.failAddWith = 500
    const { invoke } = createHarness()
    const collection = await invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Handbook', description: '',
    }) as KbCollection
    expect(collection.name).toBe('Handbook')
    expect(readOpenVikingSpaceMeta(workspaceRoot, binding())).toBeNull()
    const actions = readAudit(workspaceRoot, binding()).map(entry => entry.action)
    expect(actions).toEqual(['collection.create', 'openviking.space_provision_failed'])
  })
})

describe('knowledge-base OpenViking publish sync', () => {
  it('pushes a published document into the space and records the outcome', async () => {
    const { invoke } = createHarness()
    const { collection, document, published } = await seedPublishedDocument(invoke, {
      title: 'Flights policy', content: 'Flights must be booked economy.',
    })

    const docUri = `${spaceRootUri()}/collections/${collection.id}/${document.id}.md`
    expect(published.status).toBe('published')
    expect(published.openViking).toEqual({ uri: docUri, syncedAt: expect.any(String) })

    // The publish produced the verified add_resource body for the DOCUMENT.
    const docAddRequests = requests.filter(request =>
      request.path === '/api/v1/resources' && request.body?.to === docUri)
    expect(docAddRequests).toHaveLength(1)
    expect(docAddRequests[0].body).toMatchObject({
      temp_file_id: expect.any(String),
      create_parent: true,
      wait: true,
      processing_mode: 'vectors_only',
      tags: [`polo_space=${SPACE_ID}`, `collection=${collection.id}`, `doc=${document.id}`],
    })
    const upload = requests.find(request => request.path === '/api/v1/resources/temp_upload' && request.file?.name === `${document.id}.md`)
    expect(upload?.file?.content).toBe('Flights must be booked economy.')

    // The listing carries the sync state and the audit trail records it.
    const rows = await invoke(RPC_CHANNELS.kb.LIST_DOCUMENTS, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
    }) as KbDocumentSummary[]
    expect(rows.find(row => row.id === document.id)?.openViking).toEqual(published.openViking)
    const actions = readAudit(workspaceRoot, binding()).map(entry => entry.action)
    expect(actions).toContain('openviking.synced')
    expect(actions.indexOf('document.publish')).toBeLessThan(actions.indexOf('openviking.synced'))
  })

  it('never rolls the local publish back when the sync fails', async () => {
    stub.failAddWith = 500
    const { invoke } = createHarness()
    const { collection, document, published } = await seedPublishedDocument(invoke, {
      title: 'Flights policy', content: 'Flights must be booked economy.',
    })

    // The document stays published; the failure lands on the doc meta instead.
    expect(published.status).toBe('published')
    expect(published.openViking).toEqual({ error: expect.any(String), failedAt: expect.any(String) })
    const rows = await invoke(RPC_CHANNELS.kb.LIST_DOCUMENTS, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
    }) as KbDocumentSummary[]
    expect(rows.find(row => row.id === document.id)?.status).toBe('published')
    expect(rows.find(row => row.id === document.id)?.openViking).toMatchObject({ error: expect.any(String) })

    const actions = readAudit(workspaceRoot, binding()).map(entry => entry.action)
    expect(actions.indexOf('document.publish')).toBeLessThan(actions.indexOf('openviking.sync_failed'))
    expect(actions).not.toContain('openviking.synced')
  })
})

describe('knowledge-base OpenViking search', () => {
  it('maps find hits back onto local published documents and notes the source', async () => {
    const { invoke } = createHarness()
    const { collection, document } = await seedPublishedDocument(invoke, {
      title: 'Flights policy', content: 'Flights must be booked economy.',
    })
    // A draft never synced: a remote hit naming it is stale and must drop.
    await invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id, title: 'Draft doc', content: 'unrelated',
    })
    stub.resources = [
      { uri: `${spaceRootUri()}/collections/x/known.md`, score: 0.818, tags: [`doc=${document.id}`, `polo_space=${SPACE_ID}`] },
      // No `doc` tag → unmappable.
      { uri: `${spaceRootUri()}/.space.md`, score: 0.99, tags: [`polo_space=${SPACE_ID}`] },
      // Unknown local id → dropped.
      { uri: `${spaceRootUri()}/collections/x/ghost.md`, score: 0.95, tags: ['doc=kb-ghost'] },
      // The draft → dropped despite being resolvable as a record.
      { uri: `${spaceRootUri()}/collections/x/draft.md`, score: 0.9, tags: [`polo_space=${SPACE_ID}`, 'doc=kb-draft'] },
    ]

    const hits = await invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'flights',
    }) as KbSearchHit[]

    expect(hits).toHaveLength(1)
    expect(hits[0]).toEqual({
      docId: document.id,
      collectionId: collection.id,
      collectionName: 'Handbook',
      title: 'Flights policy',
      snippet: expect.stringContaining('Flights'),
      score: 0.818,
      source: 'openviking',
    })
    expect(requests.at(-1)?.path).toBe('/api/v1/search/find')
    expect(requests.at(-1)?.body).toEqual({
      query: 'flights',
      target_uri: spaceRootUri(),
      context_type: ['resource'],
      limit: 20,
    })
  })

  it('falls back to the local keyword search when OpenViking is unreachable', async () => {
    const { invoke } = createHarness()
    const { document } = await seedPublishedDocument(invoke, {
      title: 'Flights policy', content: 'Flights must be booked economy.',
    })
    // The backend disappears after the content was synced.
    process.env.POLO_OPENVIKING_URL = 'http://127.0.0.1:1'

    const hits = await invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'flights',
    }) as KbSearchHit[]
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ docId: document.id, title: 'Flights policy' })
    expect(hits[0].source).toBeUndefined()
  })
})

describe('knowledge-base OpenViking cleanup', () => {
  it('leaves OpenViking untouched when a rejected document is reverted to draft', async () => {
    // A rejected document was never published, so it never synced: the revert
    // cleanup has no remote copy to remove and must not call the backend.
    const { invoke } = createHarness()
    const { collection, document } = await seedPublishedDocument(invoke, {
      title: 'Flights policy', content: 'Flights must be booked economy.',
    })
    const other = await invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id, title: 'Reviewable', content: 'Body.',
    }) as KbDocumentSummary
    await invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: other.id })
    requests.length = 0
    await invoke(RPC_CHANNELS.kb.REJECT_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: other.id, reason: 'Not ready',
    })
    requests.length = 0

    const reverted = await invoke(RPC_CHANNELS.kb.REVERT_TO_DRAFT, {
      workspaceId: WORKSPACE_ID, docId: other.id,
    }) as KbDocumentSummary

    expect(reverted.status).toBe('draft')
    expect(reverted.openViking).toBeUndefined()
    expect(requests).toEqual([])
    expect(readAudit(workspaceRoot, binding()).map(entry => entry.action))
      .not.toContain('openviking.removed')
    // The published document keeps its synced copy untouched.
    const full = await invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    }) as KbDocument
    expect(full.openViking).toMatchObject({ uri: expect.any(String) })
  })

  it('deletes the remote copy on document delete, best-effort on failure', async () => {
    const { invoke } = createHarness()
    const { collection, document, published } = await seedPublishedDocument(invoke, {
      title: 'Obsolete', content: 'Out of date.',
    })
    const docUri = (published.openViking as { uri: string }).uri

    // The remote refuses: the local deletion still goes through.
    stub.failDeleteWith = 500
    await invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: document.id })
    const failedActions = readAudit(workspaceRoot, binding()).map(entry => entry.action)
    expect(failedActions).toContain('openviking.remove_failed')
    expect(failedActions).not.toContain('openviking.removed')
    const rows = await invoke(RPC_CHANNELS.kb.LIST_DOCUMENTS, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
    }) as KbDocumentSummary[]
    expect(rows).toEqual([])
    expect(existsSync(join(spaceDir(), 'recycle', document.id))).toBe(true)

    // A healthy backend gets the fs DELETE for the recorded uri.
    stub.failDeleteWith = null
    requests.length = 0
    const second = await invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id, title: 'Second', content: 'Body.',
    }) as KbDocumentSummary
    await invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: second.id })
    const secondPublished = await invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: second.id,
    }) as KbDocumentSummary
    const secondUri = (secondPublished.openViking as { uri: string }).uri
    requests.length = 0
    await invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: second.id })
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('DELETE')
    expect(requests[0].path).toBe('/api/v1/fs')
    expect(requests[0].body).toBeNull()
    expect(secondUri).toBe(`${spaceRootUri()}/collections/${collection.id}/${second.id}.md`)
    expect(readAudit(workspaceRoot, binding()).map(entry => entry.action)).toContain('openviking.removed')
  })
})

describe('knowledge-base without OpenViking', () => {
  it('makes no OpenViking calls and keeps the pre-v2 shapes when the URL env is unset', async () => {
    delete process.env.POLO_OPENVIKING_URL
    const { invoke } = createHarness()
    const { collection, document, published } = await seedPublishedDocument(invoke, {
      title: 'Flights policy', content: 'Flights must be booked economy.',
    })
    expect(requests).toEqual([])
    expect(published.openViking).toBeUndefined()
    expect(readOpenVikingSpaceMeta(workspaceRoot, binding())).toBeNull()
    expect(readAudit(workspaceRoot, binding()).map(entry => entry.action)).toEqual([
      'collection.create', 'document.upload', 'document.submit', 'document.publish',
    ])
    const hits = await invoke(RPC_CHANNELS.kb.SEARCH, {
      workspaceId: WORKSPACE_ID, query: 'flights',
    }) as KbSearchHit[]
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ docId: document.id, collectionId: collection.id, title: 'Flights policy' })
    expect(hits[0].source).toBeUndefined()
  })
})
