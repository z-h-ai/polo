import { afterEach, afterAll, describe, expect, it } from 'bun:test'
import {
  OpenVikingError,
  isManagedOpenViking,
  isOpenVikingAlreadyExists,
  isOpenVikingNotFound,
  managedOpenVikingAuth,
  openVikingAttrs,
  openVikingCreateAccount,
  openVikingFind,
  openVikingGlob,
  openVikingListAccounts,
  openVikingListUsers,
  openVikingLs,
  openVikingMkdir,
  openVikingMv,
  openVikingReadContent,
  openVikingRemove,
  openVikingSetTags,
  openVikingWaitForProcessing,
  openVikingWriteContent,
  readOpenVikingConfig,
  resetOpenVikingManagedConflictWarningForTests,
  resetOpenVikingTimeoutsForTests,
  setOpenVikingTimeoutsForTests,
  type OpenVikingConfig,
} from '../openviking-client'

/**
 * Wire-shape tests for the OpenViking client (POO-108 v3.1). The request and
 * response shapes are the ones verified against a real local instance
 * (brief §1), so the stub asserts them literally — method, path, body fields,
 * query strings, the bearer credential each plane uses and the
 * `{"status":"ok","result":…}` / `{"status":"error","error":{code,…}}`
 * envelopes — plus the bounded-timeout degradation.
 */

interface RecordedRequest {
  method: string
  path: string
  search: URLSearchParams
  rawBody: string
  contentType: string | null
  authorization: string | null
  xApiKey: string | null
}

const requests: RecordedRequest[] = []

let respond: (url: URL, method: string, body: unknown) => Response | Promise<Response> = () =>
  Response.json({ status: 'ok', result: {} })

const server = Bun.serve({
  port: 0,
  fetch: async request => {
    const url = new URL(request.url)
    const contentType = request.headers.get('content-type')
    const rawBody = await request.text()
    let parsed: unknown = null
    try {
      parsed = rawBody ? JSON.parse(rawBody) : null
    } catch {
      parsed = null
    }
    requests.push({
      method: request.method,
      path: url.pathname,
      search: url.searchParams,
      rawBody,
      contentType,
      authorization: request.headers.get('authorization'),
      xApiKey: request.headers.get('x-api-key'),
    })
    return respond(url, request.method, parsed)
  },
})

const config: OpenVikingConfig = { baseUrl: `http://127.0.0.1:${server.port}`, processingMode: 'vectors_only' }
const tenantAuth = { accountId: 'polo-acme-1234abcd', userKey: 'ok-tenant-key' }
const rootConfig: OpenVikingConfig = { baseUrl: config.baseUrl, rootApiKey: 'ok-root-key', processingMode: 'vectors_only' }

afterEach(() => {
  requests.length = 0
  respond = () => Response.json({ status: 'ok', result: {} })
  resetOpenVikingTimeoutsForTests()
})

afterAll(() => {
  server.stop(true)
})

describe('openviking client configuration', () => {
  it('is configured only when the URL env is set, and normalizes it', () => {
    expect(readOpenVikingConfig({})).toBeNull()
    expect(readOpenVikingConfig({ POLO_OPENVIKING_URL: '   ' })).toBeNull()
    expect(readOpenVikingConfig({ POLO_OPENVIKING_URL: 'http://127.0.0.1:1933///' }))
      .toEqual({ baseUrl: 'http://127.0.0.1:1933', rootApiKey: undefined, processingMode: 'vectors_only' })
    expect(readOpenVikingConfig({
      POLO_OPENVIKING_URL: 'http://ov:1933',
      POLO_OPENVIKING_ROOT_API_KEY: ' root ',
    }))
      .toEqual({ baseUrl: 'http://ov:1933', rootApiKey: 'root', processingMode: 'vectors_only' })
  })

  it('only opts into semantic processing on the exact mode value', () => {
    expect(readOpenVikingConfig({ POLO_OPENVIKING_URL: 'http://ov:1933', POLO_OPENVIKING_PROCESSING_MODE: 'semantic_and_vectors' })?.processingMode)
      .toBe('semantic_and_vectors')
    expect(readOpenVikingConfig({ POLO_OPENVIKING_URL: 'http://ov:1933', POLO_OPENVIKING_PROCESSING_MODE: 'full' })?.processingMode)
      .toBe('vectors_only')
  })
})

