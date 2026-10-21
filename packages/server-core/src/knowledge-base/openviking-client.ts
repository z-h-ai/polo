/**
 * OpenViking Context HTTP client (POO-108 v3.1) — every endpoint the KB uses.
 *
 * Request/response shapes follow the real instance (v0.5.1.1, `auth_mode=api_key`)
 * as recorded in `.pipeline/sdlc/POO-108/dev-brief-v3-openviking-native.md` §1
 * and its `GET /openapi.json`:
 *
 * - Provisioning plane (ROOT key only — the root key is REFUSED on the data
 *   plane with HTTP 403 `PERMISSION_DENIED`): `POST/GET /api/v1/admin/accounts`
 *   and `GET /api/v1/admin/accounts/{id}/users?include_credentials=true`.
 *   Creating an account mints its first admin user and returns the user key
 *   exactly once; re-creating the same account fails with `ALREADY_EXISTS`
 *   (the idempotent re-use hook), and an existing user's key can be read back
 *   through the users list WITHOUT re-signing it (the credential-recovery path).
 * - Data plane (the tenant's per-account user key): `fs/mkdir`, `fs/mv`,
 *   `fs/rm` (DELETE /fs), `fs/attrs`, `fs/attrs/set_tags`, `fs/ls`,
 *   `content/write`, `content/read`, `search/find`, `search/glob`.
 *
 * Brief v4 adds the CLOUD-MANAGED library mode (`POLO_OPENVIKING_API_KEY`):
 * the same data-plane surface against `https://api.vikingdb.cn-beijing.
 * volces.com/openviking`, authenticated by the library key ALONE — no admin
 * plane exists there (libraries are created in the vendor console), so the
 * provisioning calls below are never reached in that mode. Every request
 * carries BOTH `Authorization: Bearer <key>` and `X-API-Key: <key>` in both
 * modes (the local plugin accepts either; the cloud reads the bearer).
 *
 * The client is deliberately dumb: plain `fetch`, bounded timeouts (provision
 * 30s, writes 120s, reads/attrs/ls/glob 15s, find 8s — brief D10) and
 * structured `OpenVikingError` failures. Error MESSAGES may carry the raw
 * server detail: they are logged server-side only and are mapped to neutral
 * user-facing text at the RPC boundary (brief D7 — the enterprise user must
 * never learn a storage vendor exists).
 */

export const OPENVIKING_PROVISION_TIMEOUT_MS = 30_000
export const OPENVIKING_WRITE_TIMEOUT_MS = 120_000
export const OPENVIKING_READ_TIMEOUT_MS = 15_000
export const OPENVIKING_FIND_TIMEOUT_MS = 8_000
/**
 * The pipeline wait (`POST /api/v1/system/wait`). The measured instance blocks
 * there for the length of a directory's ingestion — ~0.5s for a plain mkdir,
 * ~4.5s right after an account creation in `semantic_and_vectors` (measured
 * 2026-10-21) — so the bound covers the slow mode. It is a CEILING only: the
 * verified directory-tag loop passes a per-call budget of what remains of its
 * own 12s window (review round M1), so in practice the wait never outlives
 * the loop. A timed-out wait is absorbed (the tag write still runs, the poll
 * loop catches a loss).
 */
export const OPENVIKING_WAIT_TIMEOUT_MS = 12_000

export type OpenVikingErrorCode =
  | 'openviking_timeout'
  | 'openviking_network_error'
  | 'openviking_http_error'
  | 'openviking_invalid_response'

/**
 * Thrown for every OpenViking failure. `code` is the stable transport-level
 * classification, `status` the HTTP status when one was received, `serverCode`
 * the server's own error code (e.g. `ALREADY_EXISTS`) and `detail` the raw
 * failure body. The message/detail carry vendor specifics — for server-side
 * logs and the audit trail only.
 */
export class OpenVikingError extends Error {
  constructor(
    readonly code: OpenVikingErrorCode,
    message: string,
    readonly status?: number,
    readonly serverCode?: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'OpenVikingError'
  }
}

/**
 * True when the server answered an idempotent-create with "already there".
 * The two deployments phrase it differently (acceptance finding V2, cloud
 * round 2026-10-21): the OSS instance answers `ALREADY_EXISTS`, the MANAGED
 * cloud answers `HTTP 409 CONFLICT` with an "already exists" message — both
 * are the idempotent-create success this predicate exists to recognize.
 */
