/**
 * Generative UI canvas (generate_app) GUI handlers — POO-102.
 *
 * AUDIT_APP_PIN records a canvas app being pinned into the tab browser. The
 * renderer supplies ids and metadata only; every path is derived Main-side:
 *
 * - The session directory comes from the calling window's Workspace mapping
 *   (never from the request), with the same managed-vs-storage identity
 *   cross-check the attachment flow uses.
 * - The bundle path in the request is only trusted after it resolves to
 *   exactly `<session data>/genui-apps/<appId>/index.html` for an existing
 *   file — a forged or renamed path is rejected, not clamped.
 * - The audit line is appended to `<session dir>/audit.jsonl` (JSONL, one
 *   record per pin, newest last). A failed audit write fails the pin.
 */

import { appendFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import { validateSessionId } from '@polo-ai/shared/sessions'
import type { GenUiAppPinAuditRequest, GenUiAppPinAuditResult } from '../../shared/types'
import type { HandlerDeps } from './handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.genui.AUDIT_APP_PIN,
] as const

// Mirrors the generate_app APP_ID_PATTERN (session-tools-core) — the audit
// path is only constructed from ids that pass this.
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const APP_ID_MAX_LENGTH = 64
const AUDIT_LINE_MAX_BYTES = 16 * 1024

export interface GenUiDeps {
  windowManager?: HandlerDeps['windowManager']
  sessionManager?: HandlerDeps['sessionManager']
  sessionStorage?: HandlerDeps['sessionStorage']
}

export function registerGenUiHandlers(server: RpcServer, deps: GenUiDeps = {}): void {
  server.handle(RPC_CHANNELS.genui.AUDIT_APP_PIN, async (ctx, request: GenUiAppPinAuditRequest): Promise<GenUiAppPinAuditResult> => {
    try {
      if (!request || typeof request !== 'object') throw new Error('Invalid audit request')
      const { sessionId, appId, title, indexPath, version, pinnedAppId } = request
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing session id')
      if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId) || appId.length > APP_ID_MAX_LENGTH) {
        throw new Error('Invalid app id')
      }
      if (typeof pinnedAppId !== 'string' || pinnedAppId.length === 0 || pinnedAppId.length > 128) {
        throw new Error('Invalid pinned app id')
      }
      if (typeof title !== 'string' || title.length === 0 || title.length > 200) throw new Error('Invalid title')
      if (typeof indexPath !== 'string' || indexPath.length === 0) throw new Error('Missing bundle path')
      if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version) || version < 1)) {
        throw new Error('Invalid version')
      }

      // The calling window's Workspace mapping is the only trust anchor — a
      // renderer cannot name another workspace's session directory.
      const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
      if (!workspaceId) throw new Error('Cannot determine workspace for the audit record')
      const sessionManager = deps.sessionManager
      if (!sessionManager) throw new Error('Session manager is unavailable')
      const storage = deps.sessionStorage
      if (!storage) throw new Error('Session storage resolver is unavailable')
      const workspace = sessionManager.getWorkspaces()
        .find(candidate => candidate.id === workspaceId)
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

      // SECURITY: sessionId is path-checked before any path composition.
      validateSessionId(sessionId)
      const managedSessionPath = sessionManager.getSessionPath(sessionId)
      if (!managedSessionPath) throw new Error(`Session not found: ${sessionId}`)
      const sessionPath = storage.getSessionPath(workspace.rootPath, sessionId)
      if (resolve(managedSessionPath) !== resolve(sessionPath)) {
        throw new Error(`Session storage identity mismatch: ${sessionId}`)
      }

      // The audited bundle must be exactly the generate_app artifact for this
      // app id — resolve() both sides, then require the request path to equal
      // the derived one (no "close enough", no clamping into place).
      const expectedIndexPath = resolve(
        storage.getDataPath(workspace.rootPath, sessionId),
        'genui-apps',
        appId,
        'index.html',
      )
      if (resolve(indexPath) !== expectedIndexPath) {
        throw new Error('Bundle path does not match the generated artifact for this app')
      }
      if (!existsSync(expectedIndexPath) || !statSync(expectedIndexPath).isFile()) {
        throw new Error('Bundle file not found')
      }

      const record = {
        event: 'genui_app_pin',
        at: new Date().toISOString(),
        sessionId,
        appId,
        version: version ?? null,
        title,
        indexPath: expectedIndexPath,
        pinnedAppId,
        webContentsId: ctx.webContentsId ?? null,
      }
      const line = JSON.stringify(record)
      if (Buffer.byteLength(line, 'utf8') > AUDIT_LINE_MAX_BYTES) {
        throw new Error('Audit record too large')
      }
      appendFileSync(join(sessionPath, 'audit.jsonl'), `${line}\n`, { encoding: 'utf-8', flag: 'a' })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