describe('openviking managed-library mode (brief v4 D-A)', () => {
  it('selects the managed mode from POLO_OPENVIKING_API_KEY alone', () => {
    expect(readOpenVikingConfig({ POLO_OPENVIKING_URL: 'http://ov:1933', POLO_OPENVIKING_API_KEY: ' managed-key ' }))
      .toEqual({
        baseUrl: 'http://ov:1933',
        managedApiKey: 'managed-key',
        rootApiKey: undefined,
        processingMode: 'vectors_only',
      })
  })

  it('keeps the root key when only it is set — the OSS multi-tenant mode', () => {
    expect(readOpenVikingConfig({ POLO_OPENVIKING_URL: 'http://ov:1933', POLO_OPENVIKING_ROOT_API_KEY: 'root' }))
      .toMatchObject({ managedApiKey: undefined, rootApiKey: 'root' })
  })

  it('drops the root key entirely and warns ONCE when both keys are set', () => {
    resetOpenVikingManagedConflictWarningForTests()
    const warns: string[] = []
    const originalWarn = console.warn
    console.warn = (message: unknown) => { warns.push(String(message)) }
    try {
      const env = {
        POLO_OPENVIKING_URL: 'http://ov:1933',
        POLO_OPENVIKING_API_KEY: 'managed-key',
        POLO_OPENVIKING_ROOT_API_KEY: 'root-key',
      }
      const conflict = readOpenVikingConfig(env)
      expect(conflict?.managedApiKey).toBe('managed-key')
      // The root key is not even retained: managed mode has no provisioning
      // plane, so a leaked root key can never reach an admin call.
      expect(conflict?.rootApiKey).toBeUndefined()
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('POLO_OPENVIKING_ROOT_API_KEY')
      // The values never reach the log — only the conflict itself.
      expect(warns[0]).not.toContain('managed-key')
      expect(warns[0]).not.toContain('root-key')
      // The module-level flag keeps a per-call read from spamming the log.
      readOpenVikingConfig(env)
      expect(warns).toHaveLength(1)
    } finally {
      console.warn = originalWarn
      resetOpenVikingManagedConflictWarningForTests()
    }
  })

  it('resolves the managed auth as the default account holding the library key', () => {
    const managed: OpenVikingConfig = { baseUrl: 'http://ov:1933', managedApiKey: 'managed-key', processingMode: 'vectors_only' }
    expect(isManagedOpenViking(managed)).toBe(true)
    expect(managedOpenVikingAuth(managed)).toEqual({ accountId: 'default', userKey: 'managed-key' })
    expect(isManagedOpenViking(config)).toBe(false)
    expect(isManagedOpenViking(rootConfig)).toBe(false)
    expect(isManagedOpenViking(null)).toBe(false)
  })

  it('sends BOTH Authorization Bearer and X-API-Key on every keyed request, both modes', async () => {
    respond = () => Response.json({ status: 'ok', result: { resources: [] } })
    // OSS multi-tenant: the per-space user key rides both headers.
    await openVikingFind(config, tenantAuth, { query: 'q', targetUri: 'viking://resources/', limit: 5 })
    expect(requests[0]?.authorization).toBe('Bearer ok-tenant-key')
    expect(requests[0]?.xApiKey).toBe('ok-tenant-key')

    // Cloud-managed: the library key plays the data-plane credential role.
    const managed: OpenVikingConfig = { baseUrl: config.baseUrl, managedApiKey: 'managed-key', processingMode: 'vectors_only' }
    await openVikingFind(managed, managedOpenVikingAuth(managed), { query: 'q', targetUri: 'viking://resources/', limit: 5 })
    expect(requests[1]?.authorization).toBe('Bearer managed-key')
    expect(requests[1]?.xApiKey).toBe('managed-key')
  })

  it('flags the not-found failure the managed read paths tolerate, and nothing else', async () => {
    respond = () => Response.json({ status: 'error', error: { code: 'NOT_FOUND', message: 'missing' } }, { status: 404 })
    const missing = await openVikingLs(config, tenantAuth, { uri: 'viking://resources/none/' }).catch((caught: unknown) => caught)
    expect(isOpenVikingNotFound(missing)).toBe(true)

    respond = () => Response.json({ status: 'error', error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 })
    const failure = await openVikingLs(config, tenantAuth, { uri: 'viking://resources/none/' }).catch((caught: unknown) => caught)
    expect(isOpenVikingNotFound(failure)).toBe(false)
  })
})

