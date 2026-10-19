import { beforeEach, describe, expect, it } from 'bun:test'

import {
  getWebAppArtifactPolicyState,
  isWebAppArtifactPolicyEnabled,
  setWebAppArtifactPolicy,
} from '../web-app-policy.ts'
import { HARD_WEBAPP_BUNDLE_POLICY } from '../../creator-skills/types.ts'

beforeEach(() => {
  setWebAppArtifactPolicy(undefined)
})

describe('web_app artifact policy cache (remote POO-102 policy)', () => {
  it('defaults to the permissive local hard caps when nothing was ever received', () => {
    expect(getWebAppArtifactPolicyState()).toEqual({
      enabled: true,
      maxBundleBytes: HARD_WEBAPP_BUNDLE_POLICY.maxBundleBytes,
      maxFileCount: HARD_WEBAPP_BUNDLE_POLICY.maxFileCount,
    })
    expect(isWebAppArtifactPolicyEnabled()).toBe(true)
  })

  it('caches a clamped remote policy and tightens the effective limits', () => {
    setWebAppArtifactPolicy({ enabled: true, maxBundleBytes: 64 * 1024, maxFileCount: 1 })
    expect(getWebAppArtifactPolicyState()).toEqual({
      enabled: true,
      maxBundleBytes: 64 * 1024,
      maxFileCount: 1,
    })
  })

  it('disables on an explicit enabled:false and re-enables when lifted', () => {
    setWebAppArtifactPolicy({ enabled: false, maxBundleBytes: 64 * 1024, maxFileCount: 1 })
    expect(isWebAppArtifactPolicyEnabled()).toBe(false)
    setWebAppArtifactPolicy({ enabled: true, maxBundleBytes: 64 * 1024, maxFileCount: 1 })
    expect(isWebAppArtifactPolicyEnabled()).toBe(true)
  })

  it('fail-closes on a malformed or above-hard-cap policy instead of caching it', () => {
    setWebAppArtifactPolicy({ enabled: true, maxBundleBytes: HARD_WEBAPP_BUNDLE_POLICY.maxBundleBytes + 1, maxFileCount: 1 })
    expect(isWebAppArtifactPolicyEnabled()).toBe(false)
    expect(getWebAppArtifactPolicyState().maxBundleBytes).toBe(0)

    setWebAppArtifactPolicy({ enabled: true, maxBundleBytes: -5, maxFileCount: 1 })
    expect(isWebAppArtifactPolicyEnabled()).toBe(false)
  })

  it('a reset (undefined) restores the permissive default', () => {
    setWebAppArtifactPolicy({ enabled: false, maxBundleBytes: 1024, maxFileCount: 1 })
    setWebAppArtifactPolicy(undefined)
    expect(isWebAppArtifactPolicyEnabled()).toBe(true)
  })
})
