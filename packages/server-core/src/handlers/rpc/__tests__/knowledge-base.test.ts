import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { KbCollection, KbCollectionList, KbDocumentSummary } from '@polo-ai/shared/protocol'
import type { HandlerFn, RpcServer, RequestContext } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import type { ISessionManager } from '../../session-manager-interface'
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
  resolveSessionKbReferences,
  resetKbActiveProductSpaceReaderForTests,
  resetKbSendResolveTimeoutForTests,
  setKbActiveProductSpaceReaderForTests,
  setKbSendResolveTimeoutForTests,
} from '../knowledge-base'
import { kbRootPath, kbSpaceSegment, readAudit } from '../../../knowledge-base/store'

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = 'ws-one'
const SPACE_ID = 'ps-one'
const ENTERPRISE_ID = 'ent-one'

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

function personalSpace() {
  return {
    id: SPACE_ID, kind: 'personal' as const,
    name: '我的空间', accessMode: 'active' as const,
    payer: { kind: 'account' as const },
  }
}

let tempDir: string
let workspaceRoot: string

/** The store directory of the harness's default space. */
function spaceDir(): string {
  return kbRootPath(workspaceRoot, { productSpaceId: SPACE_ID, enterpriseId: ENTERPRISE_ID })
}

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
    : personalSpace()
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
  const ownRecord = (sessionId: string, kbCollectionIds: string[]): SeedRecord => ({
    id: sessionId,
    accountId: ACCOUNT_ID,
    productSpaceId: SPACE_ID,
    workspaceId: WORKSPACE_ID,
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'knowledge-base-rpc-'))
  workspaceRoot = join(tempDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  setRuntimeActiveProductSpace(SPACE_ID)
  setRuntimeActiveProductSpaceAccount(ACCOUNT_ID)
  setRuntimeOfflineReadOnly(false)
  setTrustedProductSpaceAccountProvider(async () => ACCOUNT_ID)
  setSyncTrustedProductSpaceAccountId(ACCOUNT_ID)
  setKbActiveProductSpaceReaderForTests(() => enterpriseSpace('owner') as never)
})

afterEach(() => {
  resetKbActiveProductSpaceReaderForTests()
  resetKbSendResolveTimeoutForTests()
  setRuntimeProductSpaceRestricted(SPACE_ID, false)
  setRuntimeActiveProductSpace(null)
  setRuntimeActiveProductSpaceAccount(null)
  setRuntimeOfflineReadOnly(false)
  setTrustedProductSpaceAccountProvider(async () => null)
  setSyncTrustedProductSpaceAccountId(null)
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
  })

  it('rejects mutations on an online read_only space and on a runtime restriction, keeping reads (review #4)', async () => {
    const restricted = createHarness({ accessMode: 'read_only' })
    await expect(restricted.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'X', description: '',
    })).rejects.toMatchObject({ code: 'kb_space_read_only' })
    await expect(restricted.invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: 'kb-x',
    })).rejects.toMatchObject({ code: 'kb_space_read_only' })
    // The read side stays usable for the restricted projection.
    const list = await restricted.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }) as KbCollectionList
    expect(list).toEqual({ canManage: true, collections: [] })

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
    // Nothing was written: no store, no audit entry.
    expect(existsSync(spaceDir())).toBe(false)
  })
})

describe('knowledge-base enterprise isolation', () => {
  it('keeps one store per ProductSpace: another space reads an empty KB, never the first space data (review #1)', async () => {
    const first = createHarness()
    const { collection, document } = await seedCollection(first.invoke, {
      title: 'Expense policy', content: 'Meals are reimbursed.',
    })
    if (!document) throw new Error('seed document missing')
    await publishDocument(first.invoke, document)

    // The same workspace, a DIFFERENT enterprise space fence: the store is
    // per-space, so the second space sees its own (empty) KB and can never
    // list, search or open the first space's documents.
    setRuntimeActiveProductSpace('ps-two')
    const second = createHarness({ spaceId: 'ps-two', enterpriseId: 'ent-two' })
    const list = await second.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }) as KbCollectionList
    expect(list.collections).toEqual([])
    expect(await second.invoke(RPC_CHANNELS.kb.SEARCH, { workspaceId: WORKSPACE_ID, query: 'Meals' })).toEqual([])
    // A document of ANOTHER space reads as "no such document" — the missing
    // document contract, which discloses nothing about the first space.
    expect(await second.invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).toBeNull()
    await expect(second.invoke(RPC_CHANNELS.kb.DELETE_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).rejects.toMatchObject({ code: 'kb_document_not_found' })
    expect(existsSync(join(spaceDir(), 'collections', collection.id))).toBe(true)

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
    // enterprise: the binding marker fails closed.
    setKbActiveProductSpaceReaderForTests(
      () => enterpriseSpace('owner', { enterpriseId: 'ent-evil' }) as never,
    )
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }))
      .rejects.toMatchObject({ code: 'kb_space_mismatch' })
    await expect(invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'X', description: '',
    })).rejects.toMatchObject({ code: 'kb_space_mismatch' })
  })
})