describe('openviking admin-plane wire shapes', () => {
  it('creates the account with the root key and reads back the user key', async () => {
    respond = () => Response.json({
      status: 'ok',
      result: { account_id: 'polo-acme-1234abcd', admin_user_id: 'polo-service', user_key: 'ok-secret' },
    })
    const result = await openVikingCreateAccount(rootConfig, {
      accountId: 'polo-acme-1234abcd',
      adminUserId: 'polo-service',
    })
    expect(result).toEqual({ accountId: 'polo-acme-1234abcd', adminUserId: 'polo-service', userKey: 'ok-secret' })
    const request = requests[0]
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/api/v1/admin/accounts')
    expect(request.authorization).toBe('Bearer ok-root-key')
    expect(JSON.parse(request.rawBody)).toEqual({ account_id: 'polo-acme-1234abcd', admin_user_id: 'polo-service' })
  })

  it('accepts the alternate apiKey field when the instance returns it', async () => {
    respond = () => Response.json({
      status: 'ok',
      result: { account_id: 'polo-acme-1234abcd', apiKey: 'ok-alt' },
    })
    const result = await openVikingCreateAccount(rootConfig, {
      accountId: 'polo-acme-1234abcd',
      adminUserId: 'polo-service',
    })
    expect(result.userKey).toBe('ok-alt')
    expect(result.adminUserId).toBe('polo-service')
  })

  it('refuses an account creation result without a usable user key', async () => {
    respond = () => Response.json({ status: 'ok', result: { account_id: 'polo-acme-1234abcd' } })
    await expect(openVikingCreateAccount(rootConfig, { accountId: 'a', adminUserId: 'u' }))
      .rejects.toMatchObject({ code: 'openviking_invalid_response', name: 'OpenVikingError' })
  })

  it('lists accounts as a bare array and drops rows without an account id', async () => {
    respond = () => Response.json({
      status: 'ok',
      result: [
        { account_id: 'polo-a-11111111', created_at: '2026-01-01T00:00:00Z', status: 'active', user_count: 1 },
        { created_at: 'no id here' },
      ],
    })
    const accounts = await openVikingListAccounts(rootConfig)
    expect(accounts).toEqual([
      { accountId: 'polo-a-11111111', createdAt: '2026-01-01T00:00:00Z', status: 'active', userCount: 1 },
    ])
  })

  it('lists users with credentials and tolerates both row shapes', async () => {
    respond = () => Response.json({
      status: 'ok',
      result: {
        users: [
          { user_id: 'polo-service', username: 'polo-service', role: 'admin', user_key: 'ok-live' },
          { id: 'second', apiKey: 'ok-second' },
          { username: 'no id' },
        ],
      },
    })
    const users = await openVikingListUsers(rootConfig, 'polo-acme-1234abcd')
    expect(users).toHaveLength(2)
    expect(users[0]).toEqual({ userId: 'polo-service', username: 'polo-service', role: 'admin', userKey: 'ok-live' })
    expect(users[1]).toEqual({ userId: 'second', username: null, role: null, userKey: 'ok-second' })
    const request = requests[0]
    expect(request.path).toBe('/api/v1/admin/accounts/polo-acme-1234abcd/users')
    expect(request.search.get('include_credentials')).toBe('true')
  })
})