export function isOpenVikingAlreadyExists(error: unknown): boolean {
  return error instanceof OpenVikingError
  && (error.serverCode === 'ALREADY_EXISTS'
    || (error.status === 409 && /already exists/i.test(error.message)))
}

/** True when the server refused the credential (missing, wrong or forbidden). */
export function isOpenVikingAuthError(error: unknown): boolean {
  return error instanceof OpenVikingError
  && (error.status === 401 || error.status === 403)
}

/**
 * True when the server answered "no such node" — the managed-library mode
 * reads a MISSING space root as an empty knowledge base (the space's
 * directory is created on first use, never on a read path, brief v4 D-A), so
 * the store must be able to tell that case from a real listing failure. The
 * OSS mode never hits it (the account root always exists).
 */
export function isOpenVikingNotFound(error: unknown): boolean {
  return error instanceof OpenVikingError
  && (error.status === 404 || error.serverCode === 'NOT_FOUND')
}

/** OpenViking ingestion modes (the real API values — there is no `full`). */
export type OpenVikingProcessingMode = 'vectors_only' | 'semantic_and_vectors'

export interface OpenVikingConfig {
  /** Base URL without a trailing slash, e.g. `http://127.0.0.1:1933`. */
  baseUrl: string
  /**
   * The ROOT key (`POLO_OPENVIKING_ROOT_API_KEY`) — provisioning plane only.
   * Data-plane calls use the per-tenant user key handed in per call, so a
   * deployment that never provisions still never needs the root key.
   *
   * Ignored whenever `managedApiKey` is set: the cloud-managed library has no
   * provisioning plane to speak of (the library is created in the vendor
   * console), so a root key configured alongside the managed key can only be
   * a misconfiguration — it is dropped and the conflict is warned once.
   */
  rootApiKey?: string
  /**
   * The MANAGED-LIBRARY key (`POLO_OPENVIKING_API_KEY`, brief v4 D-A) — the
   * data-plane credential of one cloud-hosted OpenViking library (Volcano
   * Engine "OpenViking Context"). When set, the deployment runs managed
   * mode: this key authenticates every call directly, `tenant.ts` is never
   * consulted (no per-space account, no CredentialManager binding) and each
   * space's data lives under its own directory beneath `viking://resources/`
   * (the store derives it). Unset → the local OSS multi-tenant mode.
   */
  managedApiKey?: string
  /**
   * `semantic_and_vectors` additionally asks the server's VLM for abstracts;
   * it needs a configured VLM on the OpenViking side and makes ingestion
   * slower, so the default stays `vectors_only`.
   */
  processingMode: OpenVikingProcessingMode
}

/**
 * OpenViking is opt-in through the environment and read at CALL time (never
 * module load), so a server started without it stays exactly as before and a
 * test can flip the flag per case. Unset `POLO_OPENVIKING_URL` disables every
 * OpenViking behavior — the KB then reports `kb_service_unavailable` (brief D7).
 *
 * Mode selection (brief v4 D-A): `POLO_OPENVIKING_API_KEY` selects the
 * cloud-MANAGED library mode — that key alone is the data-plane credential,
 * and `POLO_OPENVIKING_ROOT_API_KEY` is ignored for the run (the managed
 * library has no provisioning plane; a root key set alongside can only be a
 * misconfiguration, so it is dropped and the conflict is warned ONCE — a
 * module-level flag keeps a per-call read from spamming the log).
 */
let warnedManagedRootConflict = false

export function resetOpenVikingManagedConflictWarningForTests(): void {
  warnedManagedRootConflict = false
}

export function readOpenVikingConfig(env: Record<string, string | undefined> = process.env): OpenVikingConfig | null {
  const baseUrl = env.POLO_OPENVIKING_URL?.trim()
  if (!baseUrl) return null
  const managedApiKey = env.POLO_OPENVIKING_API_KEY?.trim() || undefined
  const rawRootApiKey = env.POLO_OPENVIKING_ROOT_API_KEY?.trim() || undefined
  if (managedApiKey && rawRootApiKey && !warnedManagedRootConflict) {
    warnedManagedRootConflict = true
    // Server log only — the key VALUES never reach the log, only the conflict.
    console.warn(
      '[OpenViking] POLO_OPENVIKING_API_KEY (managed-library mode) is set;'
      + ' ignoring POLO_OPENVIKING_ROOT_API_KEY — the managed library has no provisioning plane',
    )
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    managedApiKey,
    // Managed mode never touches the provisioning plane, so the root key is
    // not even retained — a leak into an admin call becomes impossible.
    rootApiKey: managedApiKey ? undefined : rawRootApiKey,
    processingMode: env.POLO_OPENVIKING_PROCESSING_MODE?.trim() === 'semantic_and_vectors'
      ? 'semantic_and_vectors'
      : 'vectors_only',
  }
}

