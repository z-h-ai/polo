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
 * 1. `genui.PUBLISH_APP_AS_ARTIFACT` (Main): trust-check the session identity,
 *    audit FIRST, then collect + policy-gate + zip the bundle and return the
 *    payload once. A failed audit or policy check fails the publish before
 *    any bytes leave the session directory.
 * 2. `admin.LIST_ORGANIZATIONS`: pick the publish target — the first active
 *    organization (inline fallback matching
 *    resolveCreatorAppPublishingOrganization's semantics; the shared module
 *    imports node:crypto and must stay out of the renderer bundle).
 * 3. `admin.PUBLISH_CREATOR_APP` (mode "upload"): analyze → canonical bundle
 *    (writes the platform-owned polo-app.json) → platform release (checksum)
 *    → upload → completeAndPublish.
 */

import { useCallback, useEffect } from 'react'
import {
  GENUI_APP_PUBLISH_EVENT,
  dispatchGenUiAppPublishResult,
  type GenUiAppPublishRequest,
} from '@polo-ai/ui/chat/GenUiAppCard'

export function GenUiAppPublishBridge() {
  const handlePublish = useCallback(async (request: GenUiAppPublishRequest) => {
    try {
      // 1. Package in Main (audit-first, trust-checked against the session
      //    storage identity — the request carries ids only, never paths).
      const packaged = await window.electronAPI.packageGenUiAppArtifact({
        sessionId: request.sessionId,
        appId: request.appId,
        title: request.title,
      })
      if (!packaged.ok || !packaged.payloadBase64) {
        throw new Error(packaged.error || 'Packaging failed')
      }

      // 2. Publish target: first active organization. A desktop user always
      //    has at most a handful; no picker in this phase.
      const orgs = await window.electronAPI.organizationList()
      if (!orgs.success) {
        throw new Error(orgs.message || 'Could not list organizations for publish')
      }
      const organizationId = orgs.organizations.find(org => org.status === 'active' && org.membership.status === 'active')?.id
        ?? orgs.organizations[0]?.id
      if (!organizationId) {
        throw new Error('No organization available to publish into')
      }

      // 3. Hand the payload to the existing CreatorArtifact upload chain.
      const published = await window.electronAPI.creatorAppPublish({
        organizationId,
        name: request.title,
        visibility: 'all_members',
        mode: 'upload',
        payloadBase64: packaged.payloadBase64,
        selectedEntry: packaged.entry ?? { runtime: 'static', path: 'index.html' },
      })
      if (!published.success) {
        throw new Error(published.message || 'Publish failed')
      }

      dispatchGenUiAppPublishResult({ requestId: request.requestId, ok: true })
    } catch (error) {
      dispatchGenUiAppPublishResult({
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
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
