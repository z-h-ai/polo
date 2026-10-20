/**
 * Minimal OpenViking Context HTTP client (POO-108 v2).
 *
 * Covers exactly the four endpoints the integration needs, with the
 * request/response shapes verified against a real local OpenViking instance
 * (v0.5.1.1, `auth_mode=dev`) — see `.pipeline/sdlc/POO-108/dev-brief-v2-openviking.md`:
 *
 * 1. `POST /api/v1/resources/temp_upload` (multipart field `file`) → `result.temp_file_id`
 * 2. `POST /api/v1/resources` (`temp_file_id`, `to`, `create_parent`, `wait`,
 *    `processing_mode`, `tags` as `k=v` STRINGS, `reason`) → `result.root_uri`
 * 3. `POST /api/v1/search/find` (`query`, `target_uri`, `context_type`, `limit`)
 *    → `result.resources[]` with `uri` / `score` / `tags` / `abstract`
 * 4. `DELETE /api/v1/fs?uri=<uri>&recursive=<bool>`
 *
 * The client is deliberately dumb: plain `fetch`, bounded timeouts (uploads and
 * syncs 120s, search 8s) and structured `OpenVikingError` failures. Every
 * failure mode degrades upstream — a missing or broken OpenViking must never
 * fail a local knowledge-base management operation.
 */

export const OPENVIKING_SYNC_TIMEOUT_MS = 120_000
export const OPENVIKING_SEARCH_TIMEOUT_MS = 8_000

export type OpenVikingErrorCode =
  | 'openviking_timeout'
  | 'openviking_network_error'
  | 'openviking_http_error'
  | 'openviking_invalid_response'

/** Thrown for every OpenViking failure; `code` is stable, `status` is the HTTP status when one was received. */
export class OpenVikingError extends Error {
  constructor(
    readonly code: OpenVikingErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'OpenVikingError'
  }
}

export interface OpenVikingConfig {
  /** Base URL without a trailing slash, e.g. `http://127.0.0.1:1933`. */
  baseUrl: string
  /** Optional bearer token (`POLO_OPENVIKING_API_KEY`); the dev instance needs none. */
  apiKey?: string
}

/**
 * OpenViking is opt-in through the environment and read at CALL time (never
 * module load), so a server started without it stays exactly as before and a
 * test can flip the flag per case. Unset `POLO_OPENVIKING_URL` disables every
 * OpenViking behavior.
 */
export function readOpenVikingConfig(env: Record<string, string | undefined> = process.env): OpenVikingConfig | null {
  const baseUrl = env.POLO_OPENVIKING_URL?.trim()
  if (!baseUrl) return null
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: env.POLO_OPENVIKING_API_KEY?.trim() || undefined,
  }
}

export function isOpenVikingConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return readOpenVikingConfig(env) !== null
}

interface OpenVikingTimeouts {
  /** temp_upload / add_resource / fs DELETE — the publish-sync path. */
  syncMs: number
  /** search/find. */
  searchMs: number
}

let timeouts: OpenVikingTimeouts = {
  syncMs: OPENVIKING_SYNC_TIMEOUT_MS,
  searchMs: OPENVIKING_SEARCH_TIMEOUT_MS,
}

/** Test seam: shrink the wall clocks so a timeout can be observed quickly. */
export function setOpenVikingTimeoutsForTests(overrides: Partial<OpenVikingTimeouts>): void {
  timeouts = { ...timeouts, ...overrides }
}

export function resetOpenVikingTimeoutsForTests(): void {
  timeouts = { syncMs: OPENVIKING_SYNC_TIMEOUT_MS, searchMs: OPENVIKING_SEARCH_TIMEOUT_MS }
}

/** `{"status":"ok","result":…}` — anything else is a protocol failure. */
interface OpenVikingEnvelope<T> {
  status?: unknown
  result?: T
  message?: unknown
  error?: unknown
}

export interface OpenVikingTempFile {
  tempFileId: string
}

