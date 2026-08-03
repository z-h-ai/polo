import { unlink } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { RPC_CHANNELS } from '@z-h-ai/shared/protocol'
import { getCredentialManager } from '@z-h-ai/shared/credentials'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { requestClientConfirmDialog } from '@polo-ai/server-core/transport'
import type { AdminSessionControl } from './admin'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.auth.LOGOUT,
  RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION,
  RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION,
  RPC_CHANNELS.credentials.HEALTH_CHECK,
] as const

export function registerAuthHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  adminSessions: AdminSessionControl,
): void {
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

  // Logout - clear all credentials and config
  server.handle(RPC_CHANNELS.auth.LOGOUT, async () => {
    try {
      const ended = await adminSessions.endCurrentSession(async manager => {
        // Enumerate only inside the final session CAS. If account A's process
        // cleanup races with a login to B, no credential belonging to B can be
        // observed or deleted by this stale logout.
        const allCredentials = await manager.list()
        for (const credId of allCredentials) {
          await manager.delete(credId)
        }

        const configPath = join(homedir(), '.polo-ai', 'config.json')
        await unlink(configPath).catch(() => {
          // Ignore if file doesn't exist
        })
      })
      if (ended === 'session_changed') {
        return {
          success: false,
          errorCode: 'SESSION_CHANGED',
          message: 'Admin session changed',
        }
      }

      deps.platform.logger.info('Logout complete - cleared all credentials and config')
      return { success: true }
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
