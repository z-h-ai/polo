/**
 * POO-177 QUOTA-01/02 — pure decisions for the manual billing refresh.
 *
 * The canonical Admin self-availability snapshot is the ONLY thing allowed to
 * rewrite a managed billing latch, and only within the revision it was
 * captured against. These tests pin the mapping (Admin reason → the original
 * banner classification), the conservative outcome resolution (unknown
 * reasons, unknown states and hard/period latches are never cleared), and
 * the revision guard (a newer admission answer always wins over an older
 * available receipt).
 */
import { describe, expect, it } from 'bun:test'
import {
  chatAccessIssueForBlockedReason,
  isManagedBillingIssue,
  refreshResultApplies,
  resolveBillingRefreshOutcome,
} from '../billing-refresh'
import type { SelfBillingAvailabilityResponse } from '@polo-ai/shared/admin/schemas'

function availabilitySnapshot(
  availability: SelfBillingAvailabilityResponse['availability'],
  overrides: Partial<Omit<SelfBillingAvailabilityResponse, 'availability'>> = {},
): SelfBillingAvailabilityResponse {
  return {
    productSpaceId: '11111111-2222-3333-4444-555555555555',
    computedAt: '2026-10-29T00:00:00.000Z',
    billingMode: 'provider_metered',
    preflightOnly: true,
    quota: null,
    availability,
    ...overrides,
  }
}

describe('chatAccessIssueForBlockedReason', () => {
  it('maps each Admin blocked reason onto the original banner classification', () => {
    expect(chatAccessIssueForBlockedReason('insufficient_credit')).toBe('insufficient-credit')
    expect(chatAccessIssueForBlockedReason('budget_exhausted')).toBe('billing-budget-exhausted')
    expect(chatAccessIssueForBlockedReason('payment_result_pending')).toBe('billing-payment-pending')
    expect(chatAccessIssueForBlockedReason('payer_restricted')).toBe('billing-payer-restricted')
  })

  it('never guesses an unknown reason into a billing class', () => {
    expect(chatAccessIssueForBlockedReason('something_new')).toBeNull()
    expect(chatAccessIssueForBlockedReason('')).toBeNull()
    // unknown-state reasons are statuses, not blocks — they never re-latch.
    expect(chatAccessIssueForBlockedReason('not_ready')).toBeNull()
    expect(chatAccessIssueForBlockedReason('billing_migration_in_progress')).toBeNull()
  })
})

describe('isManagedBillingIssue', () => {
  it('accepts exactly the four managed temporary billing latches', () => {
    expect(isManagedBillingIssue('insufficient-credit')).toBe(true)
    expect(isManagedBillingIssue('billing-budget-exhausted')).toBe(true)
    expect(isManagedBillingIssue('billing-payment-pending')).toBe(true)
    expect(isManagedBillingIssue('billing-payer-restricted')).toBe(true)
  })

  it('rejects hard blocks, period quota and config states', () => {
    expect(isManagedBillingIssue('quota-exhausted')).toBe(false)
    expect(isManagedBillingIssue('account-disabled')).toBe(false)
    expect(isManagedBillingIssue('no-ai-service')).toBe(false)
    expect(isManagedBillingIssue('ai-config-sync-failed')).toBe(false)
    expect(isManagedBillingIssue('ai-config-syncing')).toBe(false)
  })
})

describe('resolveBillingRefreshOutcome', () => {
  it('lets a canonical available snapshot clear the captured latch', () => {
    const outcome = resolveBillingRefreshOutcome(
      availabilitySnapshot({ state: 'available', reason: null }),
    )
    expect(outcome).toEqual({ kind: 'clears-latch' })
  })

  it('re-latches each blocked reason as its mapped issue', () => {
    for (const [reason, issue] of [
      ['insufficient_credit', 'insufficient-credit'],
      ['budget_exhausted', 'billing-budget-exhausted'],
      ['payment_result_pending', 'billing-payment-pending'],
      ['payer_restricted', 'billing-payer-restricted'],
    ] as const) {
      expect(resolveBillingRefreshOutcome(availabilitySnapshot({ state: 'blocked', reason }))).toEqual({
        kind: 'reblocks',
        issue,
      })
    }
  })

  it('keeps the old latch for unknown states without inventing a block', () => {
    expect(
      resolveBillingRefreshOutcome(availabilitySnapshot({ state: 'unknown', reason: 'not_ready' })),
    ).toEqual({ kind: 'unconfirmed' })
    expect(
      resolveBillingRefreshOutcome(
        availabilitySnapshot({ state: 'unknown', reason: 'billing_migration_in_progress' }),
      ),
    ).toEqual({ kind: 'unconfirmed' })
  })
})

describe('refreshResultApplies', () => {
  it('applies only when the latch revision is unchanged since capture', () => {
    expect(refreshResultApplies(7, 7)).toBe(true)
  })

  it('drops an older receipt once a newer admission answer owns the latch', () => {
    expect(refreshResultApplies(7, 8)).toBe(false)
    expect(refreshResultApplies(8, 7)).toBe(false)
  })
})
