import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { AdminError, type AdminErrorCode } from '@polo-ai/shared/admin'
import { CLIENT_ENTERPRISE_CONTRACT_VERSION } from '@polo-ai/shared/admin/client-enterprise-contract'
import {
  RPC_CHANNELS,
  PmProductSpacesListR3ResponseSchema,
  PROJECT_CONTRACT_VERSION,
} from '@polo-ai/shared/protocol'
import { PRODUCT_SPACE_CONTRACT_VERSION } from '@polo-ai/shared/product-spaces'
import type { HandlerFn, RpcServer } from '@polo-ai/server-core/transport'
import type {
  ListOrganizationColleaguesResponse,
  ListProjectMembersResponse,
  ListProjectsResponse,
  PmProductSpacesListR3Response,
  ProjectMutationResponse,
  UpdateProjectMemberResponse,
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
 * POO-205 project-members RPC contract tests (plus the retained R3 list read
 * per POO-196 redesign D6). The harness registers the REAL handlers against a
 * capture RpcServer and stands in the runtime fence + trusted session the
 * service gates re-prove, so the full renderer→handler→admin-adapter chain
 * runs for real:
 *
 * - channel closure: the manifest matches RPC_CHANNELS.projectMembers and
 *   every channel is registered exactly once;
 * - call shapes: each channel forwards the parsed protocol input to the
 *   adapter with the admin HTTP call's exact argument shape;
 * - error bridge: the frozen poo205-contract-r1 codes (prj_forbidden,
 *   prj_not_found, prj_member_not_in_organization, prj_last_owner) survive
 *   verbatim and the legacy uppercase aliases still map back onto ONE
 *   contract vocabulary;
 * - gates: every project channel is committed-organization scoped
 *   (productSpaceId IS the committed enterprise space AND
 *   organizationEnterpriseId matches it); the negotiated R3 list is
 *   ACCOUNT-scoped (reachable from the personal space, D6);
 * - composition: the v1+R3 envelope join validates exactly (D6).
 */

const ACCOUNT_ID = 'account-1'
const ACCOUNT_ID_OTHER = 'account-2'
const PERSONAL_SPACE_ID = 'space-personal'
const SPACE_ID = 'space-1'
const ORG_ID = 'ent-1'
const PROJECT_ID = 'proj-1'
const TARGET_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'

const ENTERPRISE_SPACE = {
  id: SPACE_ID,
  kind: 'enterprise',
  enterpriseId: ORG_ID,
  name: '华东区组织',
  role: 'owner',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: ORG_ID },
} as unknown as TrustedProductSpaceSummary

const PERSONAL_SPACE = {
  id: PERSONAL_SPACE_ID,
  kind: 'personal',
  name: '我的空间',
  accessMode: 'active',
  payer: { kind: 'account', accountId: ACCOUNT_ID },
} as unknown as TrustedProductSpaceSummary

const ORG_SCOPE = {
  accountId: ACCOUNT_ID,
  productSpaceId: SPACE_ID,
  organizationEnterpriseId: ORG_ID,
}

const PROJECT_SUMMARY = {
  id: PROJECT_ID,
  organizationEnterpriseId: ORG_ID,
  organizationProductSpaceId: SPACE_ID,
  name: '华东区销售项目',
  createdByAccountId: ACCOUNT_ID,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
  myRole: 'owner' as const,
  memberCount: 2,
}

const MUTATION: ProjectMutationResponse = {
  contractVersion: PROJECT_CONTRACT_VERSION,
  project: PROJECT_SUMMARY,
}

const MEMBERS: ListProjectMembersResponse = {
  contractVersion: PROJECT_CONTRACT_VERSION,
  projectId: PROJECT_ID,
  members: [
    { accountId: ACCOUNT_ID, displayName: '李明', role: 'owner', createdAt: '2026-11-08T00:00:00.000Z' },
    { accountId: TARGET_ACCOUNT_ID, displayName: '王芳', role: 'member', createdAt: '2026-11-08T00:00:00.000Z' },
  ],
}

const MEMBER_UPDATED: UpdateProjectMemberResponse = {
  contractVersion: PROJECT_CONTRACT_VERSION,
  member: { ...MEMBERS.members[1]!, role: 'manager' as const },
}

const COLLEAGUES: ListOrganizationColleaguesResponse = {
  contractVersion: PROJECT_CONTRACT_VERSION,
  organizationEnterpriseId: ORG_ID,
  colleagues: [
    { accountId: ACCOUNT_ID, displayName: '李明', organizationRole: 'owner' },
    { accountId: TARGET_ACCOUNT_ID, displayName: '王芳', organizationRole: 'member' },
  ],
}

const PROJECTS_LIST: ListProjectsResponse = {
  contractVersion: PROJECT_CONTRACT_VERSION,
  organizationEnterpriseId: ORG_ID,
  projects: [PROJECT_SUMMARY],
}

