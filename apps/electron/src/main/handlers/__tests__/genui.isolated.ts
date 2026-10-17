import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { GenUiAppPinAuditRequest, GenUiAppPinAuditResult } from '../../../shared/types'
import { setWebAppArtifactPolicy } from '@polo-ai/shared/config'

// The handler registers the canvas-guest src validator on webview-security;
// capture the wiring without pulling the real module's electron graph.
let wiredValidator: unknown = null
mock.module('../../webview-security', () => ({
  setGenUiGuestSrcValidator: (validator: unknown) => {
    wiredValidator = validator
  },
}))
mock.module('electron', () => ({
  app: { on: () => {}, getPath: () => tmpdir() },
  session: { fromPartition: () => ({}) },
  shell: { openExternal: async () => {} },
}))

const { registerGenUiHandlers } = await import('../genui')
const { GENUI_PINNED_APP_ID_PREFIX } = await import('../../../shared/types')

type AuditHandler = (ctx: { workspaceId?: string; webContentsId?: number }, request: GenUiAppPinAuditRequest) => Promise<GenUiAppPinAuditResult>

function loadHandlerWith(explicitDeps?: Parameters<typeof registerGenUiHandlers>[1]): AuditHandler {
  let handler: AuditHandler | null = null
  const server = {
    handle: (_channel: string, fn: AuditHandler) => {
      handler = fn
    },
  } as unknown as RpcServer
  registerGenUiHandlers(server, explicitDeps)
  return handler!
}

describe('genui AUDIT_APP_PIN gate', () => {
  let rootDir: string
  let otherRootDir: string
  let handler: AuditHandler

  // Storage layout stand-in: <workspaceRoot>/sessions/<id>[{/data}].
  const storage = {
    getSessionPath: (root: string, id: string) => join(root, 'sessions', id),
    getDataPath: (root: string, id: string) => join(root, 'sessions', id, 'data'),
  }

  function deps(sessionManagedRoot = rootDir) {
    return {
      windowManager: { getWorkspaceForWindow: () => 'ws-1' },
      sessionManager: {
        getWorkspaces: () => [{ id: 'ws-1', rootPath: rootDir }],
        getSessionPath: (sessionId: string) => join(sessionManagedRoot, 'sessions', sessionId),
      },
      sessionStorage: storage,
    }
  }

  function writeBundle(sessionId: string, appId: string, html = '<html><body>app</body></html>'): string {
    const dataDir = storage.getDataPath(rootDir, sessionId)
    const appDir = join(dataDir, 'genui-apps', appId)
    mkdirSync(appDir, { recursive: true })
    const indexPath = join(appDir, 'index.html')
    writeFileSync(indexPath, html, 'utf-8')
    return indexPath
  }

  function auditRequest(overrides: Partial<GenUiAppPinAuditRequest> = {}): GenUiAppPinAuditRequest {
    const appId = overrides.appId ?? 'app-abc'
    return {
      sessionId: 'sess-1',
      appId,
      title: 'Demo',
      indexPath: overrides.indexPath ?? join(storage.getDataPath(rootDir, 'sess-1'), 'genui-apps', appId, 'index.html'),
      version: 1,
      pinnedAppId: overrides.pinnedAppId ?? `${GENUI_PINNED_APP_ID_PREFIX}${appId}`,
      ...overrides,
    }
  }

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'genui-handler-'))
    otherRootDir = mkdtempSync(join(tmpdir(), 'genui-other-'))
    setWebAppArtifactPolicy(undefined)
    wiredValidator = null
    handler = loadHandlerWith(deps())
  })

  afterEach(() => {
    setWebAppArtifactPolicy(undefined)
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(otherRootDir, { recursive: true, force: true })
  })

  it('records a pin whose ids, path and size all check out, and wires the src validator', async () => {
    const indexPath = writeBundle('sess-1', 'app-abc')
    const result = await handler({ workspaceId: 'ws-1', webContentsId: 7 }, auditRequest({ indexPath }))

    expect(result.ok).toBe(true)
    const auditPath = join(rootDir, 'sessions', 'sess-1', 'audit.jsonl')
    expect(existsSync(auditPath)).toBe(true)
    const record = JSON.parse(readFileSync(auditPath, 'utf-8').trim())
    expect(record).toMatchObject({
      event: 'genui_app_pin',
      sessionId: 'sess-1',
      appId: 'app-abc',
      pinnedAppId: 'gen-ui-app-app-abc',
      indexPath,
    })
    // Registration wires the Main-trusted src validator when deps allow it.
    expect(wiredValidator).not.toBeNull()
  })

  it('rejects a pinnedAppId that is not the gen-ui-app-<appId> derivation', async () => {
    const indexPath = writeBundle('sess-1', 'app-abc')
    for (const forged of [
      'gen-ui-app-app-other', // another app's tab id
      'app-abc', // the bare app id
      `${GENUI_PINNED_APP_ID_PREFIX}app-abc-extra`, // suffixed drift
      'builtin-notes', // a builtin app id
    ]) {
      const result = await handler(
        { workspaceId: 'ws-1', webContentsId: 7 },
        auditRequest({ indexPath, pinnedAppId: forged }),
      )
      expect(result.ok).toBe(false)
      expect(result.error).toContain('gen-ui-app-<appId>')
    }
    // Nothing was audited for the forged requests.
    expect(existsSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'))).toBe(false)
  })

  it('rejects when the workspace/session storage identity does not match', async () => {
    const indexPath = writeBundle('sess-1', 'app-abc')
    // The managed session path points into a different workspace root than
    // the storage-derived one — a moved or fabricated session.
    const mismatched = loadHandlerWith(deps(otherRootDir))
    const result = await mismatched(
      { workspaceId: 'ws-1', webContentsId: 7 },
      auditRequest({ indexPath }),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('mismatch')
    expect(existsSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'))).toBe(false)
  })

  it('fails the pin when the audit write fails (audit-first, no unrecorded pin)', async () => {
    const indexPath = writeBundle('sess-1', 'app-abc')
    // Make the append target unusable: audit.jsonl exists as a DIRECTORY.
    mkdirSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'), { recursive: true })

    const result = await handler({ workspaceId: 'ws-1', webContentsId: 7 }, auditRequest({ indexPath }))

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    // The failed write left no usable audit line behind.
    expect(statSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl')).isDirectory()).toBe(true)
  })

  it('refuses a bundle above the remote web_app policy maxBundleBytes', async () => {
    const indexPath = writeBundle('sess-1', 'app-abc', 'x'.repeat(64))
    // Tighten the remote policy below the bundle size (clamped cache).
    setWebAppArtifactPolicy({ enabled: true, maxBundleBytes: 16, maxFileCount: 1 })

    const result = await handler({ workspaceId: 'ws-1', webContentsId: 7 }, auditRequest({ indexPath }))

    expect(result.ok).toBe(false)
    expect(result.error).toContain('policy limit')
    expect(existsSync(join(rootDir, 'sessions', 'sess-1', 'audit.jsonl'))).toBe(false)

    // With the policy back at the default the same bundle pins fine.
    setWebAppArtifactPolicy(undefined)
    const allowed = await handler({ workspaceId: 'ws-1', webContentsId: 7 }, auditRequest({ indexPath }))
    expect(allowed.ok).toBe(true)
  })
})
