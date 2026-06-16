import { RPC_CHANNELS, type QuotaStatusRpcResult } from '@polo-ai/shared/protocol'
import { isPlatformMode } from '@polo-ai/shared/auth'
import {
  AdminApiTimeoutError,
  AdminApiUnavailableError,
  AuthenticationError,
} from '@polo-ai/shared/admin-api'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.quota.GET_STATUS,
] as const

export function registerQuotaHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.quota.GET_STATUS, async (ctx): Promise<QuotaStatusRpcResult> => {
    if (!isPlatformMode()) {
      return null
    }

    const adminApi = deps.adminApiClient
    if (!adminApi || !ctx.userJwt) {
      return { ok: false, error: 'session_expired' }
    }

    try {
      const status = await adminApi.getQuotaStatus(ctx.userJwt)
      return { ok: true, status }
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return { ok: false, error: 'session_expired' }
      }
      if (
        error instanceof AdminApiTimeoutError ||
        error instanceof AdminApiUnavailableError
      ) {
        return { ok: false, error: 'unavailable' }
      }
      deps.platform.logger.warn(
        `[quota] Failed to fetch quota status: ${error instanceof Error ? error.message : String(error)}`,
      )
      return { ok: false, error: 'unavailable' }
    }
  })
}
