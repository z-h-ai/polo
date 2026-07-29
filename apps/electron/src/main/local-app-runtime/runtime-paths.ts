import { join } from 'path'

export interface BundledBunPathOptions {
  isPackaged: boolean
  platform: NodeJS.Platform
  resourcesPath: string
  appResourcesBase: string
}

/**
 * Windows ships Bun through electron-builder extraResources at the root of
 * process.resourcesPath. macOS and Linux keep it in the packaged app tree.
 */
export function resolveBundledBunPath(options: BundledBunPathOptions): string {
  const executable = options.platform === 'win32' ? 'bun.exe' : 'bun'
  const base = options.isPackaged && options.platform === 'win32'
    ? options.resourcesPath
    : options.appResourcesBase
  return join(base, 'vendor', 'bun', executable)
}
