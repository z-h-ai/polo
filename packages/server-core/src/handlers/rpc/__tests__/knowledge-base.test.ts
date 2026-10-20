import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { KbCollection, KbDocumentSummary } from '@polo-ai/shared/protocol'
import type { HandlerFn, RpcServer, RequestContext } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import type { ISessionManager } from '../../session-manager-interface'
import {
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
  setRuntimeOfflineReadOnly,
} from '../../../runtime/product-space-executions'
import {
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../trusted-product-space-account'
import {
  registerKnowledgeBaseHandlers,
  resolveSessionKbReferences,
  resetKbActiveProductSpaceReaderForTests,
  setKbActiveProductSpaceReaderForTests,
} from '../knowledge-base'
import { readAudit } from '../../../knowledge-base/store'

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = 'ws-one'

function enterpriseSpace(role: 'owner' | 'manager' | 'member') {
  return {
    id: 'ps-one', kind: 'enterprise' as const, enterpriseId: 'ent-one',
    name: 'Example enterprise', role, accessMode: 'active' as const,
    payer: { kind: 'enterprise' as const, enterpriseId: 'ent-one' },
  }
}

function personalSpace() {
  return {
    id: 'ps-one', kind: 'personal' as const,
    name: '我的空间', accessMode: 'active' as const,
    payer: { kind: 'account' as const },
  }
}

let tempDir: string
let workspaceRoot: string

interface HarnessOptions {
  role?: 'owner' | 'manager' | 'member'
  kind?: 'enterprise' | 'personal'
}

function createHarness(options: HarnessOptions = {}) {
  const role = options.role ?? 'owner'
  const kind = options.kind ?? 'enterprise'
  // The active-space reader is module state — each harness pins it to its own
  // role/kind so two harnesses in one test see different identities.
  setKbActiveProductSpaceReaderForTests(
    () => (kind === 'enterprise' ? enterpriseSpace(role) : personalSpace()) as never,
  )
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return null },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const savedCollections = new Map<string, string[]>()
  const sessionManager = {
    getWorkspaces: () => [{ id: WORKSPACE_ID, rootPath: workspaceRoot, name: 'Workspace One' }],
    getSession: async (sessionId: string) => ({
      id: sessionId, workspaceId: WORKSPACE_ID,
      kbCollectionIds: savedCollections.get(sessionId) ?? [],
    }),
    setSessionKbCollections: async (sessionId: string, collectionIds: string[]) => {
      savedCollections.set(sessionId, collectionIds)
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
  return { invoke, sessionManager: sessionManager as unknown as ISessionManager }
}

function errorCode(error: unknown): string {
  return (error as { code?: string }).code ?? ''
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'knowledge-base-rpc-'))
  workspaceRoot = join(tempDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  setRuntimeActiveProductSpace('ps-one')
  setRuntimeActiveProductSpaceAccount(ACCOUNT_ID)
  setRuntimeOfflineReadOnly(false)
  setTrustedProductSpaceAccountProvider(async () => ACCOUNT_ID)
  setSyncTrustedProductSpaceAccountId(ACCOUNT_ID)
  setKbActiveProductSpaceReaderForTests(() => enterpriseSpace('owner') as never)
})

