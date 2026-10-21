import { createHash } from 'crypto'

/**
 * The in-memory knowledge-base storage backend the POO-108 v3.1 tests run
 * against (brief §1). It implements EXACTLY the wire surface the real
 * instance exposed — no speculative features — so every test exercises the
 * shapes the client and store actually parse:
 *
 * - envelope `{"status":"ok","result":…}` / `{"status":"error","error":{code,
 *   message,details}}`, with the matching HTTP status on errors;
 * - bearer auth: the root key opens the admin plane ONLY (the data plane
 *   answers 403 PERMISSION_DENIED to it), an account user key opens the data
 *   plane ONLY, anything else is 401;
 * - one resource tree PER ACCOUNT: two devices provisioning the same
 *   ProductSpace land in the same account (the D1 derivation) and therefore
 *   share one tree, which is what the cross-device tests rely on;
 * - `fs/ls` hides dotfile CONTENT the way the real instance does: a dot
 *   directory itself is listed, but nothing inside it ever is — the recycle
 *   and transition subtrees disappear from every listing (brief §1.7);
 * - `search/find` scores deterministically (token hits in the `title` tag and
 *   the body) so integration tests can rank without a vector backend.
 *
 * Fault injection is explicit and surgical: a fault matches a method + path
 * prefix for N requests, a delay applies per path prefix, and a find override
 * replaces the search result wholesale (stale hits, unmappable ids, …).
 */

/** The account-relative root every resource lives under. */
const ROOT_URI = 'viking://resources/'

/** One stored node. Tags stay the raw `k=v` STRING list the wire carries. */
export interface FakeOpenVikingNode {
  uri: string
  type: 'dir' | 'file'
  tags: string[]
  content: string | null
  mtime: string
  /**
   * When the directory's ingestion pipeline finishes (epoch ms). Set at
   * creation for DIRECTORIES only — the measured instance processes a fresh
   * directory and rebuilds its attributes on completion, wiping tags written
   * before that (e2e E1). Files are never processed.
   */
  processingUntil?: number
}

/** A request the fake saw, recorded for wire-shape assertions. */
export interface FakeRecordedRequest {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  authorization: string | null
}

/** One armed failure: consumed once per matching request, then discarded. */
export interface FakeFault {
  method?: 'POST' | 'GET' | 'DELETE'
  pathPrefix: string
  status: number
  code: string
  message: string
  /** How many matching requests fail before the fake turns healthy again. */
  times: number
}

interface FakeAccount {
  accountId: string
  createdAt: string
  users: Map<string, { username: string; role: string; apiKey: string }>
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Strips trailing slashes; the root keeps its canonical form. */
function normalizeUri(uri: string): string {
  if (uri === ROOT_URI || uri === 'viking://resources') return ROOT_URI
  return uri.replace(/\/+$/, '')
}

/** The parent uri, or null when the uri IS the root. */
function parentUri(uri: string): string | null {
  if (uri === ROOT_URI) return null
  const cut = uri.lastIndexOf('/')
  return cut <= ROOT_URI.length - 1 ? ROOT_URI : uri.slice(0, cut)
}

/** The last path segment (`resources` for the root itself). */
function baseName(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1)
}

/**
 * The listing visibility rule (brief §1.7): a node inside a dot directory is
 * never listed; a dot FILE is never listed; a dot DIRECTORY itself is.
 */
function isListed(uri: string, type: FakeOpenVikingNode['type']): boolean {
  const relative = uri.slice(ROOT_URI.length)
  const segments = relative.split('/')
  const ancestors = segments.slice(0, -1)
  if (ancestors.some(segment => segment.startsWith('.'))) return false
  const name = segments[segments.length - 1]
  if (name.startsWith('.') && type === 'file') return false
  return true
}

/** Turns a glob pattern into a RegExp — `**` crosses segments, `*` does not. */
function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/** Deterministic scoring: title-tag hits dominate, body hits refine. */
function scoreNode(query: string, node: FakeOpenVikingNode): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return 0.1
  const titleTag = node.tags.find(tag => tag.startsWith('title='))?.slice('title='.length) ?? ''
  let title = titleTag
  try {
    title = decodeURIComponent(titleTag)
  } catch {
    // Malformed escaping keeps the raw text — the fake never fails a read.
  }
  const loweredTitle = title.toLowerCase()
  const loweredContent = (node.content ?? '').toLowerCase()
  const titleHits = tokens.filter(token => loweredTitle.includes(token)).length
  const bodyHits = tokens.filter(token => loweredContent.includes(token)).length
  let score = 0.1
  if (titleHits > 0) score += 0.3 + 0.5 * (titleHits / tokens.length)
  if (bodyHits > 0) score += 0.3 * (bodyHits / tokens.length)
  return Math.min(score, 1)
}

