/**
 * GenUiAppPublishBridge - Electron-side consumer of the canvas app publish
 * request (POO-104: 发布为 Web App Artifact).
 *
 * packages/ui's GenUiAppCard dispatches `craft:publish-genui-app`
 * CustomEvents (same decoupling as the pin bridge). This bridge orchestrates
 * the publish chain — the packaging leg runs in Main, the upload leg reuses
 * the EXISTING CreatorArtifact chain so revocation, checksums and the
 * platform-owned polo-app.json all stay in one place:
 *
 * 1. `genui.PUBLISH_APP_AS_ARTIFACT` (Main): trust-check the session identity
 *    (the request carries ids only, never paths), then collect → policy-gate
 *    → zip the bundle, append the audit line, and return the payload once.
 *    A failed audit or policy check fails the publish before any bytes leave
 *    the session directory.
 * 2. `admin.LIST_ORGANIZATIONS`: pick the publish target — the FIRST ACTIVE
 *    organization, deliberately NO inactive fallback (publishing into a
 *    suspended organization would create a listing nobody can see). The
 *    resolved target is broadcast to the cards, which disable the publish
 *    button when no active organization exists. (The shared resolver module
 *    imports node:crypto and must stay out of the renderer bundle.)
 * 3. `admin.PUBLISH_CREATOR_APP` (mode "upload"): analyze → canonical bundle
 *    (writes the platform-owned polo-app.json) → platform release (checksum)
 *    → upload → completeAndPublish.
 *
 * Every failure answers with a stable `errorCode` (POO-154) so the card can
 * localize; the raw message stays diagnostics-only in the error tooltip.
 */

import { useCallback, useEffect, useRef } from 'react'
import {
  GENUI_APP_PUBLISH_EVENT,
  GENUI_APP_PUBLISH_TARGET_EVENT,
  GENUI_APP_PUBLISH_TARGET_QUERY_EVENT,
  dispatchGenUiAppPublishResult,
  dispatchGenUiAppPublishTarget,
  type GenUiAppPublishErrorCode,
  type GenUiAppPublishRequest,
  type GenUiAppPublishTarget,
} from '@polo-ai/ui/chat/GenUiAppCard'

/** A failed publish step carrying its stable, localizable failure class. */
class PublishStepError extends Error {
  readonly errorCode: GenUiAppPublishErrorCode
  constructor(message: string, errorCode: GenUiAppPublishErrorCode) {
    super(message)
    this.errorCode = errorCode
  }
}

export function GenUiAppPublishBridge() {
  const handlePublish = useCallback(async (request: GenUiAppPublishRequest) => {
    try {
      // 1. Package in Main (collect → policy → zip → audit → return,
      //    trust-checked against the session storage identity).
      const packaged = await window.electronAPI.packageGenUiAppArtifact({
        sessionId: request.sessionId,
        appId: request.appId,
        title: request.title,
      })
      if (!packaged.ok || !packaged.payloadBase64) {
        throw new PublishStepError(packaged.error || 'Packaging failed', 'packaging-failed')
      }

      // 2. Publish target: the first ACTIVE organization — no inactive
      //    fallback (a suspended organization cannot see what it publishes).
      //    A desktop user always has at most a handful; no picker in this
      //    phase. The card's disabled state comes from the broadcast below;
      //    this re-check stays authoritative.
      const orgs = await window.electronAPI.organizationList()
      if (!orgs.success) {
        throw new PublishStepError(orgs.message || 'Could not list organizations for publish', 'no-publish-target')
      }
      const target = orgs.organizations.find(org => org.status === 'active' && org.membership.status === 'active')
      if (!target) {
        throw new PublishStepError('No active organization available to publish into', 'no-publish-target')
      }

      // 3. Hand the payload to the existing CreatorArtifact upload chain.
      const published = await window.electronAPI.creatorAppPublish({
        organizationId: target.id,
        name: request.title,
        visibility: 'all_members',
        mode: 'upload',
        payloadBase64: packaged.payloadBase64,
        selectedEntry: packaged.entry ?? { runtime: 'static', path: 'index.html' },
      })
      if (!published.success) {
        throw new PublishStepError(published.message || 'Publish failed', 'publish-failed')
      }
      // Defensive: packaging always supplies the analyzed static entry, so
      // the chain has no reason to ask for entry selection. Anything that is
      // not a concrete publication means the contract drifted — fail the
      // publish instead of reporting success.
      if (!('publication' in published) || !published.publication) {
        throw new PublishStepError('Publish chain did not return a publication (unexpected entry-selection round-trip)', 'publish-failed')
      }

      dispatchGenUiAppPublishResult({
        requestId: request.requestId,
        ok: true,
        organizationName: target.name,
      })
    } catch (error) {
      dispatchGenUiAppPublishResult({
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: error instanceof PublishStepError ? error.errorCode : 'publish-failed',
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

  // Announce the publish target so cards can gate the button: no active
  // organization → hasActiveTarget=false → disabled (publishing has no
  // fallback target). A failed organization RPC is UNKNOWN, not absent — no
  // announcement, the button stays enabled and a click surfaces the precise
  // error from the publish chain.
  //
  // POO-154: the cards mount AFTER this bridge, so the mount announcement
  // alone never reaches them; a card's `craft:query-genui-publish-target`
  // request (re)broadcasts the resolved state. The first resolution is
  // memoized so a transcript of many cards costs one org RPC; a resolution
  // that is still in flight is awaited by later queries rather than
  // refetched.
  const resolvedTargetRef = useRef<GenUiAppPublishTarget | null>(null)
  const resolvingRef = useRef<Promise<void> | null>(null)

  const resolveAndAnnounce = useCallback(() => {
    if (resolvedTargetRef.current) {
      dispatchGenUiAppPublishTarget(resolvedTargetRef.current)
      return
    }
    if (!resolvingRef.current) {
      resolvingRef.current = (async () => {
        let target: { name: string } | null = null
        try {
          const orgs = await window.electronAPI.organizationList()
          if (orgs.success) {
            target = orgs.organizations.find(org => org.status === 'active' && org.membership.status === 'active') ?? null
          }
        } catch {
          // Leave target null → unknown, not absent.
        }
        resolvedTargetRef.current = {
          hasActiveTarget: target != null,
          organizationName: target?.name ?? null,
        }
        dispatchGenUiAppPublishTarget(resolvedTargetRef.current)
      })()
    }
  }, [])

  useEffect(() => {
    void resolveAndAnnounce()
    const queryListener = () => { resolveAndAnnounce() }
    window.addEventListener(GENUI_APP_PUBLISH_TARGET_QUERY_EVENT, queryListener)
    return () => window.removeEventListener(GENUI_APP_PUBLISH_TARGET_QUERY_EVENT, queryListener)
  }, [resolveAndAnnounce])

  return null
}