export function isOpenVikingConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return readOpenVikingConfig(env) !== null
}

/** True when the deployment talks to ONE cloud-managed library (brief v4 D-A). */
export function isManagedOpenViking(config: OpenVikingConfig | null | undefined): boolean {
  return typeof config?.managedApiKey === 'string' && config.managedApiKey.length > 0
}

/**
 * The managed mode's data-plane auth (brief v4 D-A): the library key IS the
 * credential; the account id is the fixed label the cloud model assigns (the
 * managed plane has no per-account user model). Only meaningful when
 * `isManagedOpenViking(config)` holds.
 */
export function managedOpenVikingAuth(config: OpenVikingConfig): OpenVikingTenantAuth {
  return { accountId: 'default', userKey: config.managedApiKey ?? '' }
}

interface OpenVikingTimeouts {
  /** admin account/user provisioning — the root-key plane. */
  provisionMs: number
  /** content/write, set_tags, mkdir, mv, rm — the mutation plane. */
  writeMs: number
  /** content/read, fs/attrs, fs/ls, search/glob. */
  readMs: number
  /** search/find — bounded hard because the send path awaits it. */
  findMs: number
  /** system/wait — the ingestion-pipeline drain the directory writes ride. */
  waitMs: number
}

let timeouts: OpenVikingTimeouts = {
  provisionMs: OPENVIKING_PROVISION_TIMEOUT_MS,
  writeMs: OPENVIKING_WRITE_TIMEOUT_MS,
  readMs: OPENVIKING_READ_TIMEOUT_MS,
  findMs: OPENVIKING_FIND_TIMEOUT_MS,
  waitMs: OPENVIKING_WAIT_TIMEOUT_MS,
}

/** Test seam: shrink the wall clocks so a timeout can be observed quickly. */
export function setOpenVikingTimeoutsForTests(overrides: Partial<OpenVikingTimeouts>): void {
  timeouts = { ...timeouts, ...overrides }
}

export function resetOpenVikingTimeoutsForTests(): void {
  timeouts = {
    provisionMs: OPENVIKING_PROVISION_TIMEOUT_MS,
    writeMs: OPENVIKING_WRITE_TIMEOUT_MS,
    readMs: OPENVIKING_READ_TIMEOUT_MS,
    findMs: OPENVIKING_FIND_TIMEOUT_MS,
    waitMs: OPENVIKING_WAIT_TIMEOUT_MS,
  }
}

/**
 * `{"status":"ok","result":…}` on success, `{"status":"error","error":{"code",
 * "message","details"}}` on failure — the shape verified against the real
 * instance (the error body arrives with the matching HTTP status).
 */
interface OpenVikingEnvelope<T> {
  status?: unknown
  result?: T
  message?: unknown
  error?: unknown
}

/** The structured error body the real instance returns. */
interface OpenVikingErrorBody {
  code?: unknown
  message?: unknown
  details?: unknown
}

interface RequestOptions {
  method: 'POST' | 'GET' | 'DELETE'
  path: string
  json?: unknown
  query?: URLSearchParams
  /** The credential presented as the bearer token (root key or tenant key). */
  apiKey?: string
  timeoutMs: number
}

function describePayloadError(payload: OpenVikingEnvelope<unknown>): { message: string; serverCode?: string; detail: unknown } {
  const structured = payload.error
  if (structured && typeof structured === 'object') {
    const body = structured as OpenVikingErrorBody
    const code = typeof body.code === 'string' && body.code.trim() ? body.code.trim() : undefined
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : undefined
    if (code || message) {
      return {
        message: [code, message].filter(Boolean).join(': '),
        serverCode: code,
        detail: body.details ?? structured,
      }
    }
  }
  if (typeof structured === 'string' && structured.trim()) {
    return { message: structured.trim(), detail: structured }
  }
  const legacy = payload.message
  if (typeof legacy === 'string' && legacy.trim()) return { message: legacy.trim(), detail: payload }
  return { message: JSON.stringify(payload).slice(0, 400), detail: payload }
}

function describeBodySnippet(body: string): string {
  const snippet = body.trim().replace(/\s+/g, ' ')
  return snippet ? `: ${snippet.slice(0, 400)}` : ''
}

