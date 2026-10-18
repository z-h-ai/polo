/**
 * GenUI app publish chain — session-local packaging (POO-104, proposal §6).
 *
 * 「发布为 Web App Artifact」: the session-local canvas app under
 * `<session data>/genui-apps/<appId>/` is packaged into an upload ZIP here and
 * handed to the EXISTING CreatorArtifact publish chain
 * (admin.PUBLISH_CREATOR_APP, mode "upload"): analyze → createPlatformApp →
 * createCanonicalCreatorAppBundle (which writes the platform-owned
 * polo-app.json — generation never pre-writes it) → createPlatformRelease
 * (checksum + validator version server-side) → upload → completeAndPublish.
 * Revocation stays the existing revoke tombstone.
 *
 * Layout contract (proposal §6): the ZIP is rooted at the payload — index.html
 * at the zip root, optional sibling app.js/app.css. version.json is
 * session-local bookkeeping and is skipped. Everything else fails closed:
 * a publish must never sweep arbitrary session files into a distributed
 * artifact.
 *
 * Packaging is pure (fs collection separated from zip building) so the policy
 * and layout rules are unit-testable without touching a real app directory.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import type { WebAppArtifactPolicyState } from '../config/web-app-policy.ts'

/** Root-layout payload entries a canvas app may publish (proposal §6). */
export const GENUI_APP_PUBLISH_ENTRIES = ['index.html', 'app.js', 'app.css'] as const
/** The one REQUIRED entry; the static-runtime detection keys on it. */
export const GENUI_APP_PUBLISH_REQUIRED_ENTRY = 'index.html'
/** Session-local bookkeeping written by generate_app — never published. */
const SESSION_LOCAL_ENTRY = 'version.json'

export interface GenUiAppPublishFile {
  path: string
  bytes: Uint8Array
}

export type GenUiAppPublishCollection =
  | { ok: true; files: GenUiAppPublishFile[] }
  | { ok: false; error: string }

/**
 * Read the publishable payload files out of a canvas app directory. Fails
 * closed on a missing index.html, an unexpected extra file, or anything
 * unreadable — the caller decides whether the policy gate or the upload
 * chain should see the files at all.
 */
export function collectGenUiAppPublishFiles(appDir: string): GenUiAppPublishCollection {
  let names: string[]
  try {
    names = readdirSync(appDir)
  } catch (error) {
    return { ok: false, error: `App directory not readable: ${error instanceof Error ? error.message : String(error)}` }
  }
  const files: GenUiAppPublishFile[] = []
  for (const name of names.sort()) {
    if (name === SESSION_LOCAL_ENTRY) continue
    if (!(GENUI_APP_PUBLISH_ENTRIES as readonly string[]).includes(name)) {
      return {
        ok: false,
        error: `Unexpected file in the app bundle: "${name}". Only ${GENUI_APP_PUBLISH_ENTRIES.join(', ')} may be published — inline other assets into index.html.`,
      }
    }
    const filePath = join(appDir, name)
    try {
      if (!statSync(filePath).isFile()) {
        return { ok: false, error: `App bundle entry is not a regular file: "${name}"` }
      }
      files.push({ path: name, bytes: new Uint8Array(readFileSync(filePath)) })
    } catch (error) {
      return { ok: false, error: `App bundle entry not readable: "${name}": ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  if (!files.some(file => file.path === GENUI_APP_PUBLISH_REQUIRED_ENTRY)) {
    return { ok: false, error: `App bundle is missing ${GENUI_APP_PUBLISH_REQUIRED_ENTRY}.` }
  }
  return { ok: true, files }
}

/**
 * Zip the payload at the root layout (no enclosing directory — the upload
 * chain's normalizeCreatorAppPayloadRoot only tolerates one accidental wrapper,
 * and a canonical publish should not need the tolerance). Deterministic: the
 * entry order is the caller's (collect sorts by name).
 */
export function buildGenUiAppArtifactZip(files: readonly GenUiAppPublishFile[]): Uint8Array {
  const archiveEntries: Record<string, Uint8Array> = {}
  for (const file of files) {
    archiveEntries[file.path] = file.bytes
  }
  return zipSync(archiveEntries, { level: 9 })
}

export type GenUiAppPublishPolicyVerdict =
  | { ok: true }
  | { ok: false; error: string }

/**
 * The remote web_app artifact policy, enforced at the packaging boundary —
 * the same policy the pin gate clamps to, so an app that cannot be pinned
 * cannot be published either. The policy can only ever tighten the local hard
 * caps (clampWebAppArtifactPolicy); this check never loosens anything.
 */
export function evaluateGenUiAppPublishPolicy(
  files: readonly GenUiAppPublishFile[],
  policy: Pick<WebAppArtifactPolicyState, 'enabled' | 'maxBundleBytes' | 'maxFileCount'>,
): GenUiAppPublishPolicyVerdict {
  if (!policy.enabled) {
    return { ok: false, error: 'Publishing canvas apps is disabled by the web_app artifact policy.' }
  }
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0)
  if (totalBytes > policy.maxBundleBytes) {
    return {
      ok: false,
      error: `App bundle exceeds the web_app policy limit: ${totalBytes} > ${policy.maxBundleBytes} bytes. Shrink the app (inline assets as compressed data: URIs, drop dead code) and retry.`,
    }
  }
  if (files.length > policy.maxFileCount) {
    return {
      ok: false,
      error: `App bundle exceeds the web_app policy file limit: ${files.length} > ${policy.maxFileCount}. Inline app.js/app.css into index.html and retry.`,
    }
  }
  return { ok: true }
}

// ── Publish policy copy (expectation management, task card item 5) ──────────

/**
 * Release-policy text shipped with every publish result / release notes.
 *
 * @polo-ai/sdk: published artifacts MAY reference the SDK — session-local
 * generation still must not (generate_app rejects the literal). The SDK speaks
 * bridge protocol 1 and needs a host that implements it; the current desktop
 * release line (0.16.3) does NOT, so published apps must degrade gracefully
 * (SDK features off) until hosts adopt bridge protocol 1. This version
 * requirement is part of the publish policy, not a runtime negotiation.
 */
export const GENUI_PUBLISH_SDK_BRIDGE_NOTICE = [
  'Published apps may reference @polo-ai/sdk (official single-query AI capability).',
  'The SDK requires a host that speaks bridge protocol 1; the current desktop host (0.16.3) is NOT compatible, so apps must keep working with SDK features unavailable.',
].join('\n')

/**
 * P3 expectation management: third-party catalog components are read-only in
 * this phase — interaction loops depend on the poloai:// v2 bridge.
 */
export const GENUI_CATALOG_READ_ONLY_NOTICE =
  'Third-party (catalog) components are read-only in this release: they render data, but their buttons and inputs stay inert until the poloai:// v2 interaction loop ships.'

/** Combined publish-time notice returned with the packaging result. */
export function buildGenUiPublishNotice(): string {
  return [GENUI_PUBLISH_SDK_BRIDGE_NOTICE, GENUI_CATALOG_READ_ONLY_NOTICE].join('\n');
}
