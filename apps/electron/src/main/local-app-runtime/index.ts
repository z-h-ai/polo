import { app } from 'electron'
import { join } from 'path'
import { mainLog } from '../logger'
import { LocalAppRuntimeManager } from './manager'

let manager: LocalAppRuntimeManager | null = null

export function getLocalAppRuntimeManager(): LocalAppRuntimeManager {
  if (!manager) {
    manager = new LocalAppRuntimeManager({
      rootDir: join(app.getPath('userData'), 'local-apps'),
      uvPath: process.env.POLO_AI_UV,
      bunPath: process.env.POLO_AI_BUN,
      logger: {
        info: (message, details) => mainLog.info(message, details),
        warn: (message, details) => mainLog.warn(message, details),
        error: (message, details) => mainLog.error(message, details),
      },
    })
  }
  return manager
}

export function hasLocalAppRuntimeManager(): boolean {
  return manager !== null
}

export async function shutdownLocalAppRuntime(): Promise<void> {
  await manager?.shutdown()
}

export { LocalAppRuntimeManager } from './manager'
export { LocalAppRuntimeError } from './runtime-error'
export { validatePoloAppManifest } from './manifest'
