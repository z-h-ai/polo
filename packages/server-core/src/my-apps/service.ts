import { lstatSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { AdminClient, AdminError } from '@polo-ai/shared/admin'
import { getAdminUrl, getWebAppArtifactPolicyState } from '@polo-ai/shared/config'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import {
  collectGenUiAppPublishFiles,
  buildGenUiAppArtifactZip,
  evaluateGenUiAppPublishPolicy,
} from '@polo-ai/shared/genui'
import type {
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
    throw new Error('MYAPPS_SCOPE_CHANGED')
  }
  if (!trustedAccountId || !isRuntimeFenceBoundToAccount(trustedAccountId)) {
    throw new MyAppsAdminUnavailableError('myapps_signin_required', 'No committed space is active for this account')
  }
  const activeProductSpaceId = getRuntimeActiveProductSpace()
  if (!activeProductSpaceId || activeProductSpaceId !== input.productSpaceId) {
    throw new Error('MYAPPS_SCOPE_CHANGED')
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
}): Promise<MyAppMutationResponse> {
  await requireCommittedSpaceScope(input)
  const payload = packageStaticAppFromPath(input.sourcePath)
  try {
    return await withAdmin((client, token) => client.createMyApp(token, input.productSpaceId, {
      name: input.name,
      ...(input.description !== undefined && input.description !== '' ? { description: input.description } : {}),
      payloadBase64: payload.payloadBase64,
      checksumSha256: payload.checksumSha256,
    }))
  } catch (error) {
    if (error instanceof MyAppsAdminUnavailableError) throw error
    throw mapMyAppsFailure(error)
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

function mapMyAppsFailure(error: unknown): Error {
  const code = myAppsErrorCodeOf(error)
  if (code) {
    const wrapped = new Error(code)
    ;(wrapped as unknown as { errorCode?: string }).errorCode = code
    return wrapped
  }
  return new Error('myapps_service_unavailable')
}
