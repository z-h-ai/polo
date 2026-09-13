import { z } from 'zod'

export const PRODUCT_SPACE_APP_RUNTIME_IDENTITY_CONTRACT =
  'product-space-app-runtime-identity.v1' as const
export const LOCAL_APP_API_CONTRACT = 'local-app-api.v1' as const
export const RUNTIME_PROJECTION_CONTRACT = 'runtime-projection.v1' as const
export const RUNTIME_PROJECTION_CONTRACT_VERSION = 1
export const LOCAL_APP_API_CONTRACT_VERSION = 1
export const APP_API_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Immutable runtime identity. `workspaceId` is deliberately NOT part of the
 * runtime key (POO-47 tuple); it is an independent execution/projection field.
 * `catalogEntryId` is a launch-time re-verification index only.
 */
export interface ProductSpaceAppRuntimeIdentity {
  accountId: string
  productSpaceId: string
  artifactInstanceId: string
  versionId: string
  version: string
}

export function createProductSpaceAppRuntimeIdentityKey(
  identity: ProductSpaceAppRuntimeIdentity,
): string {
  return JSON.stringify([
    'product-space-app-runtime',
    1,
    identity.accountId,
    identity.productSpaceId,
    identity.artifactInstanceId,
    identity.versionId,
  ])
}

export type AppApiStableErrorCode =
  | 'invalid_request'
  | 'capability_invalid'
  | 'route_not_found'
  | 'method_not_allowed'
  | 'request_too_large'
  | 'unsupported_media_type'
  | 'request_in_progress'
  | 'idempotency_conflict'
  | 'run_state_conflict'
  | 'run_finalized'
  | 'insufficient_credit'
  | 'request_cancelled'
  | 'host_auth_failed'
  | 'host_failed'
  | 'host_configuration_unavailable'
  | 'metering_unconfirmed'
  | 'sink_unavailable'
  | 'shutting_down'
  | 'response_cache_full'
  | 'host_timed_out'
  | 'no_output'

export interface AppApiSuccessBody<T> {
  contractVersion: typeof LOCAL_APP_API_CONTRACT_VERSION
  ok: true
  data: T
}
export interface AppApiErrorBody {
  contractVersion: typeof LOCAL_APP_API_CONTRACT_VERSION
  ok: false
  error: { code: AppApiStableErrorCode }
}

const APP_API_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Content-free identifiers are strict UUID v4 — v1/v5/nil are rejected. */
const appApiUuid = z
  .string()
  .regex(APP_API_UUID_V4_PATTERN, 'must be a UUID v4')

/** Plan wire limits are UTF-8 BYTE bounds, not JS character counts. */
const byteBoundedString = (maxBytes: number, minBytes = 1) =>
  z
    .string()
    .refine(
      value => {
        const bytes = Buffer.byteLength(value, 'utf8')
        return bytes >= minBytes && bytes <= maxBytes
      },
      { message: `must be between ${minBytes} and ${maxBytes} UTF-8 bytes` },
    )

export const AppApiRunStartSchema = z.object({ runId: appApiUuid }).strict()
export const AppAiQuerySchema = z.object({
  runId: appApiUuid,
  requestId: appApiUuid,
  prompt: byteBoundedString(1_048_576),
  systemPrompt: byteBoundedString(524_288, 0).optional(),
  responseFormat: z.enum(['text', 'json_object']).optional(),
  maxOutputTokens: z.number().int().min(1).max(8192),
  timeoutMs: z.number().int().min(1000).max(120_000),
}).strict()
export const AppApiRunFinishSchema = z.object({
  runId: appApiUuid,
  status: z.enum(['completed', 'failed', 'cancelled', 'unknown']),
}).strict()
export const AppApiResultReportSchema = z.object({
  runId: appApiUuid,
  requestId: appApiUuid,
  resultId: appApiUuid,
  title: z.string().min(1).max(256),
  summary: z.string().min(1).max(1024).optional(),
  associatedFileIds: z.array(appApiUuid).max(32).optional(),
}).strict()
export const AppApiFileReportSchema = z.object({
  runId: appApiUuid,
  requestId: appApiUuid,
  fileId: appApiUuid,
  source: z.enum(['app_import', 'app_export']),
  displayName: z.string().min(1).max(512),
  candidatePath: z.string().min(1).max(4096),
}).strict()

/** Non-secret runtime projection owned by the single AppRuntimeCenter. */
export interface AppRuntimeProjection {
  contractVersion: typeof RUNTIME_PROJECTION_CONTRACT_VERSION
  identityKey: string
  identity: ProductSpaceAppRuntimeIdentity
  workspaceId: string
  executionId: string
  runtimeGeneration: number
  scopeGeneration: number
  runtimeKind: 'python' | 'js' | 'static'
  status: 'starting' | 'running' | 'stopped' | 'failed'
  revision: number
  error?: { code: string }
}
