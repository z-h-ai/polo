/**
 * GenUiAppPinBridge - Electron-side consumer of the canvas app pin/unpin
 * requests.
 *
 * packages/ui's GenUiAppCard dispatches `craft:pin-genui-app` /
 * `craft:unpin-genui-app` CustomEvents (it lives below TabShellProvider's
 * tree but cannot import the context without a package cycle). This bridge:
 *
 * 1. Writes the audit record FIRST via Main (genui.AUDIT_APP_PIN). Main
 *    derives the session directory itself and only accepts a bundle path
 *    that resolves to the generated artifact — a failed audit fails the pin.
 * 2. Installs the app into the tab-browser launcher (persisted through the
 *    same scope derivation as every other installed app).
 * 3. Opens its tab.
 *
 * An unpin request (POO-154) removes the launcher entry and closes its tab
 * again — the reverse of step 2/3, with no Main-side write, so nothing is
 * recorded or installed by unpinning.
 *
 * The pinned app id is namespaced `gen-ui-app-<appId>` so it can never
 * collide with builtin app ids and is trivially identifiable as a
 * session-local canvas artifact.
 *
 * The bridge also owns the pinned-state mirror the cards reconcile against
 * (POO-154): every install/uninstall change is broadcast as the list of bare
 * canvas app ids, and a card's `craft:query-genui-pin-state` request is
 * answered with the current list — that is how a remounted card knows to
 * offer 取消固定 instead of a second pin.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useTabShell } from '@/context/TabShellContext'
import {
  GENUI_APP_PIN_EVENT,
  GENUI_APP_PIN_STATE_EVENT,
  GENUI_APP_PIN_STATE_QUERY_EVENT,
  GENUI_APP_UNPIN_EVENT,
  buildGenUiAppSrc,
  dispatchGenUiAppPinResult,
  dispatchGenUiAppPinState,
  dispatchGenUiAppUnpinResult,
  type GenUiAppPinRequest,
  type GenUiAppPinState,
} from '@polo-ai/ui/chat/GenUiAppCard'
import { GENUI_PINNED_APP_ID_PREFIX } from '../../../shared/types'
import type { AppDefinition } from '../../../shared/tab-browser-types'

/** Bare canvas app ids of the installed pinned canvas apps (launcher order). */
function pinnedAppIdsOf(apps: AppDefinition[]): string[] {
  return apps
    .filter((app) => app.id.startsWith(GENUI_PINNED_APP_ID_PREFIX))
    .map((app) => app.id.slice(GENUI_PINNED_APP_ID_PREFIX.length))
}

export function GenUiAppPinBridge() {
  const { installApp, openApp, removeApp, installedApps } = useTabShell()
  // Refs keep the window listener stable across renders (no re-subscribe churn
  // when the installed-apps list changes underneath a pending pin).
  const installAppRef = useRef(installApp)
  const openAppRef = useRef(openApp)
  const removeAppRef = useRef(removeApp)
  const installedAppsRef = useRef(installedApps)
  installAppRef.current = installApp
  openAppRef.current = openApp
  removeAppRef.current = removeApp
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
        pinnedAppId: `${GENUI_PINNED_APP_ID_PREFIX}${request.appId}`,
      })
      if (!audit.ok) {
        throw new Error(audit.error || 'Audit write failed')
      }

      // 2. Install (or update) + open the tab. The entry file is the same
      //    bundle the inline card renders, so pinning never duplicates
      //    content into the launcher config.
      const order = installedAppsRef.current.reduce((max, app) => Math.max(max, app.order), 0) + 1
      const app: AppDefinition = {
        id: `${GENUI_PINNED_APP_ID_PREFIX}${request.appId}`,
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

  // POO-154: unpin removes the launcher entry; its tabs close with it
  // (removeApp already drops them and re-homes the active tab). Idempotent —
  // unpinning an unknown app still answers ok so the card's mirror resets.
  const handleUnpin = useCallback(async (request: { requestId: string; appId: string }) => {
    try {
      await removeAppRef.current(`${GENUI_PINNED_APP_ID_PREFIX}${request.appId}`)
      dispatchGenUiAppUnpinResult({ requestId: request.requestId, ok: true })
    } catch (error) {
      dispatchGenUiAppUnpinResult({
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
    const unpinListener = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: unknown; appId?: unknown }>).detail
      if (!detail || typeof detail.requestId !== 'string' || typeof detail.appId !== 'string') return
      void handleUnpin({ requestId: detail.requestId, appId: detail.appId })
    }
    const queryListener = () => {
      broadcastPinState(pinnedAppIdsOf(installedAppsRef.current))
    }
    window.addEventListener(GENUI_APP_PIN_EVENT, listener)
    window.addEventListener(GENUI_APP_UNPIN_EVENT, unpinListener)
    window.addEventListener(GENUI_APP_PIN_STATE_QUERY_EVENT, queryListener)
    return () => {
      window.removeEventListener(GENUI_APP_PIN_EVENT, listener)
      window.removeEventListener(GENUI_APP_UNPIN_EVENT, unpinListener)
      window.removeEventListener(GENUI_APP_PIN_STATE_QUERY_EVENT, queryListener)
    }
  }, [handlePin, handleUnpin])

  // The mirror follows the launcher: every install/uninstall (from THIS card
  // or the Home 画布应用 section) reaches every mounted card through this
  // broadcast.
  useEffect(() => {
    broadcastPinState(pinnedAppIdsOf(installedApps))
  }, [installedApps])

  return null
}

function broadcastPinState(pinnedAppIds: string[]): void {
  const detail: GenUiAppPinState = { pinnedAppIds }
  window.dispatchEvent(new CustomEvent<GenUiAppPinState>(GENUI_APP_PIN_STATE_EVENT, { detail }))
}