describe('knowledge-base list contract', () => {
  it('parses the bridged input object and reports the space capability, not data presence (reviews #5/#6)', async () => {
    const { invoke } = createHarness()
    // The renderer/channel-map passes ONE object; a bare string is invalid.
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, WORKSPACE_ID))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })

    // Empty space: the owner's capability is already true.
    const empty = await invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, { workspaceId: WORKSPACE_ID }) as KbCollectionList
    expect(empty).toEqual({ canManage: true, collections: [] })

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
    const scopeEntries = readAudit(workspaceRoot, { productSpaceId: SPACE_ID, enterpriseId: ENTERPRISE_ID })
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
    const afterClear = readAudit(workspaceRoot, { productSpaceId: SPACE_ID, enterpriseId: ENTERPRISE_ID })
      .filter(entry => entry.action === 'session_scope.set')
    expect(afterClear).toHaveLength(2)
    expect(afterClear[1].detail).toMatchObject({ from: [collection.id], to: [] })
  })
})

describe('knowledge-base document lifecycle', () => {
  it('walks draft → in_review → published and snapshots a version', async () => {
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

    // Publishing is illegal while still a draft — the state machine refuses.
    await expect(invoke(RPC_CHANNELS.kb.REJECT_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id, reason: 'not yet',
    })).resolves.toBeTruthy()
    // rejected → draft → in_review → published
    await invoke(RPC_CHANNELS.kb.REVERT_TO_DRAFT, { workspaceId: WORKSPACE_ID, docId: document.id })
    await invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
    const published = await invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    }) as KbDocumentSummary
    expect(published.status).toBe('published')
    expect(published.publishedAt).not.toBeNull()
    expect(published.rejectReason).toBeNull()

    // A published document is terminal: no further transitions.
    await expect(invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).rejects.toMatchObject({ code: 'kb_invalid_transition' })

    const versionDir = join(spaceDir(), 'versions', document.id)
    expect(readdirSync(versionDir)).toEqual([`v${published.version}.md`])

    const fetched = await invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    }) as { content: string }
    expect(fetched.content).toBe('Welcome to the company.')
  })

  it('hides drafts from search until published, then ranks title hits first', async () => {
    const { invoke } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Flights policy', content: 'Flights must be booked economy.',
    })
    if (!document) throw new Error('seed document missing')

    // Draft and in_review content is not searchable.
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

  it('recycles deleted documents out of the live listing', async () => {
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
    expect(existsSync(join(spaceDir(), 'recycle', document.id))).toBe(true)
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

    const binding = { productSpaceId: SPACE_ID, enterpriseId: ENTERPRISE_ID }
    const actions = readAudit(workspaceRoot, binding).map(entry => entry.action)
    expect(actions).toEqual([
      'collection.create', 'document.upload', 'document.submit', 'document.publish', 'document.delete',
    ])
    const entries = readAudit(workspaceRoot, binding)
    expect(entries[0].actor).toBe(ACCOUNT_ID)
    expect(entries[0].target).toBe(collection.id)
    expect(entries[1].detail).toMatchObject({ collectionId: collection.id, title: 'Audited' })
    expect(entries[2].detail).toMatchObject({ from: 'draft', status: 'in_review' })
    expect(entries[4].detail).toMatchObject({ previousStatus: 'published' })
  })
})

describe('knowledge-base send-time reference resolution', () => {
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
      { sessionManager, platform: { logger: { warn: () => {} } } } as never,
      'session-9', 'how do I book flights?', [collection.id],
    )
    expect(references).toHaveLength(1)
    expect(references?.[0]).toMatchObject({ docId: document.id, collectionId: collection.id })
    expect(await sessionManager.getSession('session-9')).toMatchObject({
      kbCollectionIds: [collection.id],
    })

    // Later sends read the persisted scope — no draft argument needed.
    const later = await resolveSessionKbReferences(
      { sessionManager, platform: { logger: { warn: () => {} } } } as never,
      'session-9', 'flights again',
    )
    expect(later).toHaveLength(1)

    // Clearing the scope silences references without mutating past messages.
    await invoke(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-9', collectionIds: [],
    })
    expect(await resolveSessionKbReferences(
      { sessionManager, platform: { logger: { warn: () => {} } } } as never,
      'session-9', 'flights again',
    )).toBeUndefined()
  })

  it('exits before any await when the session has no KB scope (review #7)', async () => {
    const { sessionManager } = createHarness()
    // Auth never resolves: an empty scope must still return immediately.
    setTrustedProductSpaceAccountProvider(() => new Promise(() => {}))
    setSyncTrustedProductSpaceAccountId(null)
    const result = await resolveSessionKbReferences(
      { sessionManager, platform: { logger: { warn: () => {} } } } as never,
      'session-empty', 'anything',
    )
    expect(result).toBeUndefined()
  })

  it('degrades to no references when the session does not exist', async () => {
    const { sessionManager } = createHarness()
    const result = await resolveSessionKbReferences(
      { sessionManager, platform: { logger: { warn: () => {} } } } as never,
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
      { sessionManager, platform: { logger: { warn: () => {} } } } as never,
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
      { sessionManager, platform: { logger: { warn: () => {} } } } as never,
      'session-draft', 'flights?', [collection.id],
    )
    const entries = readAudit(workspaceRoot, { productSpaceId: SPACE_ID, enterpriseId: ENTERPRISE_ID })
      .filter(entry => entry.action === 'session_scope.set')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      actor: ACCOUNT_ID,
      target: 'session-draft',
      detail: { from: [], to: [collection.id], source: 'send_draft_commit' },
    })
  })
})