export interface OpenVikingTempUploadInput {
  /** Object name reported to OpenViking, e.g. `.space.md` or `kb-<id>.md`. */
  filename: string
  content: string
  contentType?: string
}

export interface OpenVikingAddResourceInput {
  tempFileId: string
  /** Destination URI, e.g. `viking://resources/entspace-<hash>/.space.md`. */
  to: string
  /** `true` creates every missing parent directory — this IS the space/collection creation. */
  createParent?: boolean
  /** Block until the resource is processed. */
  wait?: boolean
  processingMode?: 'vectors_only' | 'full'
  /** MUST be `["k=v"]` strings, not objects (verified against the real instance). */
  tags?: string[]
  reason?: string
}

export interface OpenVikingAddResourceResult {
  rootUri: string | null
  status: string | null
}

export interface OpenVikingSearchResource {
  uri: string
  score: number
  tags: Record<string, string>
  abstract: string | null
}

export interface OpenVikingFindInput {
  query: string
  /** Scope the search to a space (or any subtree), e.g. the space root. */
  targetUri: string
  limit: number
  /** Defaults to `['resource']`, the verified shape. */
  contextTypes?: string[]
}

interface RequestOptions {
  method: 'POST' | 'DELETE'
  path: string
  json?: unknown
  form?: FormData
  timeoutMs: number
}

