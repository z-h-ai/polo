/**
 * GenUiAppPublishBridge - Electron-side consumer of the canvas app SAVE
 * request (POO-205: 保存到我的应用, superseding the POO-104 organization
 * publish — the shared-directory leg is now an explicit action on the home
 * 我的应用 partition, never a card-triggered remote publish).
 *
 * packages/ui's GenUiAppCard dispatches `craft:publish-genui-app`
 * CustomEvents (event name and payload shape unchanged — same decoupling as
 * the pin bridge). This bridge orchestrates the save chain:
 *
 * 1. `genui.PUBLISH_APP_AS_ARTIFACT` (Main): trust-check the session identity
 *    (the request carries ids only, never paths), then collect → policy-gate
 *    → zip the bundle into a Main-owned temp file, append the audit line, and
 *    return the temp path once. A failed audit or policy check fails the save
 *    before any bytes move.
 * 2. `myApps.CREATE` (myapps:create): the trusted side reads the packaged ZIP
 *    from the temp path, re-validates it and uploads it into the CURRENT
 *    committed space's my-apps list — the bundle bytes never transit the
 *    renderer and there is no target picking anywhere in the chain.
 *
 * A failed step answers with a stable `errorCode` (POO-154) so the card can
 * localize; the raw message stays diagnostics-only in the error tooltip.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import {
  GENUI_APP_PUBLISH_EVENT,
  dispatchGenUiAppPublishResult,
  type GenUiAppPublishErrorCode,
  type GenUiAppPublishRequest,
} from '@polo-ai/ui/chat/GenUiAppCard'

/** A failed save step carrying its stable, localizable failure class. */
class PublishStepError extends Error {
  readonly errorCode: GenUiAppPublishErrorCode
  constructor(message: string, errorCode: GenUiAppPublishErrorCode) {
    super(message)
    this.errorCode = errorCode
  }
}

/** Upper bound the admin wire enforces on `sourceKey` (poo205-contract-r1). */
const MYAPPS_SOURCE_KEY_MAX_CHARS = 256

/**
 * POO-205 A3b save idempotency: the stable canvas identity the admin side
 * keys re-saves on. session id + canvas app id are BOTH stable across
 * restarts (the card request carries them and nothing derives them from
 * mutable display state), so the same canvas re-saving lands as a new
 * VERSION of one row instead of duplicating it. The `genui:` prefix keeps
 * the namespace legible in admin-side storage.
 */
function buildMyAppsSourceKey(sessionId: string, appId: string): string {
  const key = `genui:${sessionId}:${appId}`
  return key.length > MYAPPS_SOURCE_KEY_MAX_CHARS ? key.slice(0, MYAPPS_SOURCE_KEY_MAX_CHARS) : key
}

export function GenUiAppPublishBridge() {
  // The committed scope triple (account + window workspace + active space),
  // read the same way every other renderer caller assembles it. Refs keep
  // the window listener stable across scope transitions; the save reads the
  // scope at click time and the trusted side re-proves the fence anyway.
  const spaceContext = useOptionalProductSpaceContext()
  const appShell = useOptionalAppShellContext()
  const scopeRef = useRef<{
    accountId: string
    workspaceId: string
    productSpaceId: string
  } | null>(null)
  scopeRef.current = spaceContext?.accountId
    && appShell?.activeWorkspaceId
    && spaceContext.activeProductSpaceId
    ? {
        accountId: spaceContext.accountId,
        workspaceId: appShell.activeWorkspaceId,
        productSpaceId: spaceContext.activeProductSpaceId,
      }
    : null

  const handlePublish = useCallback(async (request: GenUiAppPublishRequest) => {
    try {
      // 1. Package in Main (collect → policy → zip → temp file → audit,
      //    trust-checked against the session storage identity).
      const packaged = await window.electronAPI.packageGenUiAppArtifact({
        sessionId: request.sessionId,
        appId: request.appId,
        title: request.title,
      })
      if (!packaged.ok || !packaged.bundleTempPath) {
        throw new PublishStepError(packaged.error || 'Packaging failed', 'packaging-failed')
      }

      // 2. Save into the CURRENT committed space's my-apps list. There is no
      //    publish-target resolution here anymore: the shared-directory leg
      //    (myapps:publish) is an explicit action on the home 我的应用
      //    partition, and a missing committed scope fails the save cleanly.
      const scope = scopeRef.current
      if (!scope) {
        throw new PublishStepError(
          'No committed ProductSpace scope is available to save into',
          'no-active-space',
        )
      }
      const saved = await window.electronAPI.myAppsCreate({
        ...scope,
        sourcePath: packaged.bundleTempPath,
        name: request.title,
        // A3b idempotency: the same canvas re-saves as a new version of one
        // row (admin answers 200) instead of a duplicate row.
        sourceKey: buildMyAppsSourceKey(request.sessionId, request.appId),
      })

      dispatchGenUiAppPublishResult({
        requestId: request.requestId,
        ok: true,
        // A3b idempotency verdict: the admin answers 200 for a re-save of a
        // known sourceKey (new VERSION) and 201 for a new row.
        savedAsNewVersion: saved.status === 200,
      })
    } catch (error) {
      dispatchGenUiAppPublishResult({
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: error instanceof PublishStepError ? error.errorCode : 'save-failed',
      })
    }
  }, [])

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<GenUiAppPublishRequest>).detail
      if (!detail || typeof detail.requestId !== 'string') return
      void handlePublish(detail)
    }
    window.addEventListener(GENUI_APP_PUBLISH_EVENT, listener)
    return () => window.removeEventListener(GENUI_APP_PUBLISH_EVENT, listener)
  }, [handlePublish])

  return null
}