describe('openviking data-plane wire shapes', () => {
  it('waits the ingestion pipelines out with an empty body and the tenant key (measured 2026-10-21)', async () => {
    // The real `POST /api/v1/system/wait` takes no parameters, accepts the
    // data-plane user key and answers the standard envelope with the
    // per-pipeline drain counts (diagnostics only — the caller wants the
    // completion). It is the drain a directory tag write waits for.
    respond = () => Response.json({
      status: 'ok',
      result: {
        Embedding: { processed: 227, requeue_count: 0, error_count: 0, errors: [] },
        Semantic: { processed: 129, requeue_count: 101, error_count: 0, errors: [] },
      },
      error: null,
    })
    await openVikingWaitForProcessing(config, tenantAuth)
    const request = requests[0]
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/api/v1/system/wait')
    expect(request.authorization).toBe('Bearer ok-tenant-key')
    expect(JSON.parse(request.rawBody)).toEqual({})
  })

  it('races the pipeline wait against its own bounded timeout', async () => {
    // A pipeline that outlives the bound must surface as the structured
    // timeout — the store's verified loop absorbs it and polls instead.
    setOpenVikingTimeoutsForTests({ waitMs: 30 })
    respond = async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
      return Response.json({ status: 'ok', result: {} })
    }
    await expect(openVikingWaitForProcessing(config, tenantAuth))
      .rejects.toMatchObject({ code: 'openviking_timeout' })
  })

  it('mkdirs ONE level and sends the optional description', async () => {
    await openVikingMkdir(config, tenantAuth, { uri: 'viking://resources/Handbook-kb-1', description: 'Policies' })
    const request = requests[0]
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/api/v1/fs/mkdir')
    expect(request.authorization).toBe('Bearer ok-tenant-key')
    expect(JSON.parse(request.rawBody)).toEqual({
      uri: 'viking://resources/Handbook-kb-1',
      description: 'Policies',
    })
  })

  it('moves a node with the from/to body and removes through the fs query', async () => {
    await openVikingMv(config, tenantAuth, {
      fromUri: 'viking://resources/a/kb-1.md',
      toUri: 'viking://resources/.recycle/kb-1.md',
    })
    expect(requests[0].path).toBe('/api/v1/fs/mv')
    expect(JSON.parse(requests[0].rawBody)).toEqual({
      from_uri: 'viking://resources/a/kb-1.md',
      to_uri: 'viking://resources/.recycle/kb-1.md',
    })

    await openVikingRemove(config, tenantAuth, { uri: 'viking://resources/a/kb-1.md', recursive: false })
    const removal = requests[1]
    expect(removal.method).toBe('DELETE')
    expect(removal.path).toBe('/api/v1/fs')
    expect(removal.search.get('uri')).toBe('viking://resources/a/kb-1.md')
    expect(removal.search.get('recursive')).toBe('false')
  })

  it('writes content with tag_mode replace and the configured processing mode', async () => {
    await openVikingWriteContent(config, tenantAuth, {
      uri: 'viking://resources/Handbook-kb-1/Flights-kb-2.md',
      content: '# Flights',
      tags: ['doc=kb-2', 'status=draft'],
      processingMode: 'semantic_and_vectors',
    })
    const request = requests[0]
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/api/v1/content/write')
    expect(JSON.parse(request.rawBody)).toEqual({
      uri: 'viking://resources/Handbook-kb-1/Flights-kb-2.md',
      content: '# Flights',
      tag_mode: 'replace',
      tags: ['doc=kb-2', 'status=draft'],
      processing_mode: 'semantic_and_vectors',
    })
  })

  it('defaults the processing mode to the config value when omitted', async () => {
    await openVikingWriteContent(
      { baseUrl: config.baseUrl, processingMode: 'vectors_only' },
      tenantAuth,
      { uri: 'viking://resources/a.md', content: 'x' },
    )
    const body = JSON.parse(requests[0].rawBody) as Record<string, unknown>
    expect(body.processing_mode).toBe('vectors_only')
    expect(body.tags).toBeUndefined()
  })

  it('reads content back, distinguishing an empty body from a missing node', async () => {
    respond = url => {
      if (url.searchParams.get('uri') === 'viking://resources/empty.md') {
        return Response.json({ status: 'ok', result: { content: null } })
      }
      return Response.json({ status: 'ok', result: { content: '# Body' } })
    }
    expect(await openVikingReadContent(config, tenantAuth, 'viking://resources/a.md')).toBe('# Body')
    expect(await openVikingReadContent(config, tenantAuth, 'viking://resources/empty.md')).toBeNull()
    expect(requests.every(request => request.path === '/api/v1/content/read')).toBe(true)
  })

  it('reads ONE node through fs/attrs and maps a missing node to null', async () => {
    respond = url => {
      if (url.searchParams.get('uri') === 'viking://resources/gone.md') {
        return Response.json({ status: 'ok', result: { attrs: null } })
      }
      return Response.json({
        status: 'ok',
        result: { attrs: { uri: 'viking://resources/a.md', tags: ['doc=kb-1'], mtime: '2026-01-01T00:00:00Z', type: 'file' } },
      })
    }
    const node = await openVikingAttrs(config, tenantAuth, 'viking://resources/a.md')
    expect(node).toEqual({
      uri: 'viking://resources/a.md',
      tags: { doc: 'kb-1' },
      duplicateTagKeys: [],
      mtime: '2026-01-01T00:00:00Z',
      isDirectory: false,
    })
    expect(await openVikingAttrs(config, tenantAuth, 'viking://resources/gone.md')).toBeNull()
  })

  it('parses the REAL v0.5.1.1 attrs shape whose node identity rides at the top level (measured 2026-10-21)', async () => {
    // The live instance answers `{uri, context_type, attrs: {tags}}` — the
    // tags live INSIDE attrs while the uri does NOT. Reading `attrs` as the
    // node itself finds no uri and reports "no node", which silently turned
    // every directory-tag read-back into a miss on the real instance (E1
    // hardening round). This test pins the merged parsing against that wire
    // shape, byte for byte as probed.
    respond = () => Response.json({
      status: 'ok',
      result: {
        uri: 'viking://resources/Live Check Handbook-kb-7a50559e-a744-4861-ac32-1046d0ae31ce',
        context_type: 'resource',
        attrs: { tags: ['collection=7a50559e-a744-4861-ac32-1046d0ae31ce'] },
      },
    })
    expect(await openVikingAttrs(config, tenantAuth, 'viking://resources/Live Check Handbook-kb-7a50559e-a744-4861-ac32-1046d0ae31ce')).toEqual({
      uri: 'viking://resources/Live Check Handbook-kb-7a50559e-a744-4861-ac32-1046d0ae31ce',
      tags: { collection: '7a50559e-a744-4861-ac32-1046d0ae31ce' },
      duplicateTagKeys: [],
      mtime: null,
      isDirectory: null,
    })
  })

  it('replaces retrieval tags through the set_tags body', async () => {
    await openVikingSetTags(config, tenantAuth, {
      uri: 'viking://resources/a.md',
      tags: ['doc=kb-1', 'status=published'],
      mode: 'replace',
    })
    const request = requests[0]
    expect(request.path).toBe('/api/v1/fs/attrs/set_tags')
    expect(JSON.parse(request.rawBody)).toEqual({
      uri: 'viking://resources/a.md',
      tags: ['doc=kb-1', 'status=published'],
      mode: 'replace',
    })
  })

  it('walks the tree with the paged ls query and normalizes the page', async () => {
    respond = () => Response.json({
      status: 'ok',
      result: {
        entries: [
          { uri: 'viking://resources/Handbook-kb-1', tags: ['collection=kb-1'], mtime: '2026-01-01T00:00:00Z', type: 'dir' },
          { path: 'viking://resources/Handbook-kb-1/a.md', tags: ['doc=kb-2', 'doc=kb-2'], is_dir: false },
        ],
        has_more: true,
      },
    })
    const page = await openVikingLs(config, tenantAuth, {
      uri: 'viking://resources/',
      recursive: true,
      nodeLimit: 500,
      offset: 100,
      tags: ['status=published'],
    })
    expect(page.hasMore).toBe(true)
    expect(page.entries).toHaveLength(2)
    expect(page.entries[0]?.isDirectory).toBe(true)
    // Duplicate keys survive into duplicateTagKeys — strict parsers reject
    // such nodes instead of silently collapsing them.
    expect(page.entries[1]?.uri).toBe('viking://resources/Handbook-kb-1/a.md')
    expect(page.entries[1]?.duplicateTagKeys).toEqual(['doc'])
    const request = requests[0]
    expect(request.path).toBe('/api/v1/fs/ls')
    expect(request.search.get('uri')).toBe('viking://resources/')
    expect(request.search.get('include_tags')).toBe('true')
    expect(request.search.get('recursive')).toBe('true')
    expect(request.search.get('node_limit')).toBe('500')
    expect(request.search.get('offset')).toBe('100')
    expect(request.search.getAll('tags')).toEqual(['status=published'])
  })

  it('finds resources inside an array of targets, tolerating both tag shapes', async () => {
    respond = () => Response.json({
      status: 'ok',
      result: {
        resources: [
          { uri: 'viking://resources/a.md', score: 0.818, tags: ['doc=kb-1', 'polo_space=ps-one'], content: '# A' },
          { uri: 'viking://resources/b.md', score: '0.5', tags: { doc: 'kb-2' }, content: null },
          // Malformed rows are skipped, never fatal.
          { score: 1 },
          { uri: 'viking://resources/c.md', score: 'not-a-number' },
        ],
      },
    })
    const resources = await openVikingFind(config, tenantAuth, {
      query: '入职一年有几天年假',
      targetUri: ['viking://resources/Handbook-kb-1'],
      tags: ['status=published'],
      limit: 20,
      readContent: true,
    })
    expect(resources).toHaveLength(2)
    expect(resources[0]).toEqual({
      uri: 'viking://resources/a.md',
      score: 0.818,
      tags: { doc: 'kb-1', polo_space: 'ps-one' },
      duplicateTagKeys: [],
      content: '# A',
    })
    expect(resources[1].tags).toEqual({ doc: 'kb-2' })
    expect(resources[1].score).toBe(0.5)
    expect(resources[1].content).toBeNull()
    const body = JSON.parse(requests[0].rawBody) as Record<string, unknown>
    expect(body).toEqual({
      query: '入职一年有几天年假',
      target_uri: ['viking://resources/Handbook-kb-1'],
      tags: ['status=published'],
      limit: 20,
      read_content: true,
    })
  })

  it('resolves names through search/glob scoped by the uri field', async () => {
    respond = () => Response.json({
      status: 'ok',
      result: { matches: [{ uri: 'viking://resources/Handbook-kb-1/a-kb-2.md' }, 'viking://resources/b.md'] },
    })
    const matches = await openVikingGlob(config, tenantAuth, {
      pattern: '**/*-kb-2.md',
      uri: 'viking://resources/',
      nodeLimit: 100,
    })
    // Both row shapes normalize to their uri: objects with a `uri` field and
    // bare strings alike.
    expect(matches).toEqual([
      'viking://resources/Handbook-kb-1/a-kb-2.md',
      'viking://resources/b.md',
    ])
    const body = JSON.parse(requests[0].rawBody) as Record<string, unknown>
    expect(body).toEqual({ pattern: '**/*-kb-2.md', uri: 'viking://resources/', node_limit: 100 })
  })
})

