import type { PaymentHandoffTicket } from '@polo-ai/shared/admin'

/**
 * POO-112: builds the ONE browser destination the desktop may open — the
 * trusted configured admin origin, the static /pay/handoff landing route, and
 * the single-use ticket in the URL fragment. The ticket is the only
 * credential that may ever appear in a URL, and only in the fragment, which
 * browsers never send to a server. Anything else — a server-authored return
 * URL, a session token, a non-HTTP(S) or credentialed origin, or PLAINTEXT
 * HTTP to any host outside the controlled loopback development set — is
 * refused here rather than sanitized downstream. HTTPS is a hard requirement
 * off-loopback: a man-in-the-middle who rewrites a plaintext handoff document
 * can read the ticket from location.hash and redeem it with an arbitrarily
 * declared Origin header, which no server-side gate can then distinguish.
 */
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1'])

export function paymentHandoffUrl(adminOrigin: string, ticket: PaymentHandoffTicket): string {
  const origin = new URL(adminOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('invalid_admin_origin')
  const hostname = origin.hostname.toLowerCase()
  if (origin.protocol === 'http:' && !loopbackHosts.has(hostname === '[::1]' ? '::1' : hostname)) {
    throw new Error('invalid_admin_origin')
  }
  return new URL(`/pay/handoff#ticket=${encodeURIComponent(ticket.ticket)}`, origin.origin).toString()
}