/** Committed ENTERPRISE (organization) fence — every project command's precondition. */
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
  listProjects: string[]
  createProject: Array<{ orgId: string; command: Record<string, unknown> }>
  updateProject: Array<{ orgId: string; projectId: string; command: Record<string, unknown> }>
  listProjectMembers: Array<{ orgId: string; projectId: string }>
  addProjectMembers: Array<{ orgId: string; projectId: string; command: Record<string, unknown> }>
  updateProjectMember: Array<{ orgId: string; projectId: string; accountId: string; input: Record<string, unknown> }>
  removeProjectMember: Array<{ orgId: string; projectId: string; accountId: string }>
  listOrganizationColleagues: string[]
  listR3: number
}

function recordingAdmin(calls: AdminCalls, overrides: Partial<ProjectMembersAdmin> = {}): ProjectMembersAdmin {
  const notUsed = () => {
    throw new Error('not used in this test')
  }
  return {
    listProjects: async (organizationEnterpriseId: string) => {
      calls.listProjects.push(organizationEnterpriseId)
      return PROJECTS_LIST
    },
    createProject: async (organizationEnterpriseId: string, input: Record<string, unknown>) => {
      calls.createProject.push({ orgId: organizationEnterpriseId, command: { ...input } })
      return MUTATION
    },
    updateProject: async (organizationEnterpriseId: string, projectId: string, input: Record<string, unknown>) => {
      calls.updateProject.push({ orgId: organizationEnterpriseId, projectId, command: { ...input } })
      return MUTATION
    },
    listProjectMembers: async (organizationEnterpriseId: string, projectId: string) => {
      calls.listProjectMembers.push({ orgId: organizationEnterpriseId, projectId })
      return MEMBERS
    },
    addProjectMembers: async (organizationEnterpriseId: string, projectId: string, input: Record<string, unknown>) => {
      calls.addProjectMembers.push({ orgId: organizationEnterpriseId, projectId, command: { ...input } })
      return MEMBERS
    },
    updateProjectMember: async (
      organizationEnterpriseId: string,
      projectId: string,
      accountId: string,
      input: Record<string, unknown>,
    ) => {
      calls.updateProjectMember.push({ orgId: organizationEnterpriseId, projectId, accountId, input: { ...input } })
      return MEMBER_UPDATED
    },
    removeProjectMember: async (organizationEnterpriseId: string, projectId: string, accountId: string) => {
      calls.removeProjectMember.push({ orgId: organizationEnterpriseId, projectId, accountId })
      return { ok: true as const }
    },
    listOrganizationColleagues: async (organizationEnterpriseId: string) => {
      calls.listOrganizationColleagues.push(organizationEnterpriseId)
      return COLLEAGUES
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
    listProjects: [],
    createProject: [],
    updateProject: [],
    listProjectMembers: [],
    addProjectMembers: [],
    updateProjectMember: [],
    removeProjectMember: [],
    listOrganizationColleagues: [],
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

describe('channel closure (POO-205 + retained R3)', () => {
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

describe('pm:listProjects / pm:createProject / pm:updateProject', () => {
  it('forwards the re-proved organization id and returns the list', async () => {
    const calls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const response = await invoke(RPC_CHANNELS.projectMembers.LIST_PROJECTS, ORG_SCOPE)
    expect(response).toEqual(PROJECTS_LIST)
    expect(calls.listProjects).toEqual([ORG_ID])
  })

  it('forwards the create command verbatim — no payer, no invitation fields', async () => {
    const calls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const command = { name: '华东区销售项目', purpose: '集中管理', instructions: '先整理本季度数据' }
    const response = await invoke(RPC_CHANNELS.projectMembers.CREATE_PROJECT, { ...ORG_SCOPE, command })
    expect(response).toEqual(MUTATION)
    expect(calls.createProject).toEqual([{ orgId: ORG_ID, command }])
    expect(JSON.stringify(calls.createProject[0])).not.toContain('paymentResponsibility')
  })

  it('forwards PATCH update with only the present fields', async () => {
    const calls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const command = { name: '华东区销售项目（2026）' }
    const response = await invoke(RPC_CHANNELS.projectMembers.UPDATE_PROJECT, {
      ...ORG_SCOPE,
      projectId: PROJECT_ID,
      command,
    })
    expect(response).toEqual(MUTATION)
    expect(calls.updateProject).toEqual([{ orgId: ORG_ID, projectId: PROJECT_ID, command }])
  })

  it('rejects bound violations before the adapter is touched', async () => {
    const calls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    for (const malformed of [
      { ...ORG_SCOPE, extra: 'field' },
      { ...ORG_SCOPE, command: { name: '' } },
      { ...ORG_SCOPE, command: { name: 'x'.repeat(257) } },
      { ...ORG_SCOPE, command: { name: 'ok', unknown: true } },
    ]) {
      await expect(invoke(RPC_CHANNELS.projectMembers.CREATE_PROJECT, malformed))
        .rejects.toMatchObject({ code: 'validation_error' })
    }
    expect(calls.createProject).toEqual([])
  })
})

describe('pm:listProjectMembers / pm:addProjectMembers / pm:updateProjectMember / pm:removeProjectMember', () => {
  it('lists members for the committed organization + project', async () => {
    const calls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const response = await invoke(RPC_CHANNELS.projectMembers.LIST_PROJECT_MEMBERS, {
      ...ORG_SCOPE,
      projectId: PROJECT_ID,
    })
    expect(response).toEqual(MEMBERS)
    expect(calls.listProjectMembers).toEqual([{ orgId: ORG_ID, projectId: PROJECT_ID }])
  })

  it('adds roster members in bulk — the wire carries the whole command once', async () => {
    const calls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const command = { accountIds: [TARGET_ACCOUNT_ID], role: 'member' }
    const response = await invoke(RPC_CHANNELS.projectMembers.ADD_PROJECT_MEMBERS, {
      ...ORG_SCOPE,
      projectId: PROJECT_ID,
      command,
    })
    expect(response).toEqual(MEMBERS)
    expect(calls.addProjectMembers).toEqual([{ orgId: ORG_ID, projectId: PROJECT_ID, command }])
  })

  it('rejects malformed member adds (empty/oversized batch, bad role, unknown fields)', async () => {
    const calls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()
    const channel = RPC_CHANNELS.projectMembers.ADD_PROJECT_MEMBERS

    for (const command of [
      { accountIds: [], role: 'member' },
      { accountIds: Array.from({ length: 101 }, (_, i) => `user-${i}`), role: 'member' },
      { accountIds: [TARGET_ACCOUNT_ID], role: 'admin' },
      { accountIds: [TARGET_ACCOUNT_ID], role: 'member', createRequestKey: 'k' },
    ]) {
      await expect(invoke(channel, { ...ORG_SCOPE, projectId: PROJECT_ID, command }))
        .rejects.toMatchObject({ code: 'validation_error' })
    }
    expect(calls.addProjectMembers).toEqual([])
  })

  it('changes a member role via PATCH on the member resource', async () => {
    const calls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const response = await invoke(RPC_CHANNELS.projectMembers.UPDATE_PROJECT_MEMBER, {
      ...ORG_SCOPE,
      projectId: PROJECT_ID,
      targetAccountId: TARGET_ACCOUNT_ID,
      role: 'manager',
    })
    expect(response).toEqual(MEMBER_UPDATED)
    expect(calls.updateProjectMember).toEqual([{
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      accountId: TARGET_ACCOUNT_ID,
      input: { role: 'manager' },
    }])
  })

  it('removes a member from the project only', async () => {
    const calls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const response = await invoke(RPC_CHANNELS.projectMembers.REMOVE_PROJECT_MEMBER, {
      ...ORG_SCOPE,
      projectId: PROJECT_ID,
      targetAccountId: TARGET_ACCOUNT_ID,
    })
    expect(response).toEqual({ ok: true })
    expect(calls.removeProjectMember).toEqual([{ orgId: ORG_ID, projectId: PROJECT_ID, accountId: TARGET_ACCOUNT_ID }])
  })

  it('lists organization colleagues — the only roster a project picks from', async () => {
    const calls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const response = await invoke(RPC_CHANNELS.projectMembers.LIST_ORGANIZATION_COLLEAGUES, ORG_SCOPE)
    expect(response).toEqual(COLLEAGUES)
    expect(calls.listOrganizationColleagues).toEqual([ORG_ID])
  })

  it('bridges the frozen prj_* codes verbatim and folds legacy aliases back', async () => {
    const { invoke } = createHarness()

    const cases: Array<{
      channel: string
      input: Record<string, unknown>
      errorCode: AdminErrorCode
      expected: string
    }> = [
      {
        channel: RPC_CHANNELS.projectMembers.ADD_PROJECT_MEMBERS,
        input: { ...ORG_SCOPE, projectId: PROJECT_ID, command: { accountIds: [TARGET_ACCOUNT_ID], role: 'member' } },
        errorCode: 'prj_member_not_in_organization',
        expected: 'prj_member_not_in_organization',
      },
      {
        channel: RPC_CHANNELS.projectMembers.UPDATE_PROJECT_MEMBER,
        input: { ...ORG_SCOPE, projectId: PROJECT_ID, targetAccountId: ACCOUNT_ID, role: 'member' },
        errorCode: 'prj_last_owner',
        expected: 'prj_last_owner',
      },
      {
        channel: RPC_CHANNELS.projectMembers.REMOVE_PROJECT_MEMBER,
        input: { ...ORG_SCOPE, projectId: PROJECT_ID, targetAccountId: TARGET_ACCOUNT_ID },
        errorCode: 'prj_not_found',
        expected: 'prj_not_found',
      },
      {
        channel: RPC_CHANNELS.projectMembers.LIST_ORGANIZATION_COLLEAGUES,
        input: ORG_SCOPE,
        errorCode: 'FORBIDDEN',
        expected: 'forbidden',
      },
    ]

    for (const { channel, input, errorCode, expected } of cases) {
      const failing = recordingAdmin(emptyCalls(), {
        listProjects: async () => { throw new AdminError('x', errorCode) },
        addProjectMembers: async () => { throw new AdminError('x', errorCode) },
        updateProjectMember: async () => { throw new AdminError('x', errorCode) },
        removeProjectMember: async () => { throw new AdminError('x', errorCode) },
        listOrganizationColleagues: async () => { throw new AdminError('x', errorCode) },
      })
      setProjectMembersAdminForTests(failing)
      await expect(invoke(channel, input)).rejects.toMatchObject({ code: expected })
    }
  })
})

describe('committed-organization gates through the handler layer', () => {
  it('enforces the committed-space / organization-id / personal / no-fence gates', async () => {
    const calls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()
    const channel = RPC_CHANNELS.projectMembers.LIST_PROJECTS

    // A foreign space id is not the committed one.
    await expect(invoke(channel, { ...ORG_SCOPE, productSpaceId: 'space-foreign' }))
      .rejects.toMatchObject({ code: 'forbidden' })

    // A stale organization id fails the consistency re-proof.
    await expect(invoke(channel, { ...ORG_SCOPE, organizationEnterpriseId: 'ent-stale' }))
      .rejects.toMatchObject({ code: 'pm_scope_changed' })

    // The personal space never carries projects.
    commitPersonalFence()
    await expect(invoke(channel, { ...ORG_SCOPE, productSpaceId: PERSONAL_SPACE_ID }))
      .rejects.toMatchObject({ code: 'pm_unavailable_in_personal' })

    // No committed fence at all.
    setRuntimeActiveProductSpace(null)
    await expect(invoke(channel, ORG_SCOPE))
      .rejects.toMatchObject({ code: PM_PRODUCT_SPACE_CONTEXT_REQUIRED })
    expect(calls.listProjects).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* Retained R3 negotiated list — account-scoped read + v1+R3 join (D6) */
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
      name: '华东区组织',
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
      { productSpaceId: PROJECT_SPACE_V1, enterpriseId: ENT_ID_V1, enterpriseKind: 'organization' },
    ],
  }
}

function r3Envelope(spaces: Record<string, unknown>, summaries?: Array<Record<string, unknown>>): PmProductSpacesListR3Response {
  return PmProductSpacesListR3ResponseSchema.parse(r3EnvelopeRaw(spaces, summaries))
}

describe('pm:listProductSpacesR3 — retained D6 negotiated read', () => {
  it('is ACCOUNT-scoped: reachable from the personal fence (no enterprise gate)', async () => {
    commitPersonalFence()
    const calls = emptyCalls()
    setProjectMembersAdminForTests(recordingAdmin(calls))
    const { invoke } = createHarness()

    const response = await invoke(RPC_CHANNELS.projectMembers.LIST_PRODUCT_SPACES_R3, {
      accountId: ACCOUNT_ID,
    })
    expect(calls.listR3).toBe(1)
    expect(response.contractVersion).toBe(CLIENT_ENTERPRISE_CONTRACT_VERSION)
    expect(response.spaces.contractVersion).toBe(PRODUCT_SPACE_CONTRACT_VERSION)
    expect(response.enterpriseSummaries).toHaveLength(1)
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
    const summary = { productSpaceId: PROJECT_SPACE_V1, enterpriseId: ENT_ID_V1, enterpriseKind: 'organization' }
    const parsed = PmProductSpacesListR3ResponseSchema.safeParse(
      r3EnvelopeRaw(v1List(), [summary, summary]),
    )
    expect(parsed.success).toBe(false)
  })

  it('rejects an enterpriseId mismatch between summary and space', () => {
    const parsed = PmProductSpacesListR3ResponseSchema.safeParse(
      r3EnvelopeRaw(v1List(), [
        { productSpaceId: PROJECT_SPACE_V1, enterpriseId: 'ent-other', enterpriseKind: 'organization' },
      ]),
    )
    expect(parsed.success).toBe(false)
  })

  it('rejects metadata for a space OUTSIDE the enterprise entries (personal)', () => {
    const parsed = PmProductSpacesListR3ResponseSchema.safeParse(
      r3EnvelopeRaw(v1List(), [
        { productSpaceId: PROJECT_SPACE_V1, enterpriseId: ENT_ID_V1, enterpriseKind: 'organization' },
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
