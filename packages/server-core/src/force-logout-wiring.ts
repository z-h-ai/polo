import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  createForceLogoutHandler,
  getInFlightLlmAbortControllers,
  setGlobalForceLogoutHandler,
  type OnForceLogout,
  type SessionExpiredEvent,
} from '@polo-ai/shared/auth'
import type { getCredentialManager } from '@polo-ai/shared/credentials'

export interface ConfigureServerForceLogoutOptions {
  clearCachedAuthData?: () => void | Promise<void>
  emitSessionExpired: (event: SessionExpiredEvent) => void | Promise<void>
  routeToLogin: () => void | Promise<void>
  saveUnsentInputDraft?: () => void | Promise<void>
  credentialManager?: Pick<ReturnType<typeof getCredentialManager>, 'list' | 'delete'>
}

export function configureServerForceLogout(
  options: ConfigureServerForceLogoutOptions,
): OnForceLogout {
  const handler = createForceLogoutHandler({
    getInFlightLlmAbortControllers,
    clearCachedAuthData: async () => {
      await clearServerCachedAuthData()
      await options.clearCachedAuthData?.()
    },
    saveUnsentInputDraft: options.saveUnsentInputDraft,
    emitSessionExpired: options.emitSessionExpired,
    routeToLogin: options.routeToLogin,
    credentialManager: options.credentialManager,
  })

  setGlobalForceLogoutHandler(handler)
  return handler
}

async function clearServerCachedAuthData(): Promise<void> {
  await unlink(join(homedir(), '.polo-ai', 'config.json')).catch(() => {
    // Missing config already means cached LLM config/configVersion is clear.
  })
}