/** True when every `k=v` filter appears in the node's tag list verbatim. */
function matchesTagFilters(tags: string[], filters: string[]): boolean {
  return filters.every(filter => tags.includes(filter))
}

/** True when the uri equals the target or lives underneath it. */
function underTarget(uri: string, target: string): boolean {
  const normalized = target.endsWith('/') ? target : `${target}/`
  return uri === target || uri.startsWith(normalized)
}

/**
 * Measured server behavior, e2e round 2026-10-21 (E2): OpenViking lower-cases
 * EVERY tag VALUE it stores — `"B1"` comes back `"b1"`, an url-encoded
 * `"Annual%20LEAVE%20Policy"` as `"annual%20leave%20policy"`. Keys are left
 * alone. The fake applies it on the two write paths (`content/write`,
 * `attrs/set_tags`) exactly where the real service does.
 */
function lowerCaseTagValues(tags: string[]): string[] {
  return tags.map(tag => {
    const separator = tag.indexOf('=')
    if (separator <= 0) return tag
    return `${tag.slice(0, separator + 1)}${tag.slice(separator + 1).toLowerCase()}`
  })
}

export class FakeOpenVikingServer {
  readonly baseUrl: string
  readonly requests: FakeRecordedRequest[] = []
  private readonly rootApiKey: string
  private readonly accounts = new Map<string, FakeAccount>()
  private readonly trees = new Map<string, Map<string, FakeOpenVikingNode>>()
  private readonly faults: FakeFault[] = []
  private readonly delays = new Map<string, number>()
  /** When set, `search/find` answers with these rows verbatim. */
  private findOverride: Array<Record<string, unknown>> | null = null
  /**
   * Measured server behavior, e2e round 2026-10-21 (E1) + the hardening round:
   * every directory a client creates (mkdir, and the account's resource root
   * at account creation) starts an ingestion pipeline that lasts this many ms
   * and REBUILDS the directory's attributes when it finishes — a `set_tags`
   * issued before that answers `ok` while silently dropping the tags (files
   * are unaffected). `system/wait` blocks until the pipeline drains, which is
   * when the writes start to stick. 0 disables the pipeline; tests inject a
   * small one to reproduce the loss and the store's wait+poll recovery, or a
   * window longer than the client's 12s bound to reproduce the give-up.
   */
  private directoryPipelineMs = 0
  /** One-shot tree mutations consumed before the next matching request. */
  private readonly mutations: Array<{
    method: string
    pathPrefix?: string
    nth: number
    seen: number
    hook: (tree: Map<string, FakeOpenVikingNode>) => void
  }> = []
  /** Requests currently being served — `reset` waits for them to drain. */
  private inflight = 0
  /**
   * Live `system/wait` sleepers, woken by `reset()`. The request signal's
   * abort-on-disconnect is platform-dependent, so the drain never relies on
   * it alone: a wait a finished test abandoned must not pin `inflight` into
   * the next test (review round m1).
   */
  private readonly pendingPipelineWaits = new Set<() => void>()
  private readonly server: ReturnType<typeof Bun.serve>

  private constructor(rootApiKey: string) {
    this.rootApiKey = rootApiKey
    this.server = Bun.serve({ port: 0, fetch: request => this.handle(request) })
    this.baseUrl = `http://127.0.0.1:${this.server.port}`
  }

  static start(rootApiKey: string): FakeOpenVikingServer {
    return new FakeOpenVikingServer(rootApiKey)
  }

  stop(): void {
    this.server.stop(true)
  }