afterEach(() => {
  resetKbActiveProductSpaceReaderForTests()
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

describe('knowledge-base scope enforcement', () => {
  it('rejects every call from a personal space with the explicit error code', async () => {
    const { invoke } = createHarness({ kind: 'personal' })
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, WORKSPACE_ID))
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
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, WORKSPACE_ID))
      .rejects.toMatchObject({ code: 'PRODUCT_SPACE_CONTEXT_REQUIRED' })
  })

  it('rejects calls when the workspace does not match the bound context', async () => {
    const { invoke } = createHarness()
    await expect(invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, 'ws-other'))
      .rejects.toMatchObject({ code: 'workspace_context_mismatch' })
  })

  it('rejects member writes but allows reads, filtering drafts from reads', async () => {
    const owner = createHarness({ role: 'owner' })
    const { collection, document } = await seedCollection(owner.invoke, {
      title: 'Expense policy', content: 'Meals are reimbursed.',
    })
    if (!document) throw new Error('seed document missing')

    const member = createHarness({ role: 'member' })
    await expect(member.invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'Nope', description: '',
    })).rejects.toMatchObject({ code: 'kb_manage_required' })
    await expect(member.invoke(RPC_CHANNELS.kb.UPLOAD_DOCUMENT, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
      title: 'Nope', content: 'Nope',
    })).rejects.toMatchObject({ code: 'kb_manage_required' })
    await expect(member.invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).rejects.toMatchObject({ code: 'kb_manage_required' })

    // Member reads only surface published rows.
    const memberRows = await member.invoke(RPC_CHANNELS.kb.LIST_DOCUMENTS, {
      workspaceId: WORKSPACE_ID, collectionId: collection.id,
    }) as KbDocumentSummary[]
    expect(memberRows).toEqual([])
    expect(await member.invoke(RPC_CHANNELS.kb.GET_DOCUMENT, {
      workspaceId: WORKSPACE_ID, docId: document.id,
    })).toBeNull()
    const memberCollections = await member.invoke(RPC_CHANNELS.kb.LIST_COLLECTIONS, WORKSPACE_ID) as KbCollection[]
    expect(memberCollections).toHaveLength(1)
    expect(memberCollections[0].canManage).toBe(false)
  })

  it('rejects mutations while offline read-only is engaged', async () => {
    const { invoke } = createHarness()
    setRuntimeOfflineReadOnly(true)
    await expect(invoke(RPC_CHANNELS.kb.CREATE_COLLECTION, {
      workspaceId: WORKSPACE_ID, name: 'X', description: '',
    })).rejects.toMatchObject({ code: 'OFFLINE_READ_ONLY' })
    setRuntimeOfflineReadOnly(false)
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

    const versionDir = join(workspaceRoot, '.polo-kb', 'versions', document.id)
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
    expect(existsSync(join(workspaceRoot, '.polo-kb', 'recycle', document.id))).toBe(true)
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

    const actions = readAudit(workspaceRoot).map(entry => entry.action)
    expect(actions).toEqual([
      'collection.create', 'document.upload', 'document.submit', 'document.publish', 'document.delete',
    ])
    const entries = readAudit(workspaceRoot)
    expect(entries[0].actor).toBe(ACCOUNT_ID)
    expect(entries[0].target).toBe(collection.id)
    expect(entries[1].detail).toMatchObject({ collectionId: collection.id, title: 'Audited' })
    expect(entries[2].detail).toMatchObject({ from: 'draft', status: 'in_review' })
    expect(entries[4].detail).toMatchObject({ previousStatus: 'published' })
  })
})

describe('knowledge-base session scope', () => {
  it('only accepts collections that hold a published document and dedupes', async () => {
    const { invoke } = createHarness()
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

    await invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
    await invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: document.id })

    const saved = await invoke(RPC_CHANNELS.kb.SET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-1',
      collectionIds: [collection.id, collection.id],
    }) as { collectionIds: string[] }
    expect(saved.collectionIds).toEqual([collection.id])

    expect(await invoke(RPC_CHANNELS.kb.GET_SESSION_COLLECTIONS, {
      workspaceId: WORKSPACE_ID, sessionId: 'session-1',
    })).toEqual({ collectionIds: [collection.id] })
  })

  it('resolves send-time references from the session scope and commits the first-send draft', async () => {
    const { invoke, sessionManager } = createHarness()
    const { collection, document } = await seedCollection(invoke, {
      title: 'Travel policy', content: 'Flights are economy only.',
    })
    if (!document) throw new Error('seed document missing')
    await invoke(RPC_CHANNELS.kb.SUBMIT_FOR_REVIEW, { workspaceId: WORKSPACE_ID, docId: document.id })
    await invoke(RPC_CHANNELS.kb.PUBLISH_DOCUMENT, { workspaceId: WORKSPACE_ID, docId: document.id })

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

  it('degrades to no references when the session does not exist', async () => {
    const { sessionManager } = createHarness()
    const result = await resolveSessionKbReferences(
      { sessionManager, platform: { logger: { warn: () => {} } } } as never,
      'session-missing', 'anything',
    )
    expect(result).toBeUndefined()
  })
})
