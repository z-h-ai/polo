import { describe, expect, it } from 'bun:test'

import { paymentHandoffUrl } from './payment-handoff'

const ticket = {
  ticket: 'A'.repeat(43),
  expiresAt: new Date().toISOString(),
  accountId: '00000000-0000-4000-8000-000000000001',
  productSpaceId: '00000000-0000-4000-8000-000000000002',
}

describe('paymentHandoffUrl', () => {
  it('hands the browser a /pay/handoff fragment URL, never a gated consumption page', () => {
    // The old implementation opened /pay/<id>/credits/consumption directly,
    // which the payer gate answers with a login screen — the exact
    // re-authentication this feature exists to remove.
    const url = new URL(paymentHandoffUrl('https://admin.example.com', ticket))
    expect(url.origin).toBe('https://admin.example.com')
    expect(url.pathname).toBe('/pay/handoff')
    expect(url.search).toBe('')
    expect(url.hash).toBe(`#ticket=${ticket.ticket}`)
  })

  it('keeps the ticket out of the request path and the query', () => {
    const url = paymentHandoffUrl('https://admin.example.com', ticket)
    expect(url).not.toContain(`?ticket=`)
    expect(url).not.toContain(`/${ticket.ticket}`)
    expect(url.endsWith(`#ticket=${ticket.ticket}`)).toBe(true)
  })

  it('encodes the ticket for the fragment and admits nothing else into the URL', () => {
    const exotic = { ...ticket, ticket: '-_aA09'.padEnd(43, 'b') }
    const url = new URL(paymentHandoffUrl('https://admin.example.com', exotic))
    expect(decodeURIComponent(url.hash)).toBe(`#ticket=${exotic.ticket}`)
  })

  it('refuses non-HTTP(S) origins and origins carrying credentials', () => {
    expect(() => paymentHandoffUrl('file:///etc', ticket)).toThrow('invalid_admin_origin')
    expect(() => paymentHandoffUrl('javascript:alert(1)', ticket)).toThrow('invalid_admin_origin')
    expect(() => paymentHandoffUrl('https://user:pass@admin.example.com', ticket)).toThrow('invalid_admin_origin')
  })

  it('forces HTTPS for every non-loopback host (R1B-4)', () => {
    // A remote or LAN plaintext origin lets a man-in-the-middle rewrite the
    // handoff document and read the ticket from location.hash; the server's
    // canonical-origin gate cannot help a non-browser redeemer afterwards.
    expect(() => paymentHandoffUrl('http://remote.example', ticket)).toThrow('invalid_admin_origin')
    expect(() => paymentHandoffUrl('http://192.168.1.5', ticket)).toThrow('invalid_admin_origin')
    expect(() => paymentHandoffUrl('http://admin.internal.example:8443', ticket)).toThrow('invalid_admin_origin')
    // HTTPS stays fine everywhere.
    expect(new URL(paymentHandoffUrl('https://remote.example', ticket)).protocol).toBe('https:')
  })

  it('keeps the controlled loopback development exception (R1B-4)', () => {
    expect(new URL(paymentHandoffUrl('http://localhost:3000', ticket)).protocol).toBe('http:')
    expect(new URL(paymentHandoffUrl('http://127.0.0.1:3000', ticket)).protocol).toBe('http:')
    expect(new URL(paymentHandoffUrl('http://[::1]:3000', ticket)).protocol).toBe('http:')
  })
})