  /**
   * Between-tests wipe: accounts, trees, faults and the request log. The
   * await lets requests a PREVIOUS test left in flight (e.g. a best-effort
   * transition log fired with `void`) finish against the state they were
   * aimed at, so their responses never land in the next test's log.
   */
  async reset(): Promise<void> {
    // Wake abandoned pipeline waits BEFORE the drain loop — the sleepers are
    // the inflight requests most likely to outlive their test.
    for (const wake of [...this.pendingPipelineWaits]) wake()
    const deadline = Date.now() + 5_000
    while (this.inflight > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    this.accounts.clear()
    this.trees.clear()
    this.faults.length = 0
    this.delays.clear()
    this.mutations.length = 0
    this.findOverride = null
    this.directoryPipelineMs = 0
    this.requests.length = 0
  }

  // -------------------------------------------------------------------------
  // Test seams
  // -------------------------------------------------------------------------

  /** Arms one failure consumed by the first `times` matching requests. */
  armFault(fault: FakeFault): void {
    this.faults.push(fault)
  }

  /** Applies an artificial latency to every request under a path prefix. */
  setDelay(pathPrefix: string, ms: number): void {
    this.delays.set(pathPrefix, ms)
  }

  /** Replaces the `search/find` result set until cleared with `null`. */
  setFindOverride(resources: Array<Record<string, unknown>> | null): void {
    this.findOverride = resources
  }

  /**
   * Arms the E1 measured pipeline: every directory created while this is set
   * runs an ingestion pipeline of this many ms, and a `attrs/set_tags` issued
   * before the pipeline finishes answers `ok` but writes nothing (real
   * instance behavior, brief §1.10) — the pipeline's attribute rebuild wipes
   * it. `system/wait` blocks until the pipeline drains. Defaults to the
   * ~4s the semantic mode measured; `0` turns it off. Arm BEFORE the mkdir:
   * the pipeline duration is fixed when the directory is created, exactly as
   * the real pipeline starts with it.
   */
  setDirectoryTagLossWindow(ms = 4_000): void {
    this.directoryPipelineMs = ms
  }

  /**
   * Arms ONE data-plane mutation consumed before the next matching request is
   * served (review fix round B6). The hook receives the mutable tree, so a
   * test can rewrite state from "outside" the store — e.g. a concurrent
   * writer landing on the document tags BETWEEN the store's set_tags and its
   * attrs read-back. `nth` (1-based) targets a LATER occurrence of the match,
   * which is how a test reaches the read-back attrs instead of gate-one's.
   */
  armMutation(
    match: { method: string; pathPrefix?: string; nth?: number },
    hook: (tree: Map<string, FakeOpenVikingNode>) => void,
  ): void {
    this.mutations.push({
      method: match.method,
      pathPrefix: match.pathPrefix,
      nth: match.nth ?? 1,
      seen: 0,
      hook,
    })
  }

  /** Direct account creation — seeds the "another device provisioned" state. */
  createAccount(accountId: string, adminUserId: string): { accountId: string; userKey: string } {
    const existing = this.accounts.get(accountId)
    if (existing) {
      const user = existing.users.get(adminUserId)
      if (!user) throw new Error(`account ${accountId} has no user ${adminUserId}`)
      return { accountId, userKey: user.apiKey }
    }
    return this.createAccountInternal(accountId, adminUserId)
  }

  /** The tree of one account — direct state assertions and corruption. */
  tree(accountId: string): Map<string, FakeOpenVikingNode> {
    const tree = this.trees.get(accountId)
    if (!tree) throw new Error(`unknown account ${accountId}`)
    return tree
  }

  /** Whether the account exists (provisioning idempotency assertions). */
  hasAccount(accountId: string): boolean {
    return this.accounts.has(accountId)
  }

  /** One account's user key — assertion input for plane-separation checks. */
  userKey(accountId: string, userId = 'polo-service'): string {
    const user = this.accounts.get(accountId)?.users.get(userId)
    if (!user) throw new Error(`unknown user ${accountId}/${userId}`)
    return user.apiKey
  }

  /** Writes one node straight into the tree, creating parents as needed. */
  putNode(accountId: string, node: Partial<FakeOpenVikingNode> & { uri: string }): void {
    const tree = this.tree(accountId)
    const uri = normalizeUri(node.uri)
    for (let parent = parentUri(uri); parent !== null; parent = parentUri(parent)) {
      if (tree.has(parent) || parent === ROOT_URI) break
      tree.set(parent, { uri: parent, type: 'dir', tags: [], content: null, mtime: nowIso() })
    }
    tree.set(uri, {
      uri,
      type: node.type ?? 'file',
      tags: node.tags ?? [],
      content: node.content ?? null,
      mtime: node.mtime ?? nowIso(),
    })
  }

  // -------------------------------------------------------------------------
  // HTTP surface
  // -------------------------------------------------------------------------

  private async handle(request: Request): Promise<Response> {
    this.inflight += 1
    try {
      return await this.serve(request)
    } finally {
      this.inflight -= 1
    }
  }

  private async serve(request: Request): Promise<Response> {
    const url = new URL(request.url)
    let body: unknown = null
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      body = await request.json().catch(() => null)
    }
    const authorization = request.headers.get('authorization')
    const record: FakeRecordedRequest = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      body,
      authorization,
    }
    this.requests.push(record)

