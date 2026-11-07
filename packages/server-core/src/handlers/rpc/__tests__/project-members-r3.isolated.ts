import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { AdminError, type AdminErrorCode } from '@polo-ai/shared/admin'
import { CLIENT_ENTERPRISE_CONTRACT_VERSION } from '@polo-ai/shared/admin/client-enterprise-contract'
import {
  RPC_CHANNELS,
  PmProductSpacesListR3ResponseSchema,
} from '@polo-ai/shared/protocol'
import { PRODUCT_SPACE_CONTRACT_VERSION } from '@polo-ai/shared/product-spaces'
import type { HandlerFn, RpcServer } from '@polo-ai/server-core/transport'
import type {
  ClientColleagueOptionsResponse,
  ClientCollaborationRosterResponse,
  ClientCreateColleagueInvitationResponse,
  ClientColleagueInvitationReceipt,
  PmProductSpacesListR3Response,
} from '@polo-ai/shared/protocol'
import { registerProjectMembersHandlers, PROJECT_MEMBERS_HANDLED_CHANNELS } from '../project-members'
import { type ProjectMembersAdmin } from '../../../project-members/admin-client'
import {
  PM_PRODUCT_SPACE_CONTEXT_REQUIRED,
  resetProjectMembersActiveProductSpaceReaderForTests,
  resetProjectMembersAdminForTests,
  setProjectMembersActiveProductSpaceReaderForTests,
  setProjectMembersAdminForTests,
} from '../../../project-members/service'
import {
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
} from '../../../runtime/product-space-executions'
import {
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../trusted-product-space-account'
import type { TrustedProductSpaceSummary } from '@polo-ai/shared/product-spaces'

/**
 * POO-196 R3 project-members RPC contract tests (adjudication D3–D6, B3
 * gate "pm RPC contract"). The harness registers the REAL handlers against a
 * capture RpcServer and stands in the runtime fence + trusted session the
 * service gates re-prove, so the full renderer→handler→admin-adapter chain
 * runs for real:
 *
 * - channel closure: the manifest matches RPC_CHANNELS.projectMembers and
 *   every channel is registered exactly once;
 * - call shapes: each channel forwards the parsed protocol input to the
 *   adapter with the admin HTTP call's exact argument shape;
 * - error bridge: the D5/D6 codes (colleague_source_unavailable,
 *   colleague_target_unavailable, contract_version_unsupported) survive
 *   verbatim and the legacy uppercase aliases still map back onto ONE
 *   contract vocabulary;
 * - gates: the directory/roster/invitation channels are committed-space
 *   scoped; the negotiated R3 list is ACCOUNT-scoped (reachable from the
 *   personal space, D6 P2);
 * - composition: the v1+R3 envelope join validates exactly (D6).
 */

const ACCOUNT_ID = 'account-1'
const ACCOUNT_ID_OTHER = 'account-2'
const PERSONAL_SPACE_ID = 'space-personal'
const SPACE_ID = 'space-1'

const SOURCE_ENTERPRISE_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_USER_ID = '22222222-2222-4222-8222-222222222222'
const INVITATION_ID = '33333333-3333-4333-8333-333333333333'
const SOURCE_OF_ROSTER = '44444444-4444-4444-8444-444444444444'

const ENTERPRISE_SPACE = {
  id: SPACE_ID,
  kind: 'enterprise',
  enterpriseId: 'ent-1',
  name: '华东区销售项目',
  role: 'owner',
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

const COLLEAGUE_OPTIONS: ClientColleagueOptionsResponse = {
  sourceState: 'available',
  source: { enterpriseId: SOURCE_OF_ROSTER, name: '主企业' },
  members: [
    { userId: TARGET_USER_ID, displayName: '王芳', avatarUrl: null, projectState: 'available' },
    { userId: '55555555-5555-4555-8555-555555555555', displayName: null, avatarUrl: null, projectState: 'pending' },
  ],
  nextCursor: 'cursor-1',
}

const ROSTER_R3: ClientCollaborationRosterResponse = {
  productSpaceId: SPACE_ID,
  enterpriseName: '华东区销售项目',
  viewerRole: 'member',
  totalActiveMembers: 2,
  members: [
    { userId: TARGET_USER_ID, displayName: '王芳', avatarUrl: null, role: 'owner', isSelf: false },
    { userId: '55555555-5555-4555-8555-555555555555', displayName: '李明', avatarUrl: null, role: 'member', isSelf: true },
  ],
  nextCursor: null,
}

const COLLEAGUE_INVITATION = {
  invitationId: INVITATION_ID,
  status: 'active' as const,
  maskedPhone: '138****0000',
  maskedEmail: null,
  expiresAt: '2026-11-11T00:00:00.000Z',
  createdAt: '2026-11-04T00:00:00.000Z',
  acceptedAt: null,
}

const COLLEAGUE_CREATED: ClientCreateColleagueInvitationResponse = {
  result: 'created',
  invitation: COLLEAGUE_INVITATION,
  invitationUrl: 'https://admin.example.com/invite/pm-colleague-1',
}

const COLLEAGUE_RECEIPT: ClientColleagueInvitationReceipt = {
  state: 'found',
  invitation: COLLEAGUE_INVITATION,
  invitationUrl: 'https://admin.example.com/invite/pm-colleague-1',
}

/** Committed ENTERPRISE fence (directory/roster/invitation precondition). */
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

/** Committed personal fence (the R3 list is deliberately reachable here). */
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

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel: string, handler: HandlerFn) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return null
    },
  } as unknown as RpcServer
  registerProjectMembersHandlers(server)
  const invoke = async (channel: string, rawInput: unknown) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler for ${channel}`)
    return handler({} as never, rawInput)
  }
  return { handlers, invoke }
}

interface AdminCalls {
  colleagueOptions: Array<{ productSpaceId: string; query: Record<string, unknown> }>
  roster: Array<{ productSpaceId: string; query: Record<string, unknown> }>
  createColleague: Array<{ productSpaceId: string; command: Record<string, unknown> }>
  queryColleague: Array<{ productSpaceId: string; createRequestKey: string }>
  listR3: number
}

function recordingAdmin(calls: AdminCalls, overrides: Partial<ProjectMembersAdmin> = {}): ProjectMembersAdmin {
  return {
    createEnterprise: async () => {
      throw new Error('not used in R3 tests')
    },
    queryMyCreateReceipt: async () => {
      throw new Error('not used in R3 tests')
    },
    listProjectMembers: async () => {
      throw new Error('not used in R3 tests')
    },
    listProjectInvitations: async () => {
      throw new Error('not used in R3 tests')
    },
    createProjectInvitation: async () => {
      throw new Error('not used in R3 tests')
    },
    listColleagueOptions: async (productSpaceId: string, query: { q?: string; limit?: number; cursor?: string }) => {
      calls.colleagueOptions.push({ productSpaceId, query: { ...query } })
      return COLLEAGUE_OPTIONS
    },
    listCollaborationRoster: async (productSpaceId: string, query: { q?: string; limit?: number; cursor?: string }) => {
      calls.roster.push({ productSpaceId, query: { ...query } })
      return ROSTER_R3
    },
    createColleagueInvitation: async (productSpaceId: string, command: { sourceEnterpriseId: string; targetUserId: string; createRequestKey: string }) => {
      calls.createColleague.push({ productSpaceId, command: { ...command } })
      return COLLEAGUE_CREATED
    },
    queryColleagueInvitation: async (productSpaceId: string, createRequestKey: string) => {
      calls.queryColleague.push({ productSpaceId, createRequestKey })
      return COLLEAGUE_RECEIPT
    },
    listProductSpacesR3: async () => {
      calls.listR3 += 1
      return r3Envelope(v1List())
    },
    ...overrides,
  } as unknown as ProjectMembersAdmin
}

function emptyCalls(): AdminCalls {
  return {
    colleagueOptions: [],
    roster: [],
    createColleague: [],
    queryColleague: [],
    listR3: 0,
  }
}

beforeEach(() => {
  commitEnterpriseFence()
})

afterEach(() => {
  resetProjectMembersActiveProductSpaceReaderForTests()
  resetProjectMembersAdminForTests()
  setRuntimeActiveProductSpace(null)
  setSyncTrustedProductSpaceAccountId(null)
  setTrustedProductSpaceAccountProvider(async () => null)
})

// NOTE: cleanup mirrors service.test.ts — the fence/trusted-account state is
// reset after every case so the next `beforeEach` starts from a known fence.

describe('R3 channel closure (D3–D6)', () => {
  it('registers every manifest channel exactly once', () => {
    const { handlers } = createHarness()
    for (const channel of PROJECT_MEMBERS_HANDLED_CHANNELS) {
      expect(handlers.has(channel)).toBe(true)
    }
    // The manifest IS the projectMembers channel namespace — nothing added
    // to RPC_CHANNELS may silently skip the handler/gate layer.
    expect([...PROJECT_MEMBERS_HANDLED_CHANNELS].sort())
      .toEqual(Object.values(RPC_CHANNELS.projectMembers).slice().sort())
  })
})

describe('pm:listColleagueOptions — D3 directory page', () => {
  it('forwards scope + query to the adapter and returns the projection', async () => {
    const calls: AdminCalls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const response = await invoke(RPC_CHANNELS.projectMembers.LIST_COLLEAGUE_OPTIONS, {
      accountId: ACCOUNT_ID,
      productSpaceId: SPACE_ID,
      q: '王',
      cursor: 'cursor-0',
      limit: 20,
    })
    expect(response).toEqual(COLLEAGUE_OPTIONS)
    expect(calls.colleagueOptions).toEqual([{
      productSpaceId: SPACE_ID,
      query: { q: '王', cursor: 'cursor-0', limit: 20 },
    }])
  })

  it('rejects bound violations before the adapter is touched', async () => {
    const calls: AdminCalls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const base = { accountId: ACCOUNT_ID, productSpaceId: SPACE_ID }
    for (const malformed of [
      { ...base, q: 'x'.repeat(129) },
      { ...base, limit: 0 },
      { ...base, limit: 51 },
      { ...base, cursor: '' },
      { ...base, cursor: 'x'.repeat(257) },
      { ...base, extra: 'field' },
    ]) {
      await expect(invoke(RPC_CHANNELS.projectMembers.LIST_COLLEAGUE_OPTIONS, malformed))
        .rejects.toMatchObject({ code: 'validation_error' })
    }
    expect(calls.colleagueOptions).toEqual([])
  })

  it('enforces the committed-space gates (foreign id / personal space / no fence)', async () => {
    const calls: AdminCalls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()
    const channel = RPC_CHANNELS.projectMembers.LIST_COLLEAGUE_OPTIONS

    await expect(invoke(channel, { accountId: ACCOUNT_ID, productSpaceId: 'space-foreign' }))
      .rejects.toMatchObject({ code: 'forbidden' })

    commitPersonalFence()
    await expect(invoke(channel, { accountId: ACCOUNT_ID, productSpaceId: PERSONAL_SPACE_ID }))
      .rejects.toMatchObject({ code: 'pm_unavailable_in_personal' })

    setRuntimeActiveProductSpace(null)
    await expect(invoke(channel, { accountId: ACCOUNT_ID, productSpaceId: SPACE_ID }))
      .rejects.toMatchObject({ code: PM_PRODUCT_SPACE_CONTEXT_REQUIRED })
    expect(calls.colleagueOptions).toEqual([])
  })
})

describe('pm:listCollaborationRoster — D4 all-role page', () => {
  it('forwards the query and serves a plain member (authority stays admin-side)', async () => {
    const calls: AdminCalls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const response = await invoke(RPC_CHANNELS.projectMembers.LIST_COLLABORATION_ROSTER, {
      accountId: ACCOUNT_ID,
      productSpaceId: SPACE_ID,
      q: '芳',
    })
    expect(response).toEqual(ROSTER_R3)
    expect(response.viewerRole).toBe('member')
    expect(calls.roster).toEqual([{
      productSpaceId: SPACE_ID,
      query: { q: '芳' },
    }])
  })

  it('rejects a foreign space id before any roster read', async () => {
    setProjectMembersAdminForTests(recordingAdmin(emptyCalls()))
    const { invoke } = createHarness()
    await expect(invoke(RPC_CHANNELS.projectMembers.LIST_COLLABORATION_ROSTER, {
      accountId: ACCOUNT_ID,
      productSpaceId: 'space-foreign',
    })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('pm:createColleagueInvitation — D5 per-object bridge', () => {
  const COMMAND = {
    sourceEnterpriseId: SOURCE_ENTERPRISE_ID,
    targetUserId: TARGET_USER_ID,
    createRequestKey: 'pm-colleague-key-1',
  }

  it('forwards the command verbatim — one object per call', async () => {
    const calls: AdminCalls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const response = await invoke(RPC_CHANNELS.projectMembers.CREATE_COLLEAGUE_INVITATION, {
      accountId: ACCOUNT_ID,
      productSpaceId: SPACE_ID,
      command: COMMAND,
    })
    expect(response).toEqual(COLLEAGUE_CREATED)
    expect(calls.createColleague).toEqual([{ productSpaceId: SPACE_ID, command: COMMAND }])
  })

  it('rejects malformed references (non-uuid ids, unknown fields)', async () => {
    const calls: AdminCalls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()
    const channel = RPC_CHANNELS.projectMembers.CREATE_COLLEAGUE_INVITATION

    for (const command of [
      { ...COMMAND, targetUserId: 'not-a-uuid' },
      { ...COMMAND, sourceEnterpriseId: 'not-a-uuid' },
      { ...COMMAND, createRequestKey: '' },
      { ...COMMAND, targetPhone: '13800000000' },
    ]) {
      await expect(invoke(channel, { accountId: ACCOUNT_ID, productSpaceId: SPACE_ID, command }))
        .rejects.toMatchObject({ code: 'validation_error' })
    }
    expect(calls.createColleague).toEqual([])
  })

  it('bridges the D5 error codes verbatim and maps legacy aliases back', async () => {
    const { invoke } = createHarness()
    const channel = RPC_CHANNELS.projectMembers.CREATE_COLLEAGUE_INVITATION
    const input = { accountId: ACCOUNT_ID, productSpaceId: SPACE_ID, command: COMMAND }

    for (const code of [
      'colleague_source_unavailable',
      'colleague_target_unavailable',
      'contract_version_unsupported',
      'target_already_member',
    ]) {
      setProjectMembersAdminForTests(recordingAdmin(emptyCalls(), {
        createColleagueInvitation: async () => { throw new AdminError(code, code as AdminErrorCode) },
      }))
      await expect(invoke(channel, input)).rejects.toMatchObject({ code })
    }

    // The admin client's alias table normalizes forbidden/not_found to the
    // legacy uppercase spelling; the service maps them back onto ONE
    // contract vocabulary for the renderer's recovery copy.
    setProjectMembersAdminForTests(recordingAdmin(emptyCalls(), {
      createColleagueInvitation: async () => { throw new AdminError('no', 'FORBIDDEN') },
    }))
    await expect(invoke(channel, input)).rejects.toMatchObject({ code: 'forbidden' })
    setProjectMembersAdminForTests(recordingAdmin(emptyCalls(), {
      createColleagueInvitation: async () => { throw new AdminError('gone', 'NOT_FOUND') },
    }))
    await expect(invoke(channel, input)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('pm:queryColleagueInvitation — D5 recovery', () => {
  it('queries the caller\'s own key and passes `found` (with optional link) through', async () => {
    const calls: AdminCalls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const receipt = await invoke(RPC_CHANNELS.projectMembers.QUERY_COLLEAGUE_INVITATION, {
      accountId: ACCOUNT_ID,
      productSpaceId: SPACE_ID,
      createRequestKey: 'pm-colleague-key-1',
    })
    expect(receipt).toEqual(COLLEAGUE_RECEIPT)
    expect(calls.queryColleague).toEqual([{ productSpaceId: SPACE_ID, createRequestKey: 'pm-colleague-key-1' }])
  })

  it('passes the `unknown` (202) receipt through as a SUCCESS body', async () => {
    setProjectMembersAdminForTests(recordingAdmin(emptyCalls(), {
      queryColleagueInvitation: async () => ({ state: 'unknown' }),
    }))
    const { invoke } = createHarness()
    const receipt = await invoke(RPC_CHANNELS.projectMembers.QUERY_COLLEAGUE_INVITATION, {
      accountId: ACCOUNT_ID,
      productSpaceId: SPACE_ID,
      createRequestKey: 'pm-colleague-lost',
    })
    expect(receipt).toEqual({ state: 'unknown' })
  })
})

/* ------------------------------------------------------------------ */
/* D6 negotiated list — account-scoped read + v1+R3 composition        */
/* ------------------------------------------------------------------ */

const PERSONAL_ID_V1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const PROJECT_SPACE_V1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const ENT_ID_V1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'

function v1List(overrides: Partial<{ enterpriseCount: number }> = {}): Record<string, unknown> {
  const productSpaces: Array<Record<string, unknown>> = [
    {
      id: PERSONAL_ID_V1,
      kind: 'personal',
      name: '我的空间',
      accessMode: 'active',
      payer: { kind: 'account' },
    },
  ]
  if (overrides.enterpriseCount === undefined || overrides.enterpriseCount > 0) {
    productSpaces.push({
      id: PROJECT_SPACE_V1,
      kind: 'enterprise',
      enterpriseId: ENT_ID_V1,
      name: '华东区销售项目',
      role: 'owner',
      accessMode: 'active',
      payer: { kind: 'enterprise', enterpriseId: ENT_ID_V1 },
    })
  }
  return {
    contractVersion: PRODUCT_SPACE_CONTRACT_VERSION,
    personalProductSpaceId: PERSONAL_ID_V1,
    productSpaces,
  }
}

function r3EnvelopeRaw(spaces: Record<string, unknown>, summaries?: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    contractVersion: CLIENT_ENTERPRISE_CONTRACT_VERSION,
    spaces,
    enterpriseSummaries: summaries ?? [
      { productSpaceId: PROJECT_SPACE_V1, enterpriseId: ENT_ID_V1, enterpriseKind: 'project' },
    ],
  }
}

function r3Envelope(spaces: Record<string, unknown>, summaries?: Array<Record<string, unknown>>): PmProductSpacesListR3Response {
  return PmProductSpacesListR3ResponseSchema.parse(r3EnvelopeRaw(spaces, summaries))
}

describe('pm:listProductSpacesR3 — D6 negotiated read', () => {
  it('is ACCOUNT-scoped: reachable from the personal fence (no enterprise gate)', async () => {
    commitPersonalFence()
    const calls: AdminCalls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const response = await invoke(RPC_CHANNELS.projectMembers.LIST_PRODUCT_SPACES_R3, {
      accountId: ACCOUNT_ID,
    })
    expect(calls.listR3).toBe(1)
    expect(response.contractVersion).toBe(CLIENT_ENTERPRISE_CONTRACT_VERSION)
    expect(response.spaces.contractVersion).toBe(PRODUCT_SPACE_CONTRACT_VERSION)
    expect(response.enterpriseSummaries).toHaveLength(1)
    expect(response.enterpriseSummaries[0]?.enterpriseKind).toBe('project')
  })

  it('rejects a renderer account that is not the trusted account', async () => {
    setProjectMembersAdminForTests(recordingAdmin(emptyCalls()))
    const { invoke } = createHarness()
    await expect(invoke(RPC_CHANNELS.projectMembers.LIST_PRODUCT_SPACES_R3, {
      accountId: ACCOUNT_ID_OTHER,
    })).rejects.toMatchObject({ code: 'pm_scope_changed' })
  })

  it('fails closed with pm_signin_required without a trusted session', async () => {
    setSyncTrustedProductSpaceAccountId(null)
    setTrustedProductSpaceAccountProvider(async () => null)
    setProjectMembersAdminForTests(recordingAdmin(emptyCalls()))
    const { invoke } = createHarness()
    await expect(invoke(RPC_CHANNELS.projectMembers.LIST_PRODUCT_SPACES_R3, {
      accountId: ACCOUNT_ID,
    })).rejects.toMatchObject({ code: 'pm_signin_required' })
  })

  it('surfaces contract_version_unsupported verbatim (deployment without R3)', async () => {
    commitPersonalFence()
    setProjectMembersAdminForTests(recordingAdmin(emptyCalls(), {
      listProductSpacesR3: async () => { throw new AdminError('unsupported', 'contract_version_unsupported') },
    }))
    const { invoke } = createHarness()
    await expect(invoke(RPC_CHANNELS.projectMembers.LIST_PRODUCT_SPACES_R3, {
      accountId: ACCOUNT_ID,
    })).rejects.toMatchObject({ code: 'contract_version_unsupported' })
  })
})

describe('v1+R3 envelope composition (D6 join)', () => {
  it('accepts an exact join: one summary per enterprise space, ids matching', () => {
    const parsed = PmProductSpacesListR3ResponseSchema.safeParse(r3EnvelopeRaw(v1List()))
    expect(parsed.success).toBe(true)
  })

  it('accepts an account with NO enterprise space (empty summaries)', () => {
    const parsed = PmProductSpacesListR3ResponseSchema.safeParse(
      r3EnvelopeRaw(v1List({ enterpriseCount: 0 }), []),
    )
    expect(parsed.success).toBe(true)
  })

  it('rejects a summary MISSING for an enterprise space', () => {
    const parsed = PmProductSpacesListR3ResponseSchema.safeParse(
      r3EnvelopeRaw(v1List(), []),
    )
    expect(parsed.success).toBe(false)
  })

  it('rejects a DUPLICATE summary for the same space', () => {
    const summary = { productSpaceId: PROJECT_SPACE_V1, enterpriseId: ENT_ID_V1, enterpriseKind: 'project' }
    const parsed = PmProductSpacesListR3ResponseSchema.safeParse(
      r3EnvelopeRaw(v1List(), [summary, summary]),
    )
    expect(parsed.success).toBe(false)
  })

  it('rejects an enterpriseId mismatch between summary and space', () => {
    const parsed = PmProductSpacesListR3ResponseSchema.safeParse(
      r3EnvelopeRaw(v1List(), [
        { productSpaceId: PROJECT_SPACE_V1, enterpriseId: 'ent-other', enterpriseKind: 'project' },
      ]),
    )
    expect(parsed.success).toBe(false)
  })

  it('rejects metadata for a space OUTSIDE the enterprise entries (personal)', () => {
    const parsed = PmProductSpacesListR3ResponseSchema.safeParse(
      r3EnvelopeRaw(v1List(), [
        { productSpaceId: PROJECT_SPACE_V1, enterpriseId: ENT_ID_V1, enterpriseKind: 'project' },
        { productSpaceId: PERSONAL_ID_V1, enterpriseId: ENT_ID_V1, enterpriseKind: 'organization' },
      ]),
    )
    expect(parsed.success).toBe(false)
  })

  it('rejects a plain v1 body (the deployment ignored the negotiation)', () => {
    // The old-admin face: default v1 without the R3 envelope. It must fail
    // the composed schema so the caller sees version-unsupported, never a
    // silently degraded "0 projects".
    const parsed = PmProductSpacesListR3ResponseSchema.safeParse(v1List())
    expect(parsed.success).toBe(false)
  })

  it('rejects an unknown enterpriseKind', () => {
    const parsed = PmProductSpacesListR3ResponseSchema.safeParse(
      r3EnvelopeRaw(v1List(), [
        { productSpaceId: PROJECT_SPACE_V1, enterpriseId: ENT_ID_V1, enterpriseKind: 'team' },
      ]),
    )
    expect(parsed.success).toBe(false)
  })
})
