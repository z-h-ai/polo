/**
 * circle-purchase-url tests (POO-70 C6 / POO-95; P70-SUBSCRIPTION-02).
 *
 * Coverage required by the card (证明完成): URL 恶意输入 (javascript:/data:/
 * credentials/unknown query), 外域 origin, the approved `/c/{shareId}` path
 * shape with `renew=1`, plus the conjunctive handoff selection over the C2
 * previewRenewal payload (C2 unresolved / C2 resolved but renderer gate
 * fails / both agree). Nothing here creates an order or touches a payment
 * SDK — the gate only decides whether a URL may be handed to the browser.
 */
import { describe, expect, it } from 'bun:test'
import {
  APPROVED_PURCHASE_QUERY_KEYS,
  CIRCLE_PURCHASE_CONTROLLED_ORIGIN,
  isApprovedResolvedPurchaseUrl,
  resolveCirclePurchaseUrl,
  selectCirclePurchaseHandoff,
  type CirclePurchaseHandoffPayload,
} from '../circle-purchase-url'

const ORIGIN = CIRCLE_PURCHASE_CONTROLLED_ORIGIN

function payload(
  overrides: Partial<CirclePurchaseHandoffPayload> = {},
): CirclePurchaseHandoffPayload {
  return {
    purchaseUrl: '/c/star-circle?renew=1',
    resolvedPurchaseUrl: `${ORIGIN}/c/star-circle?renew=1`,
    purchaseUrlResolutionError: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Approved shapes
// ---------------------------------------------------------------------------

describe('resolveCirclePurchaseUrl — approved shapes', () => {
  it('approves the canonical relative path with renew=1', () => {
    const resolution = resolveCirclePurchaseUrl('/c/star-circle?renew=1')
    expect(resolution.ok).toBe(true)
    if (resolution.ok) {
      expect(resolution.url).toBe(`${ORIGIN}/c/star-circle?renew=1`)
    }
  })

  it('approves a relative path without query', () => {
    const resolution = resolveCirclePurchaseUrl('/c/star-circle')
    expect(resolution.ok).toBe(true)
  })

  it('approves an absolute URL on the controlled origin', () => {
    const resolution = resolveCirclePurchaseUrl(`${ORIGIN}/c/star-circle?renew=1`)
    expect(resolution.ok).toBe(true)
  })

  it('documents the single approved query key (contract marker)', () => {
    expect([...APPROVED_PURCHASE_QUERY_KEYS]).toEqual(['renew'])
  })
})

// ---------------------------------------------------------------------------
// Malicious input (URL 恶意输入)
// ---------------------------------------------------------------------------

describe('resolveCirclePurchaseUrl — malicious input fails closed', () => {
  it('rejects javascript: URLs as invalid', () => {
    const resolution = resolveCirclePurchaseUrl('javascript:alert(1)')
    expect(resolution).toEqual({ ok: false, reason: 'invalid_purchase_url' })
  })

  it('rejects data: URLs as invalid', () => {
    const resolution = resolveCirclePurchaseUrl('data:text/html,<h1>hi</h1>')
    expect(resolution).toEqual({ ok: false, reason: 'invalid_purchase_url' })
  })

  it('rejects a foreign origin as untrusted', () => {
    const resolution = resolveCirclePurchaseUrl('https://evil.example.com/c/star-circle?renew=1')
    expect(resolution).toEqual({ ok: false, reason: 'untrusted_purchase_url_origin' })
  })

  it('rejects an http→https lookalike host as untrusted', () => {
    const resolution = resolveCirclePurchaseUrl('https://creator.polo.z-h-ai.com.evil.test/c/x?renew=1')
    expect(resolution).toEqual({ ok: false, reason: 'untrusted_purchase_url_origin' })
  })

  it('rejects embedded credentials as invalid', () => {
    const resolution = resolveCirclePurchaseUrl(`${ORIGIN.replace('https://', 'https://user:pass@')}/c/star-circle?renew=1`)
    expect(resolution).toEqual({ ok: false, reason: 'invalid_purchase_url' })
  })

  it('rejects unknown query keys as invalid', () => {
    const resolution = resolveCirclePurchaseUrl('/c/star-circle?renew=1&next=/admin')
    expect(resolution).toEqual({ ok: false, reason: 'invalid_purchase_url' })
  })

  it('rejects a non-purchase path as invalid', () => {
    expect(resolveCirclePurchaseUrl('/admin/circles?renew=1')).toEqual({
      ok: false,
      reason: 'invalid_purchase_url',
    })
    expect(resolveCirclePurchaseUrl('/c/a/b?renew=1')).toEqual({
      ok: false,
      reason: 'invalid_purchase_url',
    })
  })

  it('rejects an empty share segment as invalid', () => {
    expect(resolveCirclePurchaseUrl('/c/?renew=1')).toEqual({
      ok: false,
      reason: 'invalid_purchase_url',
    })
  })

  it('rejects empty input as invalid', () => {
    expect(resolveCirclePurchaseUrl('')).toEqual({ ok: false, reason: 'invalid_purchase_url' })
  })

  it('rejects a protocol-relative foreign URL as untrusted', () => {
    expect(resolveCirclePurchaseUrl('//evil.example.com/c/x?renew=1')).toEqual({
      ok: false,
      reason: 'untrusted_purchase_url_origin',
    })
  })
})

// ---------------------------------------------------------------------------
// Resolved-URL gate (the exact value before openUrl)
// ---------------------------------------------------------------------------

describe('isApprovedResolvedPurchaseUrl', () => {
  it('accepts the resolved approved URL', () => {
    expect(isApprovedResolvedPurchaseUrl(`${ORIGIN}/c/star-circle?renew=1`)).toBe(true)
  })

  it('accepts an explicit default port variant of the controlled origin', () => {
    expect(isApprovedResolvedPurchaseUrl('https://creator.polo.z-h-ai.com:443/c/star-circle')).toBe(true)
  })

  it('rejects cross-origin, credentials, wrong paths and unknown query', () => {
    expect(isApprovedResolvedPurchaseUrl('https://evil.example.com/c/x?renew=1')).toBe(false)
    expect(isApprovedResolvedPurchaseUrl(`https://u:p@creator.polo.z-h-ai.com/c/x`)).toBe(false)
    expect(isApprovedResolvedPurchaseUrl(`${ORIGIN}/other?renew=1`)).toBe(false)
    expect(isApprovedResolvedPurchaseUrl(`${ORIGIN}/c/x?checkout=1`)).toBe(false)
    expect(isApprovedResolvedPurchaseUrl('javascript:void(0)')).toBe(false)
    expect(isApprovedResolvedPurchaseUrl('')).toBe(false)
  })

  it('honors an alternate controlled origin parameter (test double)', () => {
    expect(isApprovedResolvedPurchaseUrl(
      'https://admin.test.example/c/x?renew=1',
      'https://admin.test.example',
    )).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Handoff selection (previewRenewal payload → open decision)
// ---------------------------------------------------------------------------

describe('selectCirclePurchaseHandoff', () => {
  it('is ready when C2 resolved and the renderer gate agrees', () => {
    const handoff = selectCirclePurchaseHandoff(payload())
    expect(handoff).toEqual({ state: 'ready', url: `${ORIGIN}/c/star-circle?renew=1` })
  })

  it('is blocked with the C2 reason when C2 resolution failed closed', () => {
    const handoff = selectCirclePurchaseHandoff(payload({
      resolvedPurchaseUrl: null,
      purchaseUrlResolutionError: 'untrusted_purchase_url_origin',
      purchaseUrl: 'https://evil.example.com/c/x?renew=1',
    }))
    expect(handoff).toEqual({
      state: 'blocked',
      reason: 'untrusted_purchase_url_origin',
      rawPurchaseUrl: 'https://evil.example.com/c/x?renew=1',
    })
  })

  it('defaults a missing C2 reason to invalid_purchase_url', () => {
    const handoff = selectCirclePurchaseHandoff(payload({
      resolvedPurchaseUrl: null,
      purchaseUrlResolutionError: null,
    }))
    expect(handoff).toEqual({
      state: 'blocked',
      reason: 'invalid_purchase_url',
      rawPurchaseUrl: '/c/star-circle?renew=1',
    })
  })

  it('fails closed when C2 resolved but the renderer gate rejects the raw value', () => {
    // Main resolved against ITS confirmed origin, but the value carries an
    // unapproved query key — the renderer must still refuse to open.
    const handoff = selectCirclePurchaseHandoff(payload({
      purchaseUrl: '/c/star-circle?renew=1&tracking=x',
      resolvedPurchaseUrl: `${ORIGIN}/c/star-circle?renew=1&tracking=x`,
    }))
    expect(handoff.state).toBe('blocked')
    if (handoff.state === 'blocked') {
      expect(handoff.reason).toBe('invalid_purchase_url')
      expect(handoff.rawPurchaseUrl).toBe('/c/star-circle?renew=1&tracking=x')
    }
  })

  it('keeps the raw provider value untouched in every blocked arm', () => {
    const raw = 'javascript:alert(1)'
    const handoff = selectCirclePurchaseHandoff(payload({
      purchaseUrl: raw,
      resolvedPurchaseUrl: null,
      purchaseUrlResolutionError: 'invalid_purchase_url',
    }))
    expect(handoff.state).toBe('blocked')
    if (handoff.state === 'blocked') {
      expect(handoff.rawPurchaseUrl).toBe(raw)
    }
  })
})