    const fault = this.takeFault(record)
    if (fault) {
      return Response.json(
        { status: 'error', error: { code: fault.code, message: fault.message, details: null } },
        { status: fault.status },
      )
    }
    const delay = [...this.delays.entries()]
      .filter(([prefix]) => url.pathname.startsWith(prefix))
      .map(([, ms]) => ms)
      .reduce((left, right) => Math.max(left, right), 0)
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))

    // Auth: the root key opens the admin plane only; an account user key
    // opens the data plane only; everything else is unauthorized.
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null
    if (!token) {
      return this.error(401, 'UNAUTHORIZED', 'missing bearer token')
    }
    // `POST /api/v1/system/wait` answers on BOTH planes on the real instance
    // (verified: root key and account user key both accepted) and blocks
    // until the ingestion pipelines of the caller's scope have drained — the
    // drain a directory tag write waits for before it can stick (e2e E1).
    if (request.method === 'POST' && url.pathname === '/api/v1/system/wait') {
      const accounts = token === this.rootApiKey
        ? [...this.accounts.keys()]
        : [this.accountForUserKey(token)].filter((id): id is string => id !== null)
      if (accounts.length === 0) {
        return this.error(401, 'UNAUTHORIZED', 'unknown credential')
      }
      await this.awaitPipelines(request.signal, accounts)
      return this.ok({
        Embedding: { processed: 0, requeue_count: 0, error_count: 0, errors: [] },
        Semantic: { processed: 0, requeue_count: 0, error_count: 0, errors: [] },
        ExternalParse: { processed: 0, requeue_count: 0, error_count: 0, errors: [] },
        AddResource: { processed: 0, requeue_count: 0, error_count: 0, errors: [] },
        Reindex: { processed: 0, requeue_count: 0, error_count: 0, errors: [] },
        SessionCommit: { processed: 0, requeue_count: 0, error_count: 0, errors: [] },
        ExternalTask: { processed: 0, requeue_count: 0, error_count: 0, errors: [] },
        UserDeletion: { processed: 0, requeue_count: 0, error_count: 0, errors: [] },
      })
    }
    if (url.pathname.startsWith('/api/v1/admin/')) {
      if (token !== this.rootApiKey) {
        return this.error(403, 'PERMISSION_DENIED', 'the admin plane requires the root key')
      }
      return this.handleAdmin(record)
    }
    // The root key NEVER opens the data plane (brief §1) — check it before
    // the user-key lookup so it reads as a refusal, not as unknown.
    if (token === this.rootApiKey) {
      return this.error(403, 'PERMISSION_DENIED', 'the root key has no data-plane access')
    }
    const accountId = this.accountForUserKey(token)
    if (!accountId) {
      return this.error(401, 'UNAUTHORIZED', 'unknown credential')
    }
    return this.handleDataPlane(accountId, record)
  }

  private takeFault(record: FakeRecordedRequest): FakeFault | null {
    for (let index = 0; index < this.faults.length; index += 1) {
      const fault = this.faults[index]
      if (fault.times <= 0) continue
      if (fault.method && fault.method !== record.method) continue
      if (!record.path.startsWith(fault.pathPrefix)) continue
      fault.times -= 1
      if (fault.times <= 0) this.faults.splice(index, 1)
      return fault
    }
    return null
  }

  private accountForUserKey(token: string): string | null {
    for (const [accountId, account] of this.accounts) {
      for (const user of account.users.values()) {
        if (user.apiKey === token) return accountId
      }
    }
    return null
  }

  /**
   * `system/wait`'s drain: sleeps until the latest pipeline in scope has
   * finished. The sleep ends on whichever comes first: the pipeline's own
   * deadline, the request signal aborting (fast path when it does fire), or
   * the next `reset()` waking the sleeper explicitly.
   */
  private async awaitPipelines(signal: AbortSignal, accountIds: string[]): Promise<void> {
    let latest = 0
    for (const accountId of accountIds) {
      for (const node of this.trees.get(accountId)?.values() ?? []) {
        if (node.type === 'dir' && node.processingUntil !== undefined && node.processingUntil > latest) {
          latest = node.processingUntil
        }
      }
    }
    const remainingMs = latest - Date.now()
    if (remainingMs <= 0) return
    await new Promise<void>(resolve => {
      const finish = (): void => {
        this.pendingPipelineWaits.delete(finish)
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, remainingMs)
      this.pendingPipelineWaits.add(finish)
      if (signal.aborted) return finish()
      signal.addEventListener('abort', finish)
    })
  }

  private error(status: number, code: string, message: string): Response {
    return Response.json(
      { status: 'error', error: { code, message, details: null } },
      { status },
    )
  }

  private ok(result: unknown): Response {
    return Response.json({ status: 'ok', result })
  }

  // -------------------------------------------------------------------------
  // Admin plane
  // -------------------------------------------------------------------------

  private handleAdmin(record: FakeRecordedRequest): Response {
    const { method, path, body } = record
    if (method === 'POST' && path === '/api/v1/admin/accounts') {
      const input = body as { account_id?: unknown; admin_user_id?: unknown } | null
      const accountId = typeof input?.account_id === 'string' ? input.account_id : ''
      const adminUserId = typeof input?.admin_user_id === 'string' ? input.admin_user_id : ''
      if (!accountId || !adminUserId) {
        return this.error(400, 'INVALID_ARGUMENT', 'account_id and admin_user_id are required')
      }
      if (this.accounts.has(accountId)) {
        return this.error(409, 'ALREADY_EXISTS', `account ${accountId} already exists`)
      }
      const created = this.createAccountInternal(accountId, adminUserId)
      return this.ok({
        account_id: created.accountId,
        admin_user_id: adminUserId,
        user_key: created.userKey,
      })
    }
    if (method === 'GET' && path === '/api/v1/admin/accounts') {
      const rows = [...this.accounts.values()].map(account => ({
        account_id: account.accountId,
        created_at: account.createdAt,
        status: 'active',
        user_count: account.users.size,
      }))
      return this.ok(rows)
    }
    const usersMatch = /^\/api\/v1\/admin\/accounts\/([^/]+)\/users$/.exec(path)
    if (method === 'GET' && usersMatch) {
      const account = this.accounts.get(decodeURIComponent(usersMatch[1]))
      if (!account) return this.error(404, 'NOT_FOUND', 'unknown account')
      const includeCredentials = record.query.get('include_credentials') === 'true'
      const users = [...account.users.entries()].map(([userId, user]) => ({
        user_id: userId,
        username: userId,
        role: user.role,
        ...(includeCredentials ? { user_key: user.apiKey } : {}),
      }))
      return this.ok({ users })
    }
    return this.error(404, 'NOT_FOUND', `unexpected admin path ${path}`)
  }

  private createAccountInternal(accountId: string, adminUserId: string): { accountId: string; userKey: string } {
    const account: FakeAccount = {
      accountId,
      createdAt: nowIso(),
      users: new Map(),
    }
    const userKey = `ok-${createHash('sha256').update(`${accountId}:${adminUserId}:fake`).digest('hex').slice(0, 32)}`
    account.users.set(adminUserId, { username: adminUserId, role: 'admin', apiKey: userKey })
    this.accounts.set(accountId, account)
    // Every account starts with its resource root; ownership tags land on it.
    // The root is a freshly created DIRECTORY: it runs the same ingestion
    // pipeline as any mkdir (e2e E1 — the marker written right after the
    // creation was dropped on the real instance), so it is armed identically.
    this.trees.set(accountId, new Map([[ROOT_URI, {
      uri: ROOT_URI,
      type: 'dir',
      tags: [],
      content: null,
      mtime: nowIso(),
      ...this.pipelineFromNow(),
    }]]))
    return { accountId, userKey }
  }

  // -------------------------------------------------------------------------
  // Data plane
  // -------------------------------------------------------------------------

  private handleDataPlane(accountId: string, record: FakeRecordedRequest): Response {
    const tree = this.trees.get(accountId)
    if (!tree) return this.error(404, 'NOT_FOUND', 'unknown account')
    const { method, path, body } = record
    // One-shot mutations run BEFORE the matched request, so the request sees
    // the rewritten tree (the B6 "concurrent writer" window). `nth` counts
    // MATCHING requests; the hook fires when the nth one arrives.
    const mutationIndex = this.mutations.findIndex(candidate => candidate.method === method
      && (candidate.pathPrefix === undefined || path.startsWith(candidate.pathPrefix)))
    if (mutationIndex >= 0) {
      const mutation = this.mutations[mutationIndex]
      mutation.seen += 1
      if (mutation.seen >= mutation.nth) {
        this.mutations.splice(mutationIndex, 1)
        mutation.hook(tree)
      }
    }
    if (method === 'POST' && path === '/api/v1/fs/mkdir') {
      return this.mkdir(tree, body as { uri?: unknown })
    }
    if (method === 'POST' && path === '/api/v1/fs/mv') {
      return this.mv(tree, body as { from_uri?: unknown; to_uri?: unknown })
    }
    if (method === 'DELETE' && path === '/api/v1/fs') {
      return this.remove(tree, record)
    }
    if (method === 'POST' && path === '/api/v1/content/write') {
      return this.writeContent(tree, body as Record<string, unknown> | null)
    }
    if (method === 'GET' && path === '/api/v1/content/read') {
      return this.readContent(tree, record)
    }
    if (method === 'GET' && path === '/api/v1/fs/attrs') {
      return this.attrs(tree, record)
    }
    if (method === 'POST' && path === '/api/v1/fs/attrs/set_tags') {
      return this.setTags(tree, body as Record<string, unknown> | null)
    }
    if (method === 'GET' && path === '/api/v1/fs/ls') {
      return this.ls(tree, record)
    }
    if (method === 'POST' && path === '/api/v1/search/find') {
      return this.find(tree, body as Record<string, unknown> | null)
    }
    if (method === 'POST' && path === '/api/v1/search/glob') {
      return this.glob(tree, body as Record<string, unknown> | null)
    }
    return this.error(404, 'NOT_FOUND', `unexpected path ${path}`)
  }

  private mkdir(tree: Map<string, FakeOpenVikingNode>, body: { uri?: unknown } | null): Response {
    const uri = typeof body?.uri === 'string' ? normalizeUri(body.uri) : ''
    if (!uri) return this.error(400, 'INVALID_ARGUMENT', 'uri is required')
    if (tree.has(uri) || uri === ROOT_URI) {
      return this.error(409, 'ALREADY_EXISTS', `${uri} already exists`)
    }
    const parent = parentUri(uri)
    if (parent && parent !== ROOT_URI && !tree.has(parent)) {
      return this.error(404, 'PARENT_NOT_FOUND', `parent ${parent} does not exist`)
    }
    tree.set(uri, { uri, type: 'dir', tags: [], content: null, mtime: nowIso(), ...this.pipelineFromNow() })
    return this.ok({ uri })
  }

  /** The ingestion pipeline a freshly created directory runs, if armed. */
  private pipelineFromNow(): { processingUntil?: number } {
    return this.directoryPipelineMs > 0
      ? { processingUntil: Date.now() + this.directoryPipelineMs }
      : {}
  }

  private mv(
    tree: Map<string, FakeOpenVikingNode>,
    body: { from_uri?: unknown; to_uri?: unknown } | null,
  ): Response {
    const from = typeof body?.from_uri === 'string' ? normalizeUri(body.from_uri) : ''
    const to = typeof body?.to_uri === 'string' ? normalizeUri(body.to_uri) : ''
    if (!from || !to) return this.error(400, 'INVALID_ARGUMENT', 'from_uri and to_uri are required')
    const node = tree.get(from)
    if (!node) return this.error(404, 'NOT_FOUND', `${from} does not exist`)
    const parent = parentUri(to)
    if (parent && parent !== ROOT_URI && !tree.has(parent)) {
      return this.error(404, 'PARENT_NOT_FOUND', `parent ${parent} does not exist`)
    }
    // An existing target is OVERWRITTEN (the verified semantics the KB's
    // recycle step relies on when a name collides).
    tree.delete(from)
    tree.set(to, { ...node, uri: to, mtime: nowIso() })
    return this.ok({ from_uri: from, to_uri: to })
  }

  private remove(tree: Map<string, FakeOpenVikingNode>, record: FakeRecordedRequest): Response {
    const uri = record.query.get('uri')
    if (!uri) return this.error(400, 'INVALID_ARGUMENT', 'uri is required')
    const normalized = normalizeUri(uri)
    if (normalized === ROOT_URI) return this.error(400, 'INVALID_ARGUMENT', 'cannot remove the root')
    const node = tree.get(normalized)
    if (!node) return this.error(404, 'NOT_FOUND', `${normalized} does not exist`)
    const recursive = record.query.get('recursive') === 'true'
    if (!recursive && node.type === 'dir') {
      const hasChildren = [...tree.keys()].some(key => key !== normalized && parentUri(key) === normalized)
      if (hasChildren) return this.error(400, 'DIR_NOT_EMPTY', `${normalized} is not empty`)
    }
    if (recursive) {
      for (const key of [...tree.keys()]) {
        if (key === normalized || key.startsWith(`${normalized}/`)) tree.delete(key)
      }
    } else {
      tree.delete(normalized)
    }
    return this.ok({ uri: normalized })
  }

  private writeContent(tree: Map<string, FakeOpenVikingNode>, body: Record<string, unknown> | null): Response {
    const uri = typeof body?.uri === 'string' ? normalizeUri(body.uri) : ''
    const content = typeof body?.content === 'string' ? body.content : null
    if (!uri || uri === ROOT_URI) return this.error(400, 'INVALID_ARGUMENT', 'uri is required')
    if (tree.get(uri)?.type === 'dir') {
      return this.error(400, 'INVALID_ARGUMENT', `${uri} is a directory`)
    }
    // Missing parents are created implicitly — the transition log writes into
    // a hidden subtree it never mkdirs (brief §1 content/write semantics).
    for (let parent = parentUri(uri); parent !== null && parent !== ROOT_URI; parent = parentUri(parent)) {
      if (tree.has(parent)) break
      tree.set(parent, { uri: parent, type: 'dir', tags: [], content: null, mtime: nowIso() })
    }
    const tags = Array.isArray(body?.tags)
      ? lowerCaseTagValues(body.tags.filter((tag): tag is string => typeof tag === 'string'))
      : []
    const existing = tree.get(uri)
    tree.set(uri, {
      uri,
      type: 'file',
      tags: body?.tag_mode === 'append' ? [...(existing?.tags ?? []), ...tags] : tags,
      content,
      mtime: nowIso(),
    })
    return this.ok({ uri })
  }

  private readContent(tree: Map<string, FakeOpenVikingNode>, record: FakeRecordedRequest): Response {
    const uri = record.query.get('uri')
    if (!uri) return this.error(400, 'INVALID_ARGUMENT', 'uri is required')
    const node = tree.get(normalizeUri(uri))
    return this.ok({ content: node?.type === 'file' ? node.content : null })
  }

  private attrs(tree: Map<string, FakeOpenVikingNode>, record: FakeRecordedRequest): Response {
    const uri = record.query.get('uri')
    if (!uri) return this.error(400, 'INVALID_ARGUMENT', 'uri is required')
    const node = tree.get(normalizeUri(uri))
    // A missing node reads as `attrs: null` — the client maps that to a null
    // node, never to an error.
    if (!node) return this.ok({ attrs: null })
    return this.ok({
      attrs: {
        uri: node.uri,
        tags: node.tags,
        mtime: node.mtime,
        type: node.type === 'dir' ? 'dir' : 'file',
      },
    })
  }

  private setTags(tree: Map<string, FakeOpenVikingNode>, body: Record<string, unknown> | null): Response {
    const uri = typeof body?.uri === 'string' ? normalizeUri(body.uri) : ''
    if (!uri) return this.error(400, 'INVALID_ARGUMENT', 'uri is required')
    const node = tree.get(uri)
    if (!node) return this.error(404, 'NOT_FOUND', `${uri} does not exist`)
    // E1 (measured 2026-10-21): a directory's tags write issued while its
    // ingestion pipeline is still running answers ok and writes NOTHING — the
    // pipeline's attribute rebuild wipes it on completion. The store's
    // wait-for-pipeline + read-back poll is what recovers from this.
    if (node.type === 'dir' && node.processingUntil !== undefined
      && Date.now() < node.processingUntil) {
      return this.ok({ uri, tags: node.tags })
    }
    const tags = Array.isArray(body?.tags)
      ? lowerCaseTagValues(body.tags.filter((tag): tag is string => typeof tag === 'string'))
      : []
    const mode = typeof body?.mode === 'string' ? body.mode : 'replace'
    if (mode === 'clear') node.tags = []
    else if (mode === 'append') node.tags = [...node.tags, ...tags]
    else node.tags = tags
    node.mtime = nowIso()
    return this.ok({ uri, tags: node.tags })
  }

  private ls(tree: Map<string, FakeOpenVikingNode>, record: FakeRecordedRequest): Response {
    const uri = record.query.get('uri')
    if (!uri) return this.error(400, 'INVALID_ARGUMENT', 'uri is required')
    const base = normalizeUri(uri)
    if (base !== ROOT_URI && !tree.has(base)) return this.error(404, 'NOT_FOUND', `${base} does not exist`)
    const recursive = record.query.get('recursive') === 'true'
    const filters = record.query.getAll('tags')
    const rows: FakeOpenVikingNode[] = []
    for (const node of tree.values()) {
      if (node.uri === ROOT_URI) continue
      if (recursive) {
        // The walk descends only into non-dot directories: everything inside
        // a dot directory stays hidden (brief §1.7).
        if (!underTarget(node.uri, base) && !(base === ROOT_URI)) continue
        if (!isListed(node.uri, node.type)) continue
      } else {
        if (parentUri(node.uri) !== base) continue
        const name = baseName(node.uri)
        if (name.startsWith('.') && node.type === 'file') continue
      }
      if (!matchesTagFilters(node.tags, filters)) continue
      rows.push(node)
    }
    rows.sort((left, right) => left.uri.localeCompare(right.uri))
    const nodeLimit = record.query.get('node_limit')
    const offset = Number(record.query.get('offset') ?? '0') || 0
    const limit = nodeLimit === null ? rows.length : Math.max(Number(nodeLimit) || 0, 0)
    const page = rows.slice(offset, offset + limit)
    return this.ok({
      entries: page.map(node => ({
        uri: node.uri,
        tags: node.tags,
        mtime: node.mtime,
        type: node.type === 'dir' ? 'dir' : 'file',
      })),
      has_more: offset + page.length < rows.length,
    })
  }

  private find(tree: Map<string, FakeOpenVikingNode>, body: Record<string, unknown> | null): Response {
    if (this.findOverride) {
      const rows = this.findOverride.slice(0, typeof body?.limit === 'number' ? body.limit : 20)
      return this.ok({ resources: rows })
    }
    const query = typeof body?.query === 'string' ? body.query : ''
    const targets = Array.isArray(body?.target_uri)
      ? body.target_uri.filter((target): target is string => typeof target === 'string')
      : typeof body?.target_uri === 'string'
        ? [body.target_uri]
        : []
    const filters = Array.isArray(body?.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === 'string')
      : []
    const limit = typeof body?.limit === 'number' ? body.limit : 20
    const readContent = body?.read_content === true
    const resources = [...tree.values()]
      .filter(node => node.type === 'file')
      // Measured server behavior (brief §1): find indexes EVERY file,
      // including hidden dot paths — unlike ls, it has no visibility filter.
      // What keeps a soft-deleted document out of the retrieval face is the
      // `status=published` tag filter the store sends, not path hiding; that
      // is exactly why D4 removes the status tag BEFORE the recycle move.
      .filter(node => targets.length === 0 || targets.some(target => underTarget(node.uri, target)))
      .filter(node => matchesTagFilters(node.tags, filters))
      .map(node => ({
        uri: node.uri,
        score: Number(scoreNode(query, node).toFixed(4)),
        tags: node.tags,
        ...(readContent ? { content: node.content ?? '' } : {}),
      }))
      .sort((left, right) => right.score - left.score || left.uri.localeCompare(right.uri))
      .slice(0, limit)
    return this.ok({ resources })
  }

  private glob(tree: Map<string, FakeOpenVikingNode>, body: Record<string, unknown> | null): Response {
    const pattern = typeof body?.pattern === 'string' ? body.pattern : ''
    const base = typeof body?.uri === 'string' ? normalizeUri(body.uri) : ROOT_URI
    if (!pattern) return this.error(400, 'INVALID_ARGUMENT', 'pattern is required')
    const matcher = globToRegExp(pattern)
    const limit = typeof body?.node_limit === 'number' ? body.node_limit : 10_000
    const matches = [...tree.values()]
      .filter(node => node.type === 'file')
      .filter(node => underTarget(node.uri, base))
      .map(node => node.uri)
      .filter(uri => matcher.test(uri))
      .sort()
      .slice(0, limit)
    return this.ok({ matches })
  }
}
