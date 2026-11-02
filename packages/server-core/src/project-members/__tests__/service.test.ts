import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { AdminError } from '@polo-ai/shared/admin'
import type {
  ClientCreateEnterpriseCommand,
  ClientCreateInvitationCommand,
} from '@polo-ai/shared/admin/client-enterprise-contract'
import type {
  ClientCreateEnterpriseResponse,
  ClientMemberRosterResponse,
} from '@polo-ai/shared/protocol'
import {
  PM_PRODUCT_SPACE_CONTEXT_REQUIRED,
  pmCreateEnterprise,
  pmCreateProjectInvitation,
  pmListProjectInvitations,
  pmListProjectMembers,
  pmQueryCreateReceipt,
  resetProjectMembersActiveProductSpaceReaderForTests,
  resetProjectMembersAdminForTests,
  setProjectMembersActiveProductSpaceReaderForTests,
  setProjectMembersAdminForTests,
} from '../service'
import { ProjectMembersAdminUnavailableError, type ProjectMembersAdmin } from '../admin-client'
import {
  beginAccountTransition,
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
  settleAccountTransition,
} from '../../handlers/rpc/trusted-product-space-account'
import {
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
} from '../../runtime/product-space-executions'
import type { TrustedProductSpaceSummary } from '@polo-ai/shared/product-spaces'

/**
 * POO-196 追加轮 project-members service tests (adjudication D-A/D-B/D-C).
 *
 * The service seams (setProjectMembersAdminForTests /
 * setProjectMembersActiveProductSpaceReaderForTests) plus the runtime fence
 * and trusted-account setters stand in for the real session state, so the
 * requireAccountScope / requireMemberScope gates and the cross-await CAS run
 * for real inside every call.
 */

const ACCOUNT_ID = 'account-1'
const ACCOUNT_ID_OTHER = 'account-2'
const PERSONAL_SPACE_ID = 'space-personal'
const SPACE_ID = 'space-1'

const ENTERPRISE_SPACE = {
  id: SPACE_ID,
  kind: 'enterprise',
  enterpriseId: 'ent-1',
  name: 'Test Project',
  role: 'member',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'ent-1' },
} as unknown as TrustedProductSpaceSummary

const PERSONAL_SPACE = {
  id: PERSONAL_SPACE_ID,
  kind: 'personal',
  name: '我的空间',
  accessMode: 'active',
  payer: { kind: 'account', accountId: ACCOUNT_ID },
} as unknown as TrustedProductSpaceSummary

const CREATE_COMMAND = {
  name: '华东区销售资料库',
  ownerName: '李明',
  purpose: '集中管理区域销售资料',
  paymentResponsibilityAccepted: true as const,
  paymentResponsibilityTermsVersion: 'POL-79-payment-responsibility-v1' as const,
}

const CREATE_RESPONSE: ClientCreateEnterpriseResponse = {
  result: 'created',
  enterpriseId: '11111111-1111-4111-8111-111111111111',
  productSpaceId: SPACE_ID,
  viewerRole: 'owner',
  enterpriseName: '华东区销售资料库',
  createdAt: '2026-11-02T00:00:00.000Z',
}

function errCodeOf(error: unknown): string {
  return ((error ?? {}) as Record<string, unknown>).code as string
}

/** Commits a personal-space fence for ACCOUNT_ID (the create command's
 * precondition: NO enterprise membership required — D-B). */
function commitPersonalFence(accountId = ACCOUNT_ID): void {
  setRuntimeActiveProductSpace(PERSONAL_SPACE_ID, 'personal')
  setRuntimeActiveProductSpaceAccount(accountId)
  setSyncTrustedProductSpaceAccountId(accountId)
  setTrustedProductSpaceAccountProvider(async () => accountId)
  setProjectMembersActiveProductSpaceReaderForTests((id, productSpaceId) => {
    if (id !== accountId) return null
    return productSpaceId === PERSONAL_SPACE_ID ? PERSONAL_SPACE : null
  })
}