async function openVikingRequest<T>(config: OpenVikingConfig, options: RequestOptions): Promise<T> {
  const controller = new AbortController()
  // The timer stays armed until the body has been read: a stalled response
  // body must hit the same timeout as a stalled handshake.
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.apiKey) {
    // BOTH credential headers in BOTH modes (brief v4 D-A): the local OSS
    // plugin accepts either, the cloud gateway reads only the bearer, and a
    // server that ignores an unknown header is unaffected by the extra one —
    // one client, one code path, no per-mode header branch to drift.
    headers.authorization = `Bearer ${options.apiKey}`
    headers['x-api-key'] = options.apiKey
  }
  if (options.json !== undefined) headers['content-type'] = 'application/json'
  const query = options.query?.toString()
  const pathWithQuery = query ? `${options.path}?${query}` : options.path

  let text: string
  let status = 0
  try {
    const response = await fetch(`${config.baseUrl}${pathWithQuery}`, {
      method: options.method,
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
      signal: controller.signal,
    })
    status = response.status
    text = await response.text()
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OpenVikingError(
        'openviking_timeout',
        `OpenViking ${options.method} ${pathWithQuery} timed out after ${options.timeoutMs}ms`,
      )
    }
    throw new OpenVikingError(
      'openviking_network_error',
      `OpenViking ${options.method} ${pathWithQuery} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }

  let payload: OpenVikingEnvelope<T>
  try {
    payload = JSON.parse(text) as OpenVikingEnvelope<T>
  } catch {
    // A non-JSON body on a non-2xx status is a transport failure first —
    // a gateway HTML error page must not read as a protocol violation.
    if (status < 200 || status >= 300) {
      throw new OpenVikingError(
        'openviking_http_error',
        `OpenViking ${options.method} ${pathWithQuery} failed with HTTP ${status}${describeBodySnippet(text)}`,
        status,
      )
    }
    throw new OpenVikingError(
      'openviking_invalid_response',
      `OpenViking ${options.method} ${pathWithQuery} returned non-JSON body: ${describeBodySnippet(text)}`,
    )
  }

  if (status < 200 || status >= 300) {
    const described = describePayloadError(payload ?? {})
    throw new OpenVikingError(
      'openviking_http_error',
      `OpenViking ${options.method} ${pathWithQuery} failed with HTTP ${status}: ${described.message}`,
      status,
      described.serverCode,
      described.detail,
    )
  }
  if (!payload || payload.status !== 'ok') {
    const described = describePayloadError(payload ?? {})
    throw new OpenVikingError(
      'openviking_invalid_response',
      `OpenViking ${options.method} ${pathWithQuery} returned status=${String(payload?.status ?? 'none')}: ${described.message}`,
      status,
      described.serverCode,
      described.detail,
    )
  }
  return payload.result as T
}

/**
 * Normalizes both tag shapes OpenViking may return: `["k=v"]` strings (the
 * verified wire shape) or a plain object. Duplicate keys surface in
 * `duplicateTagKeys` instead of silently collapsing — every tag Polo writes
 * is single-valued by construction, so a duplicated key is an out-of-band
 * write and the store's STRICT parsers reject such nodes outright (brief D5).
 */
export function normalizeOpenVikingTags(tags: unknown): Record<string, string> {
  return splitOpenVikingTags(tags).tags
}

/** The normalized tag object PLUS the keys that arrived more than once. */
function splitOpenVikingTags(tags: unknown): { tags: Record<string, string>; duplicateKeys: string[] } {
  const parsed: Record<string, string> = {}
  const duplicates = new Set<string>()
  if (Array.isArray(tags)) {
    for (const entry of tags) {
      if (typeof entry !== 'string') continue
      const separator = entry.indexOf('=')
      if (separator <= 0) continue
      const key = entry.slice(0, separator)
      if (key in parsed) duplicates.add(key)
      parsed[key] = entry.slice(separator + 1)
    }
  } else if (tags && typeof tags === 'object') {
    for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
      if (typeof value === 'string') parsed[key] = value
    }
  }
  return { tags: parsed, duplicateKeys: [...duplicates] }
}

// ---------------------------------------------------------------------------
// Provisioning plane — ROOT key only (403 on the data plane, verified).
// ---------------------------------------------------------------------------

export interface OpenVikingAccount {
  accountId: string
  createdAt: string | null
  status: string | null
  userCount: number | null
}

/** `POST /api/v1/admin/accounts` — creates the account AND its first admin user. */
export async function openVikingCreateAccount(
  config: OpenVikingConfig,
  input: { accountId: string; adminUserId: string },
): Promise<{ accountId: string; adminUserId: string; userKey: string }> {
  const result = await openVikingRequest<Record<string, unknown>>(config, {
    method: 'POST',
    path: '/api/v1/admin/accounts',
    json: { account_id: input.accountId, admin_user_id: input.adminUserId },
    apiKey: config.rootApiKey,
    timeoutMs: timeouts.provisionMs,
  })
  const userKey = result?.user_key ?? result?.apiKey
  if (typeof input.accountId !== 'string' || typeof userKey !== 'string' || userKey.length === 0) {
    throw new OpenVikingError(
      'openviking_invalid_response',
      'OpenViking account creation returned no usable user key',
    )
  }
  const adminUserId = typeof result?.admin_user_id === 'string' ? result.admin_user_id : input.adminUserId
  return { accountId: input.accountId, adminUserId, userKey }
}

/** `GET /api/v1/admin/accounts` — the account list (verified list shape). */
export async function openVikingListAccounts(config: OpenVikingConfig): Promise<OpenVikingAccount[]> {
  const result = await openVikingRequest<unknown>(config, {
    method: 'GET',
    path: '/api/v1/admin/accounts',
    apiKey: config.rootApiKey,
    timeoutMs: timeouts.provisionMs,
  })
  if (!Array.isArray(result)) {
    throw new OpenVikingError('openviking_invalid_response', 'OpenViking account list returned no array')
  }
  const accounts: OpenVikingAccount[] = []
  for (const entry of result) {
    const candidate = entry as { account_id?: unknown; created_at?: unknown; status?: unknown; user_count?: unknown }
    if (typeof candidate?.account_id !== 'string' || candidate.account_id.length === 0) continue
    accounts.push({
      accountId: candidate.account_id,
      createdAt: typeof candidate.created_at === 'string' ? candidate.created_at : null,
      status: typeof candidate.status === 'string' ? candidate.status : null,
      userCount: typeof candidate.user_count === 'number' ? candidate.user_count : null,
    })
  }
  return accounts
}

export interface OpenVikingUser {
  userId: string
  username: string | null
  role: string | null
  /** The user key, present only when `include_credentials=true` was honored. */
  userKey: string | null
}

/**
 * `GET /api/v1/admin/accounts/{id}/users?include_credentials=true` — the
 * credential-recovery read. Reading keys has NO side effects: unlike
 * `POST .../users/{id}/key` (which re-signs and invalidates the old key), a
 * read is safe to race from several devices (brief D2).
 */
export async function openVikingListUsers(
  config: OpenVikingConfig,
  accountId: string,
): Promise<OpenVikingUser[]> {
  const result = await openVikingRequest<unknown>(config, {
    method: 'GET',
    path: `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/users`,
    query: new URLSearchParams({ include_credentials: 'true' }),
    apiKey: config.rootApiKey,
    timeoutMs: timeouts.provisionMs,
  })
  // The list may arrive bare or wrapped in `{users: [...]}` — accept both.
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { users?: unknown } | null)?.users)
      ? (result as { users: unknown[] }).users
      : []
  const users: OpenVikingUser[] = []
  for (const row of rows) {
    const candidate = row as {
      user_id?: unknown
      id?: unknown
      username?: unknown
      role?: unknown
      user_key?: unknown
      apiKey?: unknown
    }
    const userId = candidate?.user_id ?? candidate?.id
    if (typeof userId !== 'string' || userId.length === 0) continue
    const userKey = candidate?.user_key ?? candidate?.apiKey
    users.push({
      userId,
      username: typeof candidate?.username === 'string' ? candidate.username : null,
      role: typeof candidate?.role === 'string' ? candidate.role : null,
      userKey: typeof userKey === 'string' && userKey.length > 0 ? userKey : null,
    })
  }
  return users
}

// ---------------------------------------------------------------------------
// Data plane — the tenant's user key (the root key is refused here).
// ---------------------------------------------------------------------------

/** The credential context every data-plane call is bound to. */
export interface OpenVikingTenantAuth {
  accountId: string
  /** The account's service-user key (the data-plane bearer). */
  userKey: string
}

function tenantKey(auth: OpenVikingTenantAuth): string {
  return auth.userKey
}

/** `POST /api/v1/fs/mkdir` — creates ONE directory level (no recursion). */
export async function openVikingMkdir(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
  input: { uri: string; description?: string },
): Promise<void> {
  await openVikingRequest<unknown>(config, {
    method: 'POST',
    path: '/api/v1/fs/mkdir',
    json: { uri: input.uri, ...(input.description !== undefined ? { description: input.description } : {}) },
    apiKey: tenantKey(auth),
    timeoutMs: timeouts.writeMs,
  })
}

/**
 * `POST /api/v1/system/wait` — blocks until the account's ingestion pipelines
 * drain ("Wait for all processing to complete", the instance's openapi.json).
 * Measured on the real v0.5.1.1 (2026-10-21, data-plane user key accepted,
 * body `{}`): it answers `{status:'ok', result:{<pipeline>:{processed,
 * requeue_count, error_count, errors[]}}, ...}` and returns only once the
 * directory processing spawned by a mkdir/account creation has finished —
 * which is exactly when a directory stops dropping `set_tags` (brief §1.10).
 * The counts are diagnostics; the caller only needs the completion.
 *
 * `budgetMs` caps THIS call below the configured `waitMs` ceiling — the
 * verified directory-tag loop passes what remains of its window so a slow
 * pipeline cannot silently eat the write+read-back's turn (review round M1).
 */
export async function openVikingWaitForProcessing(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
  budgetMs: number = timeouts.waitMs,
): Promise<void> {
  await openVikingRequest<unknown>(config, {
    method: 'POST',
    path: '/api/v1/system/wait',
    json: {},
    apiKey: tenantKey(auth),
    timeoutMs: Math.min(budgetMs, timeouts.waitMs),
  })
}

/** `POST /api/v1/fs/mv` — the target's parent must exist; an existing target is OVERWRITTEN. */
export async function openVikingMv(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
  input: { fromUri: string; toUri: string },
): Promise<void> {
  await openVikingRequest<unknown>(config, {
    method: 'POST',
    path: '/api/v1/fs/mv',
    json: { from_uri: input.fromUri, to_uri: input.toUri },
    apiKey: tenantKey(auth),
    timeoutMs: timeouts.writeMs,
  })
}

/** `DELETE /api/v1/fs?uri=` — a hard remove; the KB only ever recycles, never deletes. */
export async function openVikingRemove(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
  input: { uri: string; recursive?: boolean },
): Promise<void> {
  await openVikingRequest<unknown>(config, {
    method: 'DELETE',
    path: '/api/v1/fs',
    query: new URLSearchParams({ uri: input.uri, recursive: String(input.recursive ?? false) }),
    apiKey: tenantKey(auth),
    timeoutMs: timeouts.writeMs,
  })
}

/**
 * `POST /api/v1/content/write` — the document upload. `tag_mode: 'replace'`
 * makes the call idempotent: the same URI + content + tags can be retried
 * after a timeout without duplicating or corrupting state (brief D4).
 */
export async function openVikingWriteContent(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
  input: { uri: string; content: string; tags?: string[]; processingMode?: OpenVikingProcessingMode },
): Promise<void> {
  await openVikingRequest<unknown>(config, {
    method: 'POST',
    path: '/api/v1/content/write',
    json: {
      uri: input.uri,
      content: input.content,
      tag_mode: 'replace',
      ...(input.tags ? { tags: input.tags } : {}),
      processing_mode: input.processingMode ?? config.processingMode,
    },
    apiKey: tenantKey(auth),
    timeoutMs: timeouts.writeMs,
  })
}

/**
 * `GET /api/v1/content/read` — the document body (L2). Missing content reads
 * as `null` so callers can distinguish "empty document" from "no document".
 */
export async function openVikingReadContent(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
  uri: string,
): Promise<string | null> {
  const result = await openVikingRequest<unknown>(config, {
    method: 'GET',
    path: '/api/v1/content/read',
    query: new URLSearchParams({ uri }),
    apiKey: tenantKey(auth),
    timeoutMs: timeouts.readMs,
  })
  const content = (result as { content?: unknown } | null)?.content
  if (typeof content === 'string') return content
  if (content === null || content === undefined) {
    // Some shapes put the text directly in `result`.
    return typeof result === 'string' ? result : null
  }
  return null
}

/** One node as `fs/ls` / `fs/attrs` report it: uri, tags and the mtime. */
export interface OpenVikingNode {
  uri: string
  tags: Record<string, string>
  /** Keys that arrived MORE THAN once (strict parsers reject such nodes). */
  duplicateTagKeys: string[]
  mtime: string | null
  /** Directory flag when the listing carries it (files may omit it). */
  isDirectory: boolean | null
}

function normalizeNode(raw: {
  uri?: unknown
  path?: unknown
  tags?: unknown
  mtime?: unknown
  modified_at?: unknown
  type?: unknown
  is_dir?: unknown
}): OpenVikingNode | null {
  const uri = raw.uri ?? raw.path
  if (typeof uri !== 'string' || uri.length === 0) return null
  const type = raw.type
  const isDirectory = typeof raw.is_dir === 'boolean'
    ? raw.is_dir
    : type === 'dir' || type === 'directory'
      ? true
      : type === 'file'
        ? false
        : null
  const mtime = typeof raw.mtime === 'string'
    ? raw.mtime
    : typeof raw.modified_at === 'string'
      ? raw.modified_at
      : null
  const { tags, duplicateKeys } = splitOpenVikingTags(raw.tags)
  return { uri, tags, duplicateTagKeys: duplicateKeys, mtime, isDirectory }
}

/**
 * `GET /api/v1/fs/attrs?uri=` — ONE node's metadata, normalized. The measured
 * v0.5.1.1 shape is `{uri, context_type, attrs: {tags}}`: the node IDENTITY
 * rides at the top level while only the tags (and sometimes mtime/type) sit
 * inside `attrs` — a parser that reads `attrs` as the node itself finds no
 * `uri` there and reports "no node", which silently turned every read-back
 * into a miss on the real instance (measured 2026-10-21, the E1 hardening
 * round). The fake's `{attrs: {uri, tags, …}}` and a flat top-level node both
 * parse too: the levels are MERGED before normalizing.
 */
export async function openVikingAttrs(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
  uri: string,
): Promise<OpenVikingNode | null> {
  const result = await openVikingRequest<unknown>(config, {
    method: 'GET',
    path: '/api/v1/fs/attrs',
    query: new URLSearchParams({ uri }),
    apiKey: tenantKey(auth),
    timeoutMs: timeouts.readMs,
  })
  const record = (result ?? {}) as Record<string, unknown>
  const attrs = record.attrs
  const source = (attrs && typeof attrs === 'object'
    ? { ...record, ...(attrs as Record<string, unknown>) }
    : record) as {
    uri?: unknown
    path?: unknown
    tags?: unknown
    mtime?: unknown
    modified_at?: unknown
    type?: unknown
    is_dir?: unknown
  }
  return normalizeNode(source)
}

/**
 * `POST /api/v1/fs/attrs/set_tags` — REPLACES the node's retrieval tags by
 * default (`mode: 'replace'`). This is the KB's state-mutation primitive:
 * document status travels in tags, and every write sends the FULL tag set so
 * a retry can never half-apply a transition (brief D4).
 */
export async function openVikingSetTags(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
  input: { uri: string; tags: string[]; mode?: 'replace' | 'append' | 'clear' },
): Promise<void> {
  await openVikingRequest<unknown>(config, {
    method: 'POST',
    path: '/api/v1/fs/attrs/set_tags',
    json: { uri: input.uri, tags: input.tags, mode: input.mode ?? 'replace' },
    apiKey: tenantKey(auth),
    timeoutMs: timeouts.writeMs,
  })
}

/** One `fs/ls` page: the nodes on this page and whether more follow. */
export interface OpenVikingListPage {
  entries: OpenVikingNode[]
  hasMore: boolean
}

/**
 * `GET /api/v1/fs/ls?uri&include_tags=true&recursive=true&node_limit&offset`
 * — the recursive one-shot tree walk the collection listing and the status
 * counts are built from. Dot-directories ARE listed; dotfiles inside them are
 * hidden by the server unless `show_all_hidden` — the recycle-bin semantics
 * the KB relies on (brief §1.7).
 */
export async function openVikingLs(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
  input: {
    uri: string
    recursive?: boolean
    nodeLimit?: number
    offset?: number
    /** Server-side `k=v` tag filter (all tags must match). */
    tags?: string[]
  },
): Promise<OpenVikingListPage> {
  const query = new URLSearchParams({ uri: input.uri, include_tags: 'true' })
  if (input.recursive) query.set('recursive', 'true')
  if (input.nodeLimit !== undefined) query.set('node_limit', String(input.nodeLimit))
  if (input.offset !== undefined) query.set('offset', String(input.offset))
  for (const tag of input.tags ?? []) query.append('tags', tag)
  const result = await openVikingRequest<unknown>(config, {
    method: 'GET',
    path: '/api/v1/fs/ls',
    query,
    apiKey: tenantKey(auth),
    timeoutMs: timeouts.readMs,
  })
  const record = (result ?? {}) as {
    entries?: unknown
    nodes?: unknown
    children?: unknown
    has_more?: unknown
  }
  const rows = Array.isArray(record.entries)
    ? record.entries
    : Array.isArray(record.nodes)
      ? record.nodes
      : Array.isArray(record.children)
        ? record.children
        : Array.isArray(result)
          ? (result as unknown[])
          : []
  const entries: OpenVikingNode[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const node = normalizeNode(row as Parameters<typeof normalizeNode>[0])
    if (node) entries.push(node)
  }
  return { entries, hasMore: record.has_more === true }
}

/** One search hit from `search/find`: uri, score, tags and (opt-in) content. */
export interface OpenVikingFindResource {
  uri: string
  score: number
  tags: Record<string, string>
  /** Keys that arrived MORE THAN once (strict parsers reject such hits). */
  duplicateTagKeys: string[]
  /** Inlined body — present when `read_content: true` was requested. */
  content: string | null
}

/**
 * `POST /api/v1/search/find` — the ONLY retrieval entry point. `target_uri`
 * accepts an ARRAY (server-side collection scoping, brief D5), `tags` is the
 * server-side status filter and `read_content: true` inlines the hit bodies
 * so the send-time snippet budget is one call, not one per hit (brief D5).
 */
export async function openVikingFind(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
  input: {
    query: string
    targetUri: string | string[]
    tags?: string[]
    limit: number
    readContent?: boolean
  },
): Promise<OpenVikingFindResource[]> {
  const result = await openVikingRequest<Record<string, unknown>>(config, {
    method: 'POST',
    path: '/api/v1/search/find',
    json: {
      query: input.query,
      target_uri: input.targetUri,
      ...(input.tags ? { tags: input.tags } : {}),
      limit: input.limit,
      ...(input.readContent !== undefined ? { read_content: input.readContent } : {}),
    },
    apiKey: tenantKey(auth),
    timeoutMs: timeouts.findMs,
  })
  if (!Array.isArray(result?.resources)) {
    throw new OpenVikingError('openviking_invalid_response', 'OpenViking find returned no resources array')
  }
  const resources: OpenVikingFindResource[] = []
  for (const entry of result.resources) {
    const candidate = entry as { uri?: unknown; score?: unknown; tags?: unknown; content?: unknown }
    if (typeof candidate?.uri !== 'string' || candidate.uri.length === 0) continue
    const score = typeof candidate.score === 'number' ? candidate.score : Number(candidate.score)
    if (!Number.isFinite(score)) continue
    const { tags, duplicateKeys } = splitOpenVikingTags(candidate.tags)
    resources.push({
      uri: candidate.uri,
      score,
      tags,
      duplicateTagKeys: duplicateKeys,
      content: typeof candidate.content === 'string' ? candidate.content : null,
    })
  }
  return resources
}

/**
 * `POST /api/v1/search/glob` — by-name resolution (`docId → URI` in one call,
 * brief D4). The scope field is `uri` per the instance's openapi.json (the
 * brief's `target_uri` naming does not exist on this endpoint).
 */
export async function openVikingGlob(
  config: OpenVikingConfig,
  auth: OpenVikingTenantAuth,
  input: { pattern: string; uri: string; nodeLimit?: number },
): Promise<string[]> {
  const result = await openVikingRequest<unknown>(config, {
    method: 'POST',
    path: '/api/v1/search/glob',
    json: {
      pattern: input.pattern,
      uri: input.uri,
      ...(input.nodeLimit !== undefined ? { node_limit: input.nodeLimit } : {}),
    },
    apiKey: tenantKey(auth),
    timeoutMs: timeouts.readMs,
  })
  const record = (result ?? {}) as { matches?: unknown; paths?: unknown }
  const rows = Array.isArray(record.matches)
    ? record.matches
    : Array.isArray(record.paths)
      ? record.paths
      : []
  const matches: string[] = []
  for (const row of rows) {
    if (typeof row === 'string' && row.length > 0) matches.push(row)
    else if (row && typeof row === 'object') {
      const uri = (row as { uri?: unknown }).uri
      if (typeof uri === 'string' && uri.length > 0) matches.push(uri)
    }
  }
  return matches
}