describe('openviking client failures', () => {
  it('maps an HTTP error status to a structured error carrying the server code', async () => {
    respond = () => Response.json(
      { status: 'error', error: { code: 'ALREADY_EXISTS', message: 'account exists', details: null } },
      { status: 409 },
    )
    const error = await openVikingCreateAccount(rootConfig, { accountId: 'a', adminUserId: 'u' }).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(OpenVikingError)
    expect(error).toMatchObject({
      code: 'openviking_http_error',
      status: 409,
      serverCode: 'ALREADY_EXISTS',
    })
    expect((error as Error).message).toContain('HTTP 409')
    expect((error as Error).message).toContain('account exists')
  })

  it('maps a non-ok envelope to an invalid-response error', async () => {
    respond = () => Response.json({ status: 'error', error: 'quota exceeded' })
    await expect(openVikingFind(config, tenantAuth, { query: 'q', targetUri: 'viking://resources/', limit: 5 }))
      .rejects.toMatchObject({ code: 'openviking_invalid_response' })
  })

  it('maps a non-JSON body to an invalid-response error on success, an HTTP error otherwise', async () => {
    respond = () => new Response('<html>gateway</html>', { status: 200 })
    await expect(openVikingReadContent(config, tenantAuth, 'viking://resources/a.md'))
      .rejects.toMatchObject({ code: 'openviking_invalid_response' })

    respond = () => new Response('<html>gateway</html>', { status: 502 })
    await expect(openVikingReadContent(config, tenantAuth, 'viking://resources/a.md'))
      .rejects.toMatchObject({ code: 'openviking_http_error', status: 502 })
  })

  it('recognizes the managed cloud\'s 409 CONFLICT already-exists answer (acceptance V2)', async () => {
    // vikingdb serverless answers an idempotent mkdir with HTTP 409 CONFLICT
    // and an "already exists" message — same meaning as the OSS ALREADY_EXISTS.
    respond = () => Response.json({
      status: 'error',
      error: { code: 'CONFLICT', message: 'already exists: /default/resources/e2e-b454f82c' },
    }, { status: 409 })
    let caught: unknown
    try {
      await openVikingMkdir(config, tenantAuth, { uri: 'viking://resources/e2e-b454f82c' })
    } catch (error) { caught = error }
    expect(isOpenVikingAlreadyExists(caught)).toBe(true)
  })

  it('maps a refused connection to a network error', async () => {
    // Port 1 on localhost: nothing listens, the TCP connect fails immediately.
    await expect(openVikingFind(
      { baseUrl: 'http://127.0.0.1:1', processingMode: 'vectors_only' },
      tenantAuth,
      { query: 'q', targetUri: 'viking://resources/', limit: 5 },
    )).rejects.toMatchObject({ code: 'openviking_network_error' })
  })

  it('maps a stalled response to the bounded-timeout error', async () => {
    setOpenVikingTimeoutsForTests({ findMs: 50 })
    respond = () => new Promise(() => {}) // never settles
    const pending = openVikingFind(config, tenantAuth, { query: 'q', targetUri: 'viking://resources/', limit: 5 })
    await expect(pending).rejects.toMatchObject({ code: 'openviking_timeout' })
  })
})
