import { describe, expect, it } from 'bun:test'
import { AdminClient } from '../client'
import { parseMemberMembershipsResponse } from '../member-circles'
import { isCurrentMembershipAuthorityEntitled, requireMemberCircleAppAdmission } from '../member-circle-admission'
import { memberMembershipWireFixture, currentEntitlementFixture, CURRENT_CIRCLE_ID } from './fixtures/current-entitlement'

const entry = { kind: 'app', sources: [{ kind: 'creator_circle', circleId: CURRENT_CIRCLE_ID }] }
function membership(overrides: Record<string, unknown> = {}) {
  return parseMemberMembershipsResponse({ memberships: [memberMembershipWireFixture(overrides)] }).memberships[0]!
}
const clientFor = (memberships: ReturnType<typeof membership>[]) => ({ listMemberCircleMemberships: async () => ({ memberships }) })

describe('strict Main paid-source authority', () => {
  for (const count of [0, 1, 4, 6]) {
    it(`keeps entitled current period when ${count} future cancellations displace history`, async () => {
      const member = membership({ paymentOrders: Array.from({ length: Math.min(count, 5) }, (_, i) => ({ ...memberMembershipWireFixture().paymentOrders[0], id: `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`, status: 'cancelled', effectivePaymentStatus: 'cancelled' })) })
      expect(isCurrentMembershipAuthorityEntitled(member)).toBe(true)
      expect(await requireMemberCircleAppAdmission(clientFor([member]), 'fixture', entry)).toBeFunction()
    })
  }
  for (const state of ['unknown', 'not_entitled'] as const) {
    it(`rejects ${state} despite a paid-looking history`, async () => {
      const member = membership({ currentEntitlement: currentEntitlementFixture({ state }) })
      expect(isCurrentMembershipAuthorityEntitled(member)).toBe(false)
      await expect(requireMemberCircleAppAdmission(clientFor([member]), 'fixture', entry)).rejects.toMatchObject({ code: 'CIRCLE_ENTITLEMENT_REQUIRED', details: { reason: state, recovery: 'refresh_membership' } })
    })
  }
  it('has no paid migration/omitted-authority fallback even with a future period and paid history', async () => {
    const member = membership({ currentEntitlement: undefined })
    expect(isCurrentMembershipAuthorityEntitled(member)).toBe(false)
    await expect(requireMemberCircleAppAdmission(clientFor([member]), 'fixture', entry)).rejects.toMatchObject({ details: { reason: 'unknown' } })
  })
  it('rejects full refund/chargeback current projections and preserves partial correction authority', async () => {
    for (const kind of ['refund', 'chargeback'] as const) {
      const correction = { id: 'correction', orderId: 'source-order', kind, amountMinor: 29900, authorityEvidenceId: 'proof' }
      const member = membership({ currentEntitlement: currentEntitlementFixture({ state: 'not_entitled', corrections: [correction] }) })
      await expect(requireMemberCircleAppAdmission(clientFor([member]), 'fixture', entry)).rejects.toMatchObject({ details: { reason: 'not_entitled' } })
      const retained = membership({ currentEntitlement: currentEntitlementFixture({ corrections: [{ ...correction, amountMinor: 1 }] }) })
      expect(await requireMemberCircleAppAdmission(clientFor([retained]), 'fixture', entry)).toBeFunction()
    }
  })
  it('ignores an entitled circle that is not a source of this artifact', async () => {
    await expect(requireMemberCircleAppAdmission(clientFor([membership()]), 'fixture', { kind: 'app', sources: [{ kind: 'creator_circle', circleId: 'not-this-circle' }] })).rejects.toMatchObject({ details: { reason: 'unknown' } })
  })
  it('rechecks validUntil at the captured guard without re-reading payment history', async () => {
    const validUntil = new Date(Date.now() + 100).toISOString()
    const guard = await requireMemberCircleAppAdmission(clientFor([membership({ currentEntitlement: currentEntitlementFixture({ validUntil }) })]), 'fixture', entry)
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(guard).toThrow()
  })
  it('real HTTP parser feeds the Main admission gate, with unknown then entitled recovery', async () => {
    let state: 'unknown' | 'entitled' = 'unknown'
    const requests: string[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      requests.push(new URL(request.url).pathname)
      return Response.json({ memberships: [memberMembershipWireFixture({ currentEntitlement: currentEntitlementFixture({ state }) })] })
    } })
    try {
      const client = new AdminClient(server.url.href)
      await expect(requireMemberCircleAppAdmission(client, 'fixture', entry)).rejects.toMatchObject({ details: { reason: 'unknown' } })
      state = 'entitled'
      expect(await requireMemberCircleAppAdmission(client, 'fixture', entry)).toBeFunction()
      expect(requests).toEqual(['/api/me/circle-memberships', '/api/me/circle-memberships'])
    } finally { await server.stop(true) }
  })
})


describe('R7 paid lineage binding', () => {
  for (const field of ['orderId', 'authorityEvidenceId'] as const) {
    it(`rejects entitled paid with independently null ${field} as unknown`, async () => {
      const member = membership({ currentEntitlement: currentEntitlementFixture({ source: { ...currentEntitlementFixture().source, [field]: null } }) })
      expect(isCurrentMembershipAuthorityEntitled(member)).toBe(false)
      await expect(requireMemberCircleAppAdmission(clientFor([member]), 'fixture', entry)).rejects.toMatchObject({ details: { reason: 'unknown', recovery: 'refresh_membership' } })
    })
  }
  it('keeps free null order/evidence semantics', async () => {
    const member = membership({ billingKind: 'free', currentPeriodEnd: null, currentEntitlement: currentEntitlementFixture({ currentPeriodEnd: null, validUntil: null, source: { ...currentEntitlementFixture().source, billingKind: 'free', orderId: null, authorityEvidenceId: null } }) })
    expect(isCurrentMembershipAuthorityEntitled(member)).toBe(true)
  })
})
