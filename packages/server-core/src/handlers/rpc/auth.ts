import { unlink } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import { createAdminApiClient, logoutAuth } from '@polo-ai/shared/auth'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { requestClientConfirmDialog } from '@polo-ai/server-core/transport'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.auth.LOGOUT,
  RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION,
  RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION,
  RPC_CHANNELS.credentials.HEALTH_CHECK,
] as const

export function registerAuthHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Show logout confirmation dialog (routed to client)
  server.handle(RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION, async (ctx) => {
    const result = await requestClientConfirmDialog(server, ctx.clientId, {
      type: 'warning',
      buttons: ['Cancel', 'Log Out'],
      defaultId: 0,
      cancelId: 0,
      title: 'Log Out',
      message: 'Are you sure you want to log out?',
      detail: 'All conversations will be deleted. This action cannot be undone.',
    })
    // result.response is the index of the clicked button
    // 0 = Cancel, 1 = Log Out
    return result.response === 1
  })

  // Show delete session confirmation dialog (routed to client)
  server.handle(RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION, async (ctx, name: string) => {
    const result = await requestClientConfirmDialog(server, ctx.clientId, {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete Conversation',
      message: `Are you sure you want to delete: "${name}"?`,
      detail: 'This action cannot be undone.',
    })
    // result.response is the index of the clicked button
    // 0 = Cancel, 1 = Delete
    return result.response === 1
  })

  // Logout - revoke Admin session best-effort, then clear local auth/config cache.
  server.handle(RPC_CHANNELS.auth.LOGOUT, async (ctx) => {
    try {
      const manager = deps.credentialManager ?? getCredentialManager()
      const result = await logoutAuth({
        logout: () => logoutAdminSession(deps, ctx.userJwt),
        clearCachedAuthData: () => clearCachedAuthData(deps),
        credentialManager: manager,
      })

      if (!result.apiLogoutSucceeded) {
        deps.platform.logger.warn('Admin logout failed; cleared local auth cache anyway:', result.apiError)
      }
      deps.platform.logger.info('Logout complete - cleared local auth cache')
    } catch (error) {
      deps.platform.logger.error('Logout error:', error)
      throw error
    }
  })

  // Credential health check - validates credential store is readable and usable
  // Called on app startup to detect corruption, machine migration, or missing credentials
  server.handle(RPC_CHANNELS.credentials.HEALTH_CHECK, async () => {
    const manager = getCredentialManager()
    return manager.checkHealth()
  })
}

async function logoutAdminSession(deps: HandlerDeps, token: string | null): Promise<void> {
  if (deps.authLogout) {
    await deps.authLogout.logout(token)
    return
  }

  if (!token) {
    return
  }

  await createAdminApiClient({ token }).logout()
}

async function clearCachedAuthData(deps: HandlerDeps): Promise<void> {
  // Delete the config file. This clears cached LLM config and configVersion.
  const configPath = join(homedir(), '.polo-ai', 'config.json')
  await unlink(configPath).catch(() => {
    // Ignore if file doesn't exist
  })

  await deps.clearCachedAuthData?.()
}
