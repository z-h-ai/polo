import { app } from 'electron'
import { join } from 'path'
import { mainLog } from '../logger'
import { LocalAppRuntimeManager } from './manager'
import { ScopedLocalAppRuntimeRegistry } from './scoped-registry'

let manager: LocalAppRuntimeManager | null = null
let scopedRegistry: ScopedLocalAppRuntimeRegistry | null = null

const runtimeLogger = {
  info: (message: string, details?: unknown) => mainLog.info(message, details),
  warn: (message: string, details?: unknown) => mainLog.warn(message, details),
  error: (message: string, details?: unknown) => mainLog.error(message, details),
}

function localAppsRoot(): string {
  return join(app.getPath('userData'), 'local-apps')
}

export function getLocalAppRuntimeManager(): LocalAppRuntimeManager {
  if (!manager) {
    manager = new LocalAppRuntimeManager({
      rootDir: localAppsRoot(),
      uvPath: process.env.POLO_AI_UV,
      bunPath: process.env.POLO_AI_BUN,
      logger: runtimeLogger,
    })
  }
  return manager
}

export function getScopedLocalAppRuntimeRegistry(): ScopedLocalAppRuntimeRegistry {
  if (!scopedRegistry) {
    scopedRegistry = new ScopedLocalAppRuntimeRegistry({
      rootDir: localAppsRoot(),
      uvPath: process.env.POLO_AI_UV,
      bunPath: process.env.POLO_AI_BUN,
      logger: runtimeLogger,
    })
  }
  return scopedRegistry
}

export function hasLocalAppRuntimeManager(): boolean {
  return manager !== null || scopedRegistry !== null
}

export async function shutdownLocalAppRuntime(): Promise<void> {
  const results = await Promise.allSettled([
    manager?.shutdown(),
    scopedRegistry?.shutdown(),
  ])
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failure) throw failure.reason
}

export { LocalAppRuntimeManager } from './manager'
export { LocalAppRuntimeError } from './runtime-error'
export { validatePoloAppManifest } from './manifest'
export {
  createCatalogLocalAppScopeKey,
  ScopedLocalAppRuntimeRegistry,
  validateCatalogLocalAppScope,
} from './scoped-registry'
