import { join } from 'path'

export interface BundledBunPathOptions {
  isPackaged: boolean
  platform: NodeJS.Platform
  resourcesPath: string
  appResourcesBase: string
}

/**
 * Packaged builds ship Bun through electron-builder extraResources at the
 * root of process.resourcesPath so both Electron and terminal launchers use
 * the same sidecar runtime.
 */
export function resolveBundledBunPath(options: BundledBunPathOptions): string {
  const executable = options.platform === 'win32' ? 'bun.exe' : 'bun'
  const base = options.isPackaged
    ? options.resourcesPath
    : options.appResourcesBase
  return join(base, 'vendor', 'bun', executable)
}