/** Commits the committed ENTERPRISE fence (roster/invitation precondition). */
function commitEnterpriseFence(accountId = ACCOUNT_ID): void {
  setRuntimeActiveProductSpace(SPACE_ID, 'enterprise')
  setRuntimeActiveProductSpaceAccount(accountId)
  setSyncTrustedProductSpaceAccountId(accountId)
  setTrustedProductSpaceAccountProvider(async () => accountId)
  setProjectMembersActiveProductSpaceReaderForTests((id, productSpaceId) => {
    if (id !== accountId || productSpaceId !== SPACE_ID) return null
    return ENTERPRISE_SPACE
  })
}

beforeEach(() => {
  commitPersonalFence()
})

afterEach(() => {
  resetProjectMembersActiveProductSpaceReaderForTests()
  resetProjectMembersAdminForTests()
  setRuntimeActiveProductSpace(null)
  setSyncTrustedProductSpaceAccountId(null)
  setTrustedProductSpaceAccountProvider(async () => null)
})

describe('pmCreateEnterprise — account-scoped create (D-B)', () => {
  it('creates through the admin surface without any committed enterprise space', async () => {
    const calls: Array<Record<string, unknown>> = []
    setProjectMembersAdminForTests({
      createEnterprise: async (input: ClientCreateEnterpriseCommand & { idempotencyKey: string }) => {
        calls.push(input)
        return CREATE_RESPONSE
      },
    } as unknown as ProjectMembersAdmin)

    const response = await pmCreateEnterprise({
      accountId: ACCOUNT_ID,
      idempotencyKey: 'pm-create-abc',
      command: CREATE_COMMAND,
    })
    expect(response).toEqual(CREATE_RESPONSE)
    // The command rides with the key — the admin header contract.
    expect(calls[0]).toMatchObject({ idempotencyKey: 'pm-create-abc', name: CREATE_COMMAND.name })
  })

  it('rejects a renderer account that is not the trusted account', async () => {
    setProjectMembersAdminForTests({
      createEnterprise: async () => CREATE_RESPONSE,
    } as unknown as ProjectMembersAdmin)
    try {
      await pmCreateEnterprise({
        accountId: ACCOUNT_ID_OTHER,
        idempotencyKey: 'pm-create-abc',
        command: CREATE_COMMAND,
      })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_scope_changed')
    }
  })

  it('fails closed with pm_signin_required when no trusted session exists', async () => {
    setSyncTrustedProductSpaceAccountId(null)
    setTrustedProductSpaceAccountProvider(async () => null)
    try {
      await pmCreateEnterprise({
        accountId: ACCOUNT_ID,
        idempotencyKey: 'pm-create-abc',
        command: CREATE_COMMAND,
      })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_signin_required')
    }
  })

  it('discards the response when an account transition lands mid-flight (race)', async () => {
    // The admin call resolves ONLY after the transition has begun: the
    // cross-await CAS must discard the aggregate instead of publishing it
    // into the replaced account.
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    setProjectMembersAdminForTests({
      createEnterprise: async () => {
        await gate
        return CREATE_RESPONSE
      },
    } as unknown as ProjectMembersAdmin)

    const pending = pmCreateEnterprise({
      accountId: ACCOUNT_ID,
      idempotencyKey: 'pm-create-race',
      command: CREATE_COMMAND,
    })
    const epoch = beginAccountTransition()
    release()
    try {
      await pending
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_scope_changed')
    } finally {
      settleAccountTransition(epoch, 'commit')
    }
  })

  it('maps admin unavailability to stable pm_* codes (signed out vs unreachable)', async () => {
    setProjectMembersAdminForTests({
      createEnterprise: async () => {
        throw new ProjectMembersAdminUnavailableError('pm_signed_out', 'no session')
      },
    } as unknown as ProjectMembersAdmin)
    try {
      await pmCreateEnterprise({ accountId: ACCOUNT_ID, idempotencyKey: 'k', command: CREATE_COMMAND })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_signin_required')
    }

    setProjectMembersAdminForTests({
      createEnterprise: async () => {
        throw new ProjectMembersAdminUnavailableError('pm_admin_unreachable', 'down')
      },
    } as unknown as ProjectMembersAdmin)
    try {
      await pmCreateEnterprise({ accountId: ACCOUNT_ID, idempotencyKey: 'k', command: CREATE_COMMAND })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_service_unavailable')
    }
  })

  it('passes contract error codes through and maps legacy uppercase aliases back', async () => {
    setProjectMembersAdminForTests({
      createEnterprise: async () => {
        throw new AdminError('phone required', 'phone_verification_required')
      },
    } as unknown as ProjectMembersAdmin)
    try {
      await pmCreateEnterprise({ accountId: ACCOUNT_ID, idempotencyKey: 'k', command: CREATE_COMMAND })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('phone_verification_required')
    }

    // Single-membership eligibility arrives verbatim in the contract spelling.
    setProjectMembersAdminForTests({
      createEnterprise: async () => {
        throw new AdminError('exists', 'account_enterprise_exists')
      },
    } as unknown as ProjectMembersAdmin)
    try {
      await pmCreateEnterprise({ accountId: ACCOUNT_ID, idempotencyKey: 'k', command: CREATE_COMMAND })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('account_enterprise_exists')
    }

    // The admin client's alias table normalizes FORBIDDEN to the uppercase
    // legacy spelling; the service maps it back to ONE contract vocabulary.
    setProjectMembersAdminForTests({
      createEnterprise: async () => {
        throw new AdminError('no', 'FORBIDDEN')
      },
    } as unknown as ProjectMembersAdmin)
    try {
      await pmCreateEnterprise({ accountId: ACCOUNT_ID, idempotencyKey: 'k', command: CREATE_COMMAND })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('forbidden')
    }
  })
})

