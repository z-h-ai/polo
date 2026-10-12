import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'

/** A browser destination is a read-only handoff, never a session credential. */
export function paymentHandoffUrl(adminOrigin: string, space: ProductSpaceSummary): string {
  if (space.kind === 'enterprise' && space.role !== 'owner') throw new Error('payment_owner_required')
  const origin = new URL(adminOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('invalid_admin_origin')
  return new URL(`/pay/${encodeURIComponent(space.id)}/credits/consumption`, origin.origin).toString()
}
