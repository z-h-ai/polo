/**
 * GenUiAppPinBridge - Electron-side consumer of the canvas app pin request.
 *
 * packages/ui's GenUiAppCard dispatches `craft:pin-genui-app` CustomEvents
 * (it lives below TabShellProvider's tree but cannot import the context
 * without a package cycle). This bridge:
 *
 * 1. Writes the audit record FIRST via Main (genui.AUDIT_APP_PIN). Main
 *    derives the session directory itself and only accepts a bundle path
 *    that resolves to the generated artifact — a failed audit fails the pin.
 * 2. Installs the app into the tab-browser launcher (persisted through the
 *    same scope derivation as every other installed app).
 * 3. Opens its tab.
 *
 * The pinned app id is namespaced `gen-ui-app-<appId>` so it can never
 * collide with builtin app ids and is trivially identifiable as a
 * session-local canvas artifact.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useTabShell } from '@/context/TabShellContext'
import {
  GENUI_APP_PIN_EVENT,
  buildGenUiAppSrc,
  dispatchGenUiAppPinResult,
  type GenUiAppPinRequest,
} from '@polo-ai/ui/chat/GenUiAppCard'
import type { AppDefinition } from '../../../shared/tab-browser-types'

const PINNED_APP_ID_PREFIX = 'gen-ui-app-'

export function GenUiAppPinBridge() {
  const { installApp, openApp, installedApps } = useTabShell()
  // Refs keep the window listener stable across renders (no re-subscribe churn
  // when the installed-apps list changes underneath a pending pin).
  const installAppRef = useRef(installApp)
  const openAppRef = useRef(openApp)
  const installedAppsRef = useRef(installedApps)
  installAppRef.current = installApp
  openAppRef.current = openApp
  installedAppsRef.current = installedApps

  const handlePin = useCallback(async (request: GenUiAppPinRequest) => {
    try {
      // 1. Audit before any state changes — a failed audit fails the pin so a
      //    security-relevant action can never happen unrecorded.
      const audit = await window.electronAPI.appendGenUiAudit({
        sessionId: request.sessionId,
        appId: request.appId,
        title: request.title,
        indexPath: request.indexPath,
        version: request.version,
        pinnedAppId: `${PINNED_APP_ID_PREFIX}${request.appId}`,
      })
      if (!audit.ok) {
        throw new Error(audit.error || 'Audit write failed')
      }

      // 2. Install (or update) + open the tab. The entry file is the same
      //    bundle the inline card renders, so pinning never duplicates
      //    content into the launcher config.
      const order = installedAppsRef.current.reduce((max, app) => Math.max(max, app.order), 0) + 1
      const app: AppDefinition = {
        id: `${PINNED_APP_ID_PREFIX}${request.appId}`,
        name: request.title,
        url: buildGenUiAppSrc(request.indexPath, ''),
        type: 'webapp',
        createdAt: Date.now(),
        order,
      }
      await installAppRef.current(app)
      openAppRef.current(app)

      dispatchGenUiAppPinResult({ requestId: request.requestId, ok: true })
    } catch (error) {
      dispatchGenUiAppPinResult({
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [])

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<GenUiAppPinRequest>).detail
      if (!detail || typeof detail.requestId !== 'string') return
      void handlePin(detail)
    }
    window.addEventListener(GENUI_APP_PIN_EVENT, listener)
    return () => window.removeEventListener(GENUI_APP_PIN_EVENT, listener)
  }, [handlePin])

  return null
}
