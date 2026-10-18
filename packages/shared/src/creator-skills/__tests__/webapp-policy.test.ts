import { describe, expect, it } from 'bun:test'
import {
  WebAppArtifactPolicySchema,
  clampWebAppArtifactPolicy,
} from '../schemas'
import { HARD_WEBAPP_BUNDLE_POLICY } from '../types'
// The generation path (session-tools-core) pins the same 512KB cap. That leaf
// package cannot import @polo-ai/shared (shared imports IT), so the mirror is
// guarded here: if one side moves, this test drags both back in sync.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { GENERATE_APP_MAX_HTML_BYTES } from '../../../../session-tools-core/src/tool-defs'

describe('HARD_WEBAPP_BUNDLE_POLICY', () => {
  it('mirrors the generate_app 512KB generation cap', () => {
    expect(HARD_WEBAPP_BUNDLE_POLICY.maxBundleBytes).toBe(GENERATE_APP_MAX_HTML_BYTES)
    expect(HARD_WEBAPP_BUNDLE_POLICY.maxBundleBytes).toBe(512 * 1024)
  })

  it('allows one self-contained bundle file', () => {
    expect(HARD_WEBAPP_BUNDLE_POLICY.maxFileCount).toBe(1)
  })
})

describe('WebAppArtifactPolicySchema', () => {
  it('accepts a policy at the hard caps', () => {
    const result = WebAppArtifactPolicySchema.safeParse({
      enabled: true,
      maxBundleBytes: HARD_WEBAPP_BUNDLE_POLICY.maxBundleBytes,
      maxFileCount: HARD_WEBAPP_BUNDLE_POLICY.maxFileCount,
    })
    expect(result.success).toBe(true)
  })

  it('rejects a server policy above the client hard caps', () => {
    const result = WebAppArtifactPolicySchema.safeParse({
      enabled: true,
      maxBundleBytes: HARD_WEBAPP_BUNDLE_POLICY.maxBundleBytes + 1,
      maxFileCount: HARD_WEBAPP_BUNDLE_POLICY.maxFileCount,
    })
    expect(result.success).toBe(false)
  })
})

describe('clampWebAppArtifactPolicy', () => {
  it('keeps a within-caps policy as-is', () => {
    expect(clampWebAppArtifactPolicy({ enabled: true, maxBundleBytes: 1024, maxFileCount: 1 })).toEqual({
      enabled: true,
      maxBundleBytes: 1024,
      maxFileCount: 1,
    })
  })

  it('clamps values down to the hard caps', () => {
    expect(clampWebAppArtifactPolicy({ enabled: true, maxBundleBytes: 400 * 1024, maxFileCount: 1 })).toEqual({
      enabled: true,
      maxBundleBytes: Math.min(400 * 1024, HARD_WEBAPP_BUNDLE_POLICY.maxBundleBytes),
      maxFileCount: 1,
    })
  })

  it('fails closed on a malformed or over-cap policy', () => {
    expect(clampWebAppArtifactPolicy({ enabled: true, maxBundleBytes: -1, maxFileCount: 1 })).toEqual({
      enabled: false,
      maxBundleBytes: 0,
      maxFileCount: 0,
    })
    expect(clampWebAppArtifactPolicy({ enabled: true, maxBundleBytes: HARD_WEBAPP_BUNDLE_POLICY.maxBundleBytes + 1, maxFileCount: 1 })).toEqual({
      enabled: false,
      maxBundleBytes: 0,
      maxFileCount: 0,
    })
  })
})
