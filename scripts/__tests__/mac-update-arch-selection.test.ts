import { describe, expect, it, mock } from 'bun:test'
import { createRequire } from 'node:module'
import { load } from 'js-yaml'
import { resolveFiles } from 'electron-updater/out/providers/Provider'

// POL-268: lock electron-updater's actual macOS artifact selection behavior
// against the dual-architecture update manifest. The feed at
// updates.polo.z-h-ai.com/electron/latest is a generic provider, and the
// client runs MacUpdater from electron-updater 6.8.2 (bun.lock).
//
// MacUpdater (v6.8.2) narrows `files` before picking the ".zip" entry:
//   1. when the host is an arm64 Mac (native or Rosetta) and any entry name
//      contains "arm64", it keeps only entries matching the host architecture;
//   2. otherwise it drops every "arm64" entry;
//   3. then findFile() prefers the entry whose name contains process.arch and
//      falls back to the first remaining entry.
// A manifest without an "arm64" entry therefore hands x64 bytes to Apple
// Silicon clients — the exact defect this release fixes. These tests drive
// the real compiled MacUpdater.doDownloadUpdate path so an electron-updater
// upgrade that changes this contract fails here instead of in production.

const FEED_BASE = 'https://updates.polo.z-h-ai.com/electron/latest/'
const APP_VERSION = '0.19.1'

const DUAL_ARCH_MANIFEST = load(`
version: 0.20.0
files:
  - url: Polo-AI-x64.dmg
    sha512: x64dmgsha512base64
    size: 11
  - url: Polo-AI-x64.zip
    sha512: x64zipsha512base64
    size: 22
  - url: Polo-AI-arm64.zip
    sha512: arm64zipsha512base64
    size: 33
  - url: Polo-AI-arm64.dmg
    sha512: arm64dmgsha512base64
    size: 44
path: Polo-AI-x64.zip
sha512: x64zipsha512base64
releaseDate: '2026-10-24T00:00:00.000Z'
`) as object

// The pre-POL-268 manifest: x64 entries only, which is what made arm64
// installs silently downgrade to x64.
const X64_ONLY_MANIFEST = load(`
version: 0.20.0
files:
  - url: Polo-AI-x64.dmg
    sha512: x64dmgsha512base64
    size: 11
  - url: Polo-AI-x64.zip
    sha512: x64zipsha512base64
    size: 22
path: Polo-AI-x64.zip
sha512: x64zipsha512base64
releaseDate: '2026-10-24T00:00:00.000Z'
`) as object

type Host = { uname: string, arch: 'x64' | 'arm64' }

// electron-updater requires `electron` at load time for Squirrel bridging.
// It is a normal npm package, so bun's module mock applies to it.
mock.module('electron', () => ({ autoUpdater: { on: () => {} } }))

// MacUpdater probes the host through `sysctl` (Rosetta) and `uname -a`
// (arm64). Bun's mock.module cannot patch Node built-in modules, and the ESM
// namespace forbids assignment, so reach the CommonJS exports object that
// electron-updater's compiled code actually requires and swap the function
// there; every unrelated call is forwarded to the real implementation.
async function withHost<T>(requestedHost: Host, run: () => Promise<T>): Promise<T> {
  const require = createRequire(import.meta.url)
  const childProcess = require('child_process') as {
    execFileSync: (...invoke: unknown[]) => Buffer | string
  }
  const realExecFileSync = childProcess.execFileSync
  childProcess.execFileSync = ((file: string, args: string[]): string => {
    if (args[0] === 'sysctl') throw new Error('sysctl unavailable in test')
    if (args[0] === '-a') return requestedHost.uname
    return realExecFileSync(file, args) as string
  })
  const previousArch = process.arch
  Object.defineProperty(process, 'arch', { value: requestedHost.arch, configurable: true })
  try {
    return await run()
  } finally {
    childProcess.execFileSync = realExecFileSync
    Object.defineProperty(process, 'arch', { value: previousArch, configurable: true })
  }
}

async function selectUpdateForHost(manifest: object, requestedHost: Host): Promise<string> {
  return withHost(requestedHost, async () => {
    const { MacUpdater } = await import('electron-updater/out/MacUpdater')
    const updater = new (MacUpdater as new (options: null, app: { version: string }) => {
      executeDownload: (options: { fileInfo: { info: { url: string } } }) => Promise<unknown>
      doDownloadUpdate: (options: unknown) => Promise<unknown>
    })(null, { version: APP_VERSION })

    let selected: string | undefined
    updater.executeDownload = async options => {
      selected = options.fileInfo.info.url
      return {}
    }
    await updater.doDownloadUpdate({
      updateInfoAndProvider: {
        info: manifest,
        provider: {
          baseUrl: FEED_BASE,
          fileExtraDownloadHeaders: null,
          resolveFiles: (info: object) => resolveFiles(info, new URL(FEED_BASE)),
        },
      },
      disableDifferentialDownload: true,
    })
    if (!selected) throw new Error('MacUpdater selected no update artifact')
    return selected
  })
}

const ARM64_MAC = {
  uname: 'Darwin polo-mac 25.0.0 Darwin Kernel Version 25.0.0: root:xnu-11215/RELEASE_ARM64_T6031 arm64',
  arch: 'arm64',
} as const
const INTEL_MAC = {
  uname: 'Darwin polo-mac 25.0.0 Darwin Kernel Version 25.0.0: root:xnu-11215/RELEASE_X86_64_XNU x86_64',
  arch: 'x64',
} as const

describe('macOS updater architecture selection (electron-updater 6.8.2)', () => {
  it('selects the arm64 ZIP when an arm64 Mac parses the dual-architecture manifest', async () => {
    const selected = await selectUpdateForHost(DUAL_ARCH_MANIFEST, ARM64_MAC)
    expect(selected).toBe('Polo-AI-arm64.zip')
  })

  it('keeps selecting the x64 ZIP when an Intel Mac parses the dual-architecture manifest', async () => {
    const selected = await selectUpdateForHost(DUAL_ARCH_MANIFEST, INTEL_MAC)
    expect(selected).toBe('Polo-AI-x64.zip')
  })

  it('steers an x64 (Rosetta) install on arm64 hardware back to the arm64 ZIP', async () => {
    // MacUpdater treats a Rosetta-translated process as arm64 hardware. The
    // dual manifest therefore also converts existing x64-on-ARM installs —
    // the reported victims of this defect — to native builds on their next
    // update check.
    const selected = await selectUpdateForHost(DUAL_ARCH_MANIFEST, {
      uname: ARM64_MAC.uname,
      arch: 'x64',
    })
    expect(selected).toBe('Polo-AI-arm64.zip')
  })

  it('keeps the x64-only manifest working for existing Intel clients', async () => {
    const selected = await selectUpdateForHost(X64_ONLY_MANIFEST, INTEL_MAC)
    expect(selected).toBe('Polo-AI-x64.zip')
  })

  it('documents the regression: an x64-only manifest hands x64 bytes to arm64 Macs', async () => {
    // This is the reported defect. The dual-architecture manifest above is
    // what fixes it; this assertion pins the old behavior so a future
    // electron-updater change that silently alters the fallback is noticed.
    const selected = await selectUpdateForHost(X64_ONLY_MANIFEST, ARM64_MAC)
    expect(selected).toBe('Polo-AI-x64.zip')
  })
})