function describePayloadError(payload: OpenVikingEnvelope<unknown>): string {
  const detail = payload.error ?? payload.message
  if (typeof detail === 'string' && detail.trim()) return detail.trim()
  if (detail && typeof detail === 'object') {
    const message = (detail as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return JSON.stringify(payload).slice(0, 200)
}

function describeBodySnippet(body: string): string {
  const snippet = body.trim().replace(/\s+/g, ' ')
  return snippet ? `: ${snippet.slice(0, 200)}` : ''
}

async function openVikingRequest<T>(config: OpenVikingConfig, options: RequestOptions): Promise<T> {
  const controller = new AbortController()
  // The timer stays armed until the body has been read: a stalled response
  // body must hit the same timeout as a stalled handshake.
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
  if (options.json !== undefined) headers['content-type'] = 'application/json'
  let body: string | FormData | undefined
  if (options.form) {
    body = options.form
  } else if (options.json !== undefined) {
    body = JSON.stringify(options.json)
  }

  let text: string
  try {
    const response = await fetch(`${config.baseUrl}${options.path}`, {
      method: options.method,
      headers,
      body,
      signal: controller.signal,
    })
    if (!response.ok) {
      const snippet = describeBodySnippet(await response.text().catch(() => ''))
      throw new OpenVikingError(
        'openviking_http_error',
        `OpenViking ${options.method} ${options.path} failed with HTTP ${response.status}${snippet}`,
        response.status,
      )
    }
    text = await response.text()
  } catch (error) {
    if (error instanceof OpenVikingError) throw error
    if (controller.signal.aborted) {
      throw new OpenVikingError(
        'openviking_timeout',
        `OpenViking ${options.method} ${options.path} timed out after ${options.timeoutMs}ms`,
      )
    }
    throw new OpenVikingError(
      'openviking_network_error',
      `OpenViking ${options.method} ${options.path} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }

  let payload: OpenVikingEnvelope<T>
  try {
    payload = JSON.parse(text) as OpenVikingEnvelope<T>
  } catch {
    throw new OpenVikingError(
      'openviking_invalid_response',
      `OpenViking ${options.method} ${options.path} returned non-JSON body: ${describeBodySnippet(text)}`,
    )
  }
  if (!payload || payload.status !== 'ok') {
    throw new OpenVikingError(
      'openviking_invalid_response',
      `OpenViking ${options.method} ${options.path} returned status=${String(payload?.status ?? 'none')}: ${describePayloadError(payload ?? {})}`,
    )
  }
  return payload.result as T
}

/** `POST /api/v1/resources/temp_upload` — the local instance refuses host paths, so content always enters through here. */
export async function openVikingTempUpload(
  config: OpenVikingConfig,
  input: OpenVikingTempUploadInput,
): Promise<OpenVikingTempFile> {
  const form = new FormData()
  form.append('file', new Blob([input.content], { type: input.contentType ?? 'text/markdown' }), input.filename)
  const result = await openVikingRequest<{ temp_file_id?: unknown }>(config, {
    method: 'POST',
    path: '/api/v1/resources/temp_upload',
    form,
    timeoutMs: timeouts.syncMs,
  })
  if (typeof result?.temp_file_id !== 'string' || result.temp_file_id.length === 0) {
    throw new OpenVikingError('openviking_invalid_response', 'OpenViking temp_upload returned no temp_file_id')
  }
  return { tempFileId: result.temp_file_id }
}

export async function openVikingAddResource(
  config: OpenVikingConfig,
  input: OpenVikingAddResourceInput,
): Promise<OpenVikingAddResourceResult> {
  const result = await openVikingRequest<{ root_uri?: unknown; status?: unknown }>(config, {
    method: 'POST',
    path: '/api/v1/resources',
    json: {
      temp_file_id: input.tempFileId,
      to: input.to,
      ...(input.createParent !== undefined ? { create_parent: input.createParent } : {}),
      ...(input.wait !== undefined ? { wait: input.wait } : {}),
      ...(input.processingMode !== undefined ? { processing_mode: input.processingMode } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
    timeoutMs: timeouts.syncMs,
  })
  return {
    rootUri: typeof result?.root_uri === 'string' ? result.root_uri : null,
    status: typeof result?.status === 'string' ? result.status : null,
  }
}

/** Normalizes both tag shapes OpenViking may return: `["k=v"]` strings or a plain object. */
function normalizeTags(tags: unknown): Record<string, string> {
  if (Array.isArray(tags)) {
    const parsed: Record<string, string> = {}
    for (const entry of tags) {
      if (typeof entry !== 'string') continue
      const separator = entry.indexOf('=')
      if (separator <= 0) continue
      parsed[entry.slice(0, separator)] = entry.slice(separator + 1)
    }
    return parsed
  }
  if (tags && typeof tags === 'object') {
    const parsed: Record<string, string> = {}
    for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
      if (typeof value === 'string') parsed[key] = value
    }
    return parsed
  }
  return {}
}

export async function openVikingFind(config: OpenVikingConfig, input: OpenVikingFindInput): Promise<OpenVikingSearchResource[]> {
  const result = await openVikingRequest<{ resources?: unknown }>(config, {
    method: 'POST',
    path: '/api/v1/search/find',
    json: {
      query: input.query,
      target_uri: input.targetUri,
      context_type: input.contextTypes ?? ['resource'],
      limit: input.limit,
    },
    timeoutMs: timeouts.searchMs,
  })
  if (!Array.isArray(result?.resources)) {
    throw new OpenVikingError('openviking_invalid_response', 'OpenViking find returned no resources array')
  }
  const resources: OpenVikingSearchResource[] = []
  for (const entry of result.resources) {
    const candidate = entry as { uri?: unknown; score?: unknown; tags?: unknown; abstract?: unknown }
    if (typeof candidate?.uri !== 'string' || candidate.uri.length === 0) continue
    const score = typeof candidate.score === 'number' ? candidate.score : Number(candidate.score)
    if (!Number.isFinite(score)) continue
    resources.push({
      uri: candidate.uri,
      score,
      tags: normalizeTags(candidate.tags),
      abstract: typeof candidate.abstract === 'string' ? candidate.abstract : null,
    })
  }
  return resources
}

export async function openVikingDelete(
  config: OpenVikingConfig,
  input: { uri: string; recursive?: boolean },
): Promise<void> {
  const query = new URLSearchParams({ uri: input.uri, recursive: String(input.recursive ?? false) })
  await openVikingRequest<unknown>(config, {
    method: 'DELETE',
    path: `/api/v1/fs?${query.toString()}`,
    timeoutMs: timeouts.syncMs,
  })
}
