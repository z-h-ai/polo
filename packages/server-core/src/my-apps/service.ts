import { lstatSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { AdminClient, AdminError } from '@polo-ai/shared/admin'
import { getAdminUrl, getWebAppArtifactPolicyState } from '@polo-ai/shared/config'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import {
  collectGenUiAppPublishFiles,
  buildGenUiAppArtifactZip,
  evaluateGenUiAppPublishPolicy,
} from '@polo-ai/shared/genui'
import type {
  DeleteMyAppResponse,
  ListMyAppsResponse,
  MyAppMutationResponse,
  PublishMyAppResponse,
  WithdrawMyAppResponse,
} from '@polo-ai/shared/admin/project-contract'
import {
  isRuntimeFenceBoundToAccount,
  getRuntimeActiveProductSpace,
} from '../runtime/product-space-executions'
import {
  captureCompleteTrustedSessionScopeToken,
  resolveTrustedProductSpaceAccountId,
  isTrustedSessionScopeTokenCurrent,
} from '../handlers/rpc/trusted-product-space-account'

/**
 * Member apps ("我的应用", POO-205 Q7/Q11) — the server-side bridge between
 * the committed space's trusted session and the admin my-apps surface
 * (poo205-contract-r1).
 *
 * Scope discipline: every call re-proves the committed fence and requires the
 * requested space to BE the committed space — the renderer can never address
 * a space it is not inside. Both space kinds are allowed (Q7: each space has
 * its own my-apps area); publishing is admin-rejected outside enterprise
 * spaces and the client hides the entry anyway.
 *
 * Byte discipline (mirrors pc_upload): the bundle payload never transits the
 * renderer. The trusted side reads `sourcePath` (a static app directory or a
 * single .html file), validates the publish policy, zips, and uploads — the
 * renderer only ever supplies a local path and display metadata.
 */

const MYAPPS_REQUEST_TIMEOUT_MS = 60_000
const MYAPPS_PAYLOAD_MAX_BYTES = 20 * 1024 * 1024
/** POO-205 C12 (裁决 7): the genui publish leg stages the bundle zip under a
 * mkdtemp'd directory with this prefix inside os.tmpdir(); the create flow
 * removes ONLY such directories, and only when the given path resolves
 * inside the OS temp root — a caller-supplied workspace path is never touched. */
const MYAPPS_TEMP_DIR_PREFIX = 'polo-myapps-'

/**
 * The committed-fence refusal with its transport-surviving code attached:
 * the wire keeps `myapps_scope_changed` (MyAppsLocalErrorCode, registered in
 * KNOWN_ERROR_CODES) only when the Error CARRIES the code — a bare message
 * degrades to HANDLER_ERROR and the renderer's recovery copy goes generic.
 */
function myAppsScopeChangedError(): Error {
  const error = new Error('myapps_scope_changed')
  ;(error as unknown as { code?: string }).code = 'myapps_scope_changed'
  return error
}

/**
 * Best-effort cleanup of the Main-owned staging bundle. Fails closed on the
 * guard (only a path INSIDE os.tmpdir() whose first segment carries the
 * `polo-myapps-` prefix qualifies), logs before deleting so a misfire is
 * reconstructable, and never lets a cleanup failure mask the command's own
 * result.
 */
export function cleanupMyAppsTempPath(sourcePath: string, log: (message: string) => void = console.error): void {
  try {
    const resolved = resolve(sourcePath)
    const tempRoot = resolve(tmpdir())
    if (!isAbsolute(resolved) || resolved === tempRoot || !resolved.startsWith(tempRoot + sep)) {
      return
    }
    // The staged bundle lives as <tmpdir>/polo-myapps-*/bundle.zip; remove the
    // whole staging directory (never the temp root itself, never anything
    // outside the prefix).
    const firstSegment = relative(tempRoot, resolved).split(sep)[0] ?? ''
    if (!firstSegment.startsWith(MYAPPS_TEMP_DIR_PREFIX)) {
      return
    }
    const stagingDir = join(tempRoot, firstSegment)
    if (stagingDir === tempRoot || stagingDir.length <= tempRoot.length) return
    log(`[my-apps] cleaning up staged bundle: ${stagingDir}`)
    rmSync(stagingDir, { recursive: true, force: true })
  } catch (error) {
    log(`[my-apps] staged-bundle cleanup failed for ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export class MyAppsAdminUnavailableError extends Error {
  readonly code: 'myapps_admin_unreachable' | 'myapps_signin_required'
  constructor(code: 'myapps_admin_unreachable' | 'myapps_signin_required', message: string) {
    super(message)
    this.name = 'MyAppsAdminUnavailableError'
    this.code = code
  }
}

/** The admin error's stable myapps_x / prj_x wire code, when one rode the response. */
export function myAppsErrorCodeOf(error: unknown): string | null {
  if (error instanceof AdminError) {
    const code = (error as unknown as { errorCode?: unknown }).errorCode
    if (typeof code === 'string' && (code.startsWith('myapps_') || code.startsWith('prj_'))) return code
  }
  return null
}

async function withAdmin<T>(run: (client: AdminClient, accessToken: string) => Promise<T>): Promise<T> {
  const adminUrl = getAdminUrl()
  if (!adminUrl) {
    throw new MyAppsAdminUnavailableError('myapps_admin_unreachable', 'No admin server is configured')
  }
  let accessToken: string | null = null
  try {
    const tokens = await getCredentialManager().getAdminTokens()
    accessToken = tokens?.accessToken ?? null
  } catch {
    accessToken = null
  }
  if (!accessToken) {
    throw new MyAppsAdminUnavailableError('myapps_signin_required', 'No signed-in admin session is available')
  }
  return run(new AdminClient(adminUrl, { requestTimeoutMs: MYAPPS_REQUEST_TIMEOUT_MS }), accessToken)
}

/**
 * The committed-space gate shared by every entry. Returns the proven
 * productSpaceId; a mismatching requested space is a hard failure (the
 * renderer cannot talk about a space it is not inside).
 */
async function requireCommittedSpaceScope(input: {
  workspaceId: string
  productSpaceId: string
}): Promise<void> {
  const token = captureCompleteTrustedSessionScopeToken(input.workspaceId)
  if (!token) throw new MyAppsAdminUnavailableError('myapps_signin_required', 'No trusted caller scope is available')
  const trustedAccountId = await resolveTrustedProductSpaceAccountId()
  if (!isTrustedSessionScopeTokenCurrent(token)) {
    throw myAppsScopeChangedError()
  }
  if (!trustedAccountId || !isRuntimeFenceBoundToAccount(trustedAccountId)) {
    throw new MyAppsAdminUnavailableError('myapps_signin_required', 'No committed space is active for this account')
  }
  const activeProductSpaceId = getRuntimeActiveProductSpace()
  if (!activeProductSpaceId || activeProductSpaceId !== input.productSpaceId) {
    throw myAppsScopeChangedError()
  }
}

interface PackagedAppPayload {
  payloadBase64: string
  checksumSha256: string
  sizeBytes: number
}

/** Reads + validates + zips a static app bundle from a local path. */
function packageStaticAppFromPath(sourcePath: string): PackagedAppPayload {
  const info = lstatSync(sourcePath)
  let zipBytes: Uint8Array
  if (info.isDirectory()) {
    const collection = collectGenUiAppPublishFiles(sourcePath)
    if (!collection.ok) {
      throw new Error(`MYAPPS_PAYLOAD_INVALID: ${collection.error}`)
    }
    const policy = evaluateGenUiAppPublishPolicy(collection.files, getWebAppArtifactPolicyState())
    if (!policy.ok) {
      throw new Error(`MYAPPS_PAYLOAD_INVALID: ${policy.error}`)
    }
    zipBytes = buildGenUiAppArtifactZip(collection.files)
  } else if (info.isFile() && sourcePath.toLowerCase().endsWith('.zip')) {
    // A Main-packaged bundle (genui publish leg already validated layout +
    // policy before writing this temp zip); admin re-validates server-side.
    zipBytes = new Uint8Array(readFileSync(sourcePath))
  } else if (info.isFile() && sourcePath.toLowerCase().endsWith('.html')) {
    // A single HTML file is wrapped as the canonical index.html entry.
    const files = [{ path: 'index.html', bytes: new Uint8Array(readFileSync(sourcePath)) }]
    const policy = evaluateGenUiAppPublishPolicy(files, getWebAppArtifactPolicyState())
    if (!policy.ok) {
      throw new Error(`MYAPPS_PAYLOAD_INVALID: ${policy.error}`)
    }
    zipBytes = buildGenUiAppArtifactZip(files)
  } else {
    throw new Error('MYAPPS_PAYLOAD_INVALID: a static app directory, an .html file or a packaged .zip is required')
  }
  if (zipBytes.byteLength > MYAPPS_PAYLOAD_MAX_BYTES) {
    throw new Error('MYAPPS_PAYLOAD_TOO_LARGE')
  }
  const checksumSha256 = createHash('sha256').update(zipBytes).digest('hex')
  return {
    payloadBase64: Buffer.from(zipBytes).toString('base64'),
    checksumSha256,
    sizeBytes: zipBytes.byteLength,
  }
}

export async function myAppsList(input: {
  workspaceId: string
  productSpaceId: string
}): Promise<ListMyAppsResponse> {
  await requireCommittedSpaceScope(input)
  try {
    return await withAdmin((client, token) => client.listMyApps(token, input.productSpaceId))
  } catch (error) {
    if (error instanceof MyAppsAdminUnavailableError) throw error
    throw mapMyAppsFailure(error)
  }
}

export async function myAppsCreateFromFile(input: {
  workspaceId: string
  productSpaceId: string
  sourcePath: string
  name: string
  description?: string
  /** POO-205 A3b save idempotency: the stable canvas identity from the
   * renderer; the SAME key saves a new version (admin answers 200) instead
   * of duplicating the row. */
  sourceKey?: string
}): Promise<MyAppMutationResponse & { status: number }> {
  await requireCommittedSpaceScope(input)
  try {
    const payload = packageStaticAppFromPath(input.sourcePath)
    const outcome = await withAdmin((client, token) => client.createMyApp(token, input.productSpaceId, {
      name: input.name,
      ...(input.description !== undefined && input.description !== '' ? { description: input.description } : {}),
      ...(input.sourceKey !== undefined && input.sourceKey !== '' ? { sourceKey: input.sourceKey } : {}),
      payloadBase64: payload.payloadBase64,
      checksumSha256: payload.checksumSha256,
    }))
    // Flattened for the RPC answer: the mutation body plus the raw status
    // (201 = new row, 200 = new version) so the renderer can word the save
    // toast without a second round-trip.
    return { ...outcome.response, status: outcome.status }
  } catch (error) {
    if (error instanceof MyAppsAdminUnavailableError) throw error
    throw mapMyAppsFailure(error)
  } finally {
    // 裁决 7: the staged bundle (a Main-owned mkdtemp dir under os.tmpdir())
    // is dead weight once read/upload finished — success or failure alike.
    cleanupMyAppsTempPath(input.sourcePath)
  }
}

export async function myAppsPublish(input: {
  workspaceId: string
  productSpaceId: string
  appId: string
}): Promise<PublishMyAppResponse> {
  await requireCommittedSpaceScope(input)
  try {
    return await withAdmin((client, token) => client.publishMyApp(token, input.productSpaceId, input.appId))
  } catch (error) {
    if (error instanceof MyAppsAdminUnavailableError) throw error
    throw mapMyAppsFailure(error)
  }
}

export async function myAppsWithdraw(input: {
  workspaceId: string
  productSpaceId: string
  appId: string
}): Promise<WithdrawMyAppResponse> {
  await requireCommittedSpaceScope(input)
  try {
    return await withAdmin((client, token) => client.withdrawMyApp(token, input.productSpaceId, input.appId))
  } catch (error) {
    if (error instanceof MyAppsAdminUnavailableError) throw error
    throw mapMyAppsFailure(error)
  }
}

/** myapps:delete (POO-205 C12): remove the member app row entirely; a
 * published app is withdrawn by the same admin-side transaction. */
export async function myAppsDelete(input: {
  workspaceId: string
  productSpaceId: string
  appId: string
}): Promise<DeleteMyAppResponse> {
  await requireCommittedSpaceScope(input)
  try {
    return await withAdmin((client, token) => client.deleteMyApp(token, input.productSpaceId, input.appId))
  } catch (error) {
    if (error instanceof MyAppsAdminUnavailableError) throw error
    throw mapMyAppsFailure(error)
  }
}

function mapMyAppsFailure(error: unknown): Error {
  const code = myAppsErrorCodeOf(error)
  if (code) {
    const wrapped = new Error(code)
    ;(wrapped as unknown as { errorCode?: string }).errorCode = code
    return wrapped
  }
  return new Error('myapps_service_unavailable')
}
