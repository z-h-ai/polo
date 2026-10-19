import { expect, it } from 'bun:test'
import { AdminClient } from '../client'
import { MemberCircleInvalidResponseError } from '../member-circles'
import { memberMembershipWireFixture, currentEntitlementFixture } from './fixtures/current-entitlement'

it('real HTTP AdminClient preserves v1 authority and rejects an unsupported response instead of downgrading it', async () => {
  let wire = memberMembershipWireFixture()
  const requests: Array<{ path: string; authorization: string | null }> = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization') })
    return Response.json({ memberships: [wire] })
  } })
  try {
    const client = new AdminClient(server.url.href)
    const result = await client.listMemberCircleMemberships('controlled-token')
    expect(result.memberships[0]!.currentEntitlement).toEqual(currentEntitlementFixture())
    expect(requests).toEqual([{ path: '/api/me/circle-memberships', authorization: 'Bearer controlled-token' }])
    wire = memberMembershipWireFixture({ currentEntitlement: { ...currentEntitlementFixture(), version: 2 } })
    await expect(client.listMemberCircleMemberships('controlled-token')).rejects.toBeInstanceOf(MemberCircleInvalidResponseError)
  } finally {
    await server.stop(true)
  }
})