describe('pmQueryCreateReceipt — recovery query (D-B 6)', () => {
  it('queries the original request with the stored key', async () => {
    const keys: string[] = []
    setProjectMembersAdminForTests({
      queryMyCreateReceipt: async (createRequestKey: string) => {
        keys.push(createRequestKey)
        return {
          state: 'created',
          enterpriseId: CREATE_RESPONSE.enterpriseId,
          productSpaceId: SPACE_ID,
          createdAt: CREATE_RESPONSE.createdAt,
        }
      },
    } as unknown as ProjectMembersAdmin)

    const receipt = await pmQueryCreateReceipt({ accountId: ACCOUNT_ID, createRequestKey: 'pm-create-lost' })
    expect(receipt.state).toBe('created')
    expect(keys).toEqual(['pm-create-lost'])
  })
})

describe('member-scope commands — committed-space gate (D-C)', () => {
  const ROSTER: ClientMemberRosterResponse = {
    productSpaceId: SPACE_ID,
    enterpriseName: 'Test Project',
    viewerRole: 'owner',
    members: [],
    nextCursor: null,
  }

  it('serves the roster inside the committed enterprise space (no local role gate)', async () => {
    commitEnterpriseFence()
    setProjectMembersAdminForTests({
      listProjectMembers: async () => ROSTER,
    } as unknown as ProjectMembersAdmin)

    // A plain member's surface never calls this in the UI, but the SERVICE
    // gate itself is admin-authoritative: no local role cache denies it.
    const response = await pmListProjectMembers({ accountId: ACCOUNT_ID, productSpaceId: SPACE_ID })
    expect(response).toEqual(ROSTER)
  })

  it('rejects a space that is not the committed one (renderer cannot probe a foreign id)', async () => {
    commitEnterpriseFence()
    try {
      await pmListProjectMembers({ accountId: ACCOUNT_ID, productSpaceId: 'space-foreign' })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('forbidden')
    }
  })

  it('refuses the personal space with pm_unavailable_in_personal', async () => {
    // beforeEach committed the personal fence.
    try {
      await pmListProjectMembers({ accountId: ACCOUNT_ID, productSpaceId: PERSONAL_SPACE_ID })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_unavailable_in_personal')
    }
  })

  it('requires a committed space at all (PRODUCT_SPACE_CONTEXT_REQUIRED)', async () => {
    setRuntimeActiveProductSpace(null)
    try {
      await pmListProjectMembers({ accountId: ACCOUNT_ID, productSpaceId: SPACE_ID })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe(PM_PRODUCT_SPACE_CONTEXT_REQUIRED)
    }
  })

  it('surfaces the admin 403 verbatim for a member probing the roster', async () => {
    commitEnterpriseFence()
    setProjectMembersAdminForTests({
      listProjectMembers: async () => {
        throw new AdminError('member', 'FORBIDDEN')
      },
    } as unknown as ProjectMembersAdmin)
    try {
      await pmListProjectMembers({ accountId: ACCOUNT_ID, productSpaceId: SPACE_ID })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('forbidden')
    }
  })

  it('discards roster results when the space switches mid-flight (race)', async () => {
    commitEnterpriseFence()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    setProjectMembersAdminForTests({
      listProjectMembers: async () => {
        await gate
        return ROSTER
      },
    } as unknown as ProjectMembersAdmin)

    const pending = pmListProjectMembers({ accountId: ACCOUNT_ID, productSpaceId: SPACE_ID })
    const epoch = beginAccountTransition()
    release()
    try {
      await pending
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_scope_changed')
    } finally {
      settleAccountTransition(epoch, 'commit')
    }
  })

  it('passes invitations list + create through with the committed-space gate', async () => {
    commitEnterpriseFence()
    const invitation = {
      invitationId: '22222222-2222-4222-8222-222222222222',
      status: 'active',
      maskedPhone: '138****0000',
      maskedEmail: null,
      expiresAt: '2026-11-09T00:00:00.000Z',
      createdAt: '2026-11-02T00:00:00.000Z',
      acceptedAt: null,
    }
    setProjectMembersAdminForTests({
      listProjectInvitations: async () => ({
        productSpaceId: SPACE_ID,
        viewerRole: 'owner',
        invitations: [invitation],
        nextCursor: null,
      }),
      createProjectInvitation: async (_productSpaceId: string, command: ClientCreateInvitationCommand) => ({
        result: 'created',
        invitation,
        invitationUrl: `https://admin.example.com/invite/${command.createRequestKey}`,
      }),
    } as unknown as ProjectMembersAdmin)

    const list = await pmListProjectInvitations({ accountId: ACCOUNT_ID, productSpaceId: SPACE_ID })
    expect(list.invitations).toHaveLength(1)

    const created = await pmCreateProjectInvitation({
      accountId: ACCOUNT_ID,
      productSpaceId: SPACE_ID,
      command: { createRequestKey: 'pm-invite-1', targetPhone: '13800000000' },
    })
    expect(created.result).toBe('created')
    // Only the caller's own created/replayed invitation carries a link.
    if (created.result !== 'created' && created.result !== 'replayed') throw new Error('unexpected result')
    expect(created.invitationUrl).toContain('/invite/')
  })

  it('keeps the create commands reachable from the personal fence (D-B: no enterprise gate)', async () => {
    // beforeEach committed the PERSONAL fence; the create must still run.
    setProjectMembersAdminForTests({
      createEnterprise: async () => CREATE_RESPONSE,
    } as unknown as ProjectMembersAdmin)
    const response = await pmCreateEnterprise({
      accountId: ACCOUNT_ID,
      idempotencyKey: 'pm-create-personal',
      command: CREATE_COMMAND,
    })
    expect(response.result).toBe('created')
  })
})
