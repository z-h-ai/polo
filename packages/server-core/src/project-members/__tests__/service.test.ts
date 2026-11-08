import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { AdminError } from '@polo-ai/shared/admin'
import {
  PROJECT_CONTRACT_VERSION,
  type ListOrganizationColleaguesResponse,
  type ListProjectMembersResponse,
  type ListProjectsResponse,
  type ProjectMutationResponse,
  type ProjectSummary,
  type UpdateProjectMemberResponse,
} from '@polo-ai/shared/protocol'
import {
  PM_PRODUCT_SPACE_CONTEXT_REQUIRED,
  pmAddProjectMembers,
  pmCreateProject,
  pmListOrganizationColleagues,
  pmListProductSpacesR3,
  pmListProjectMembers,
  pmListProjects,
  pmRemoveProjectMember,
  pmUpdateProject,
  pmUpdateProjectMember,
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
 * POO-205 project-members service tests.
 *
 * The service seams (setProjectMembersAdminForTests /
 * setProjectMembersActiveProductSpaceReaderForTests) plus the runtime fence
 * and trusted-account setters stand in for the real session state, so the
 * requireOrganizationScope gate (committed enterprise space + matching
 * organization id) and the cross-await CAS run for real inside every call.
 * Authority is never decided locally — the admin adapter seam returns or
 * throws the frozen contract's stable codes.
 */

const ACCOUNT_ID = 'account-1'
const ACCOUNT_ID_OTHER = 'account-2'
const PERSONAL_SPACE_ID = 'space-personal'
const SPACE_ID = 'space-1'
const ORG_ID = 'ent-1'
const PROJECT_ID = 'proj-1'

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

/** The committed-organization scope the renderer asserts (re-proved on every entry). */
const ORG_SCOPE = {
  accountId: ACCOUNT_ID,
  productSpaceId: SPACE_ID,
  organizationEnterpriseId: ORG_ID,
}

const CREATE_COMMAND = {
  name: '华东区销售项目',
  purpose: '集中管理区域销售资料',
  instructions: '优先整理本季度数据',
}

const UPDATE_COMMAND = {
  name: '华东区销售项目（2026）',
}

const ADD_COMMAND = {
  accountIds: ['user-1', 'user-2'],
  role: 'member' as const,
}

const PROJECT_SUMMARY: ProjectSummary = {
  id: PROJECT_ID,
  organizationEnterpriseId: ORG_ID,
  organizationProductSpaceId: SPACE_ID,
  name: '华东区销售项目',
  createdByAccountId: ACCOUNT_ID,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
  myRole: 'owner',
  memberCount: 1,
}

const MUTATION_RESPONSE: ProjectMutationResponse = {
  contractVersion: PROJECT_CONTRACT_VERSION,
  project: PROJECT_SUMMARY,
}

const MEMBERS_RESPONSE: ListProjectMembersResponse = {
  contractVersion: PROJECT_CONTRACT_VERSION,
  projectId: PROJECT_ID,
  members: [{
    accountId: ACCOUNT_ID,
    displayName: '李明',
    role: 'owner',
    createdAt: '2026-11-08T00:00:00.000Z',
  }],
}

const COLLEAGUES_RESPONSE: ListOrganizationColleaguesResponse = {
  contractVersion: PROJECT_CONTRACT_VERSION,
  organizationEnterpriseId: ORG_ID,
  colleagues: [
    { accountId: 'user-1', displayName: '王芳', organizationRole: 'member' },
    { accountId: 'user-2', displayName: null, organizationRole: 'manager' },
  ],
}

const PROJECTS_LIST_RESPONSE: ListProjectsResponse = {
  contractVersion: PROJECT_CONTRACT_VERSION,
  organizationEnterpriseId: ORG_ID,
  projects: [PROJECT_SUMMARY],
}

function errCodeOf(error: unknown): string {
  return ((error ?? {}) as Record<string, unknown>).code as string
}

/** An adapter whose every method fails loudly unless stubbed for the case. */
function unusedAdmin(): ProjectMembersAdmin {
  const boom = () => {
    throw new Error('not used in this test')
  }
  return {
    listProjects: boom,
    createProject: boom,
    updateProject: boom,
    listProjectMembers: boom,
    addProjectMembers: boom,
    updateProjectMember: boom,
    removeProjectMember: boom,
    listOrganizationColleagues: boom,
    listProductSpacesR3: boom,
  }
}

/** Commits a personal-space fence (the R3 list is deliberately reachable here). */
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

/** Commits the committed ENTERPRISE (organization) fence (project precondition). */
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
  commitEnterpriseFence()
})

afterEach(() => {
  resetProjectMembersActiveProductSpaceReaderForTests()
  resetProjectMembersAdminForTests()
  setRuntimeActiveProductSpace(null)
  setSyncTrustedProductSpaceAccountId(null)
  setTrustedProductSpaceAccountProvider(async () => null)
})

describe('pmListProjects — committed-organization gate', () => {
  it('serves the list inside the committed organization, forwarding the re-proved org id', async () => {
    const calls: string[] = []
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      listProjects: async (organizationEnterpriseId: string) => {
        calls.push(organizationEnterpriseId)
        return PROJECTS_LIST_RESPONSE
      },
    })

    const response = await pmListProjects(ORG_SCOPE)
    expect(response.projects).toHaveLength(1)
    expect(response.projects[0]?.id).toBe(PROJECT_ID)
    // The org id is the TRUSTED one read off the committed space, never the
    // renderer's assertion.
    expect(calls).toEqual([ORG_ID])
  })

  it('rejects a space that is not the committed one (renderer cannot probe a foreign id)', async () => {
    setProjectMembersAdminForTests(unusedAdmin())
    try {
      await pmListProjects({ ...ORG_SCOPE, productSpaceId: 'space-foreign' })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('forbidden')
    }
  })

  it('refuses the personal space with pm_unavailable_in_personal', async () => {
    commitPersonalFence()
    setProjectMembersAdminForTests(unusedAdmin())
    try {
      await pmListProjects({ ...ORG_SCOPE, productSpaceId: PERSONAL_SPACE_ID })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_unavailable_in_personal')
    }
  })

  it('requires a committed space at all (PRODUCT_SPACE_CONTEXT_REQUIRED)', async () => {
    setRuntimeActiveProductSpace(null)
    setProjectMembersAdminForTests(unusedAdmin())
    try {
      await pmListProjects(ORG_SCOPE)
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe(PM_PRODUCT_SPACE_CONTEXT_REQUIRED)
    }
  })

  it('rejects an organizationEnterpriseId that is not the committed space\'s enterprise', async () => {
    setProjectMembersAdminForTests(unusedAdmin())
    try {
      await pmListProjects({ ...ORG_SCOPE, organizationEnterpriseId: 'ent-stale' })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_scope_changed')
    }
  })

  it('rejects a renderer account that is not the trusted account', async () => {
    setProjectMembersAdminForTests(unusedAdmin())
    try {
      await pmListProjects({ ...ORG_SCOPE, accountId: ACCOUNT_ID_OTHER })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_scope_changed')
    }
  })

  it('fails closed with pm_signin_required when the trusted session resolver disagrees', async () => {
    // The sync mirror still names the account (so the scope token captures),
    // but the live session resolver returns nobody — no Admin session to act
    // through.
    setTrustedProductSpaceAccountProvider(async () => null)
    setProjectMembersAdminForTests(unusedAdmin())
    try {
      await pmListProjects(ORG_SCOPE)
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_signin_required')
    }
  })

  it('discards the response when an account transition lands mid-flight (race)', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      listProjects: async (): Promise<ListProjectsResponse> => {
        await gate
        return { contractVersion: PROJECT_CONTRACT_VERSION, organizationEnterpriseId: ORG_ID, projects: [] }
      },
    })

    const pending = pmListProjects(ORG_SCOPE)
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
})

describe('pmCreateProject / pmUpdateProject — lightweight lifecycle', () => {
  it('creates with the command verbatim and no payer/payment fields', async () => {
    const calls: Array<{ orgId: string; command: unknown }> = []
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      createProject: async (organizationEnterpriseId: string, command) => {
        calls.push({ orgId: organizationEnterpriseId, command: { ...command } })
        return MUTATION_RESPONSE
      },
    })

    const response = await pmCreateProject({ ...ORG_SCOPE, command: CREATE_COMMAND })
    expect(response).toEqual(MUTATION_RESPONSE)
    expect(calls).toEqual([{ orgId: ORG_ID, command: CREATE_COMMAND }])
    // The wire never carries payer/payment responsibility (retired surface).
    expect(JSON.stringify(calls[0])).not.toContain('paymentResponsibility')
  })

  it('updates with PATCH semantics — only the present fields ride the command', async () => {
    const calls: Array<{ orgId: string; projectId: string; command: unknown }> = []
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      updateProject: async (organizationEnterpriseId: string, projectId: string, command) => {
        calls.push({ orgId: organizationEnterpriseId, projectId, command: { ...command } })
        return MUTATION_RESPONSE
      },
    })

    const response = await pmUpdateProject({ ...ORG_SCOPE, projectId: PROJECT_ID, command: UPDATE_COMMAND })
    expect(response).toEqual(MUTATION_RESPONSE)
    expect(calls).toEqual([{ orgId: ORG_ID, projectId: PROJECT_ID, command: UPDATE_COMMAND }])
  })
})

describe('project member commands — roster-picked, admin-authoritative', () => {
  it('lists members inside the committed organization', async () => {
    const calls: Array<{ orgId: string; projectId: string }> = []
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      listProjectMembers: async (organizationEnterpriseId: string, projectId: string) => {
        calls.push({ orgId: organizationEnterpriseId, projectId })
        return MEMBERS_RESPONSE
      },
    })

    const response = await pmListProjectMembers({ ...ORG_SCOPE, projectId: PROJECT_ID })
    expect(response.members).toHaveLength(1)
    expect(calls).toEqual([{ orgId: ORG_ID, projectId: PROJECT_ID }])
  })

  it('adds roster members in bulk and surfaces prj_member_not_in_organization verbatim', async () => {
    const calls: Array<{ orgId: string; projectId: string; command: unknown }> = []
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      addProjectMembers: async (organizationEnterpriseId: string, projectId: string, command) => {
        calls.push({ orgId: organizationEnterpriseId, projectId, command: { ...command } })
        return MEMBERS_RESPONSE
      },
    })

    const response = await pmAddProjectMembers({ ...ORG_SCOPE, projectId: PROJECT_ID, command: ADD_COMMAND })
    expect(response).toEqual(MEMBERS_RESPONSE)
    expect(calls).toEqual([{ orgId: ORG_ID, projectId: PROJECT_ID, command: ADD_COMMAND }])

    // Membership ⊆ organization is enforced admin-side; the frozen code must
    // survive the mapping untouched.
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      addProjectMembers: async () => {
        throw new AdminError('not a colleague', 'prj_member_not_in_organization')
      },
    })
    try {
      await pmAddProjectMembers({ ...ORG_SCOPE, projectId: PROJECT_ID, command: ADD_COMMAND })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('prj_member_not_in_organization')
    }
  })

  it('changes a member role and surfaces prj_last_owner verbatim', async () => {
    const calls: Array<{ orgId: string; projectId: string; accountId: string; role: string }> = []
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      updateProjectMember: async (
        organizationEnterpriseId: string,
        projectId: string,
        accountId: string,
        input,
      ): Promise<UpdateProjectMemberResponse> => {
        calls.push({ orgId: organizationEnterpriseId, projectId, accountId, role: input.role })
        return {
          contractVersion: PROJECT_CONTRACT_VERSION,
          member: { ...MEMBERS_RESPONSE.members[0]!, role: 'manager' },
        }
      },
    })

    const response = await pmUpdateProjectMember({
      ...ORG_SCOPE,
      projectId: PROJECT_ID,
      targetAccountId: 'user-1',
      role: 'manager',
    })
    expect(response.member.role).toBe('manager')
    expect(calls).toEqual([{ orgId: ORG_ID, projectId: PROJECT_ID, accountId: 'user-1', role: 'manager' }])

    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      updateProjectMember: async () => {
        throw new AdminError('last owner', 'prj_last_owner')
      },
    })
    try {
      await pmUpdateProjectMember({
        ...ORG_SCOPE,
        projectId: PROJECT_ID,
        targetAccountId: ACCOUNT_ID,
        role: 'member',
      })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('prj_last_owner')
    }
  })

  it('removes a member from the project only and maps prj_not_found verbatim', async () => {
    const calls: Array<{ orgId: string; projectId: string; accountId: string }> = []
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      removeProjectMember: async (organizationEnterpriseId: string, projectId: string, accountId: string) => {
        calls.push({ orgId: organizationEnterpriseId, projectId, accountId })
        return { ok: true as const }
      },
    })

    const response = await pmRemoveProjectMember({
      ...ORG_SCOPE,
      projectId: PROJECT_ID,
      targetAccountId: 'user-1',
    })
    expect(response).toEqual({ ok: true })
    expect(calls).toEqual([{ orgId: ORG_ID, projectId: PROJECT_ID, accountId: 'user-1' }])

    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      removeProjectMember: async () => {
        throw new AdminError('gone', 'prj_not_found')
      },
    })
    try {
      await pmRemoveProjectMember({ ...ORG_SCOPE, projectId: PROJECT_ID, targetAccountId: 'user-x' })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('prj_not_found')
    }
  })

  it('lists organization colleagues (the only roster) and folds legacy aliases back', async () => {
    const calls: string[] = []
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      listOrganizationColleagues: async (organizationEnterpriseId: string) => {
        calls.push(organizationEnterpriseId)
        return COLLEAGUES_RESPONSE
      },
    })

    const response = await pmListOrganizationColleagues(ORG_SCOPE)
    expect(response.colleagues).toHaveLength(2)
    expect(calls).toEqual([ORG_ID])

    // The admin alias table normalizes session-level 403 to the uppercase
    // legacy spelling; the service folds it back onto ONE vocabulary.
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      listOrganizationColleagues: async () => {
        throw new AdminError('no', 'FORBIDDEN')
      },
    })
    try {
      await pmListOrganizationColleagues(ORG_SCOPE)
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('forbidden')
    }
  })

  it('maps admin unavailability to stable pm_* codes (signed out vs unreachable)', async () => {
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      listProjects: async () => {
        throw new ProjectMembersAdminUnavailableError('pm_signed_out', 'no session')
      },
    })
    try {
      await pmListProjects(ORG_SCOPE)
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_signin_required')
    }

    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      listProjects: async () => {
        throw new ProjectMembersAdminUnavailableError('pm_admin_unreachable', 'down')
      },
    })
    try {
      await pmListProjects(ORG_SCOPE)
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_service_unavailable')
    }
  })
})

describe('pmListProductSpacesR3 — retained account-scoped read (D6)', () => {
  it('is ACCOUNT-scoped: reachable from the personal fence (no enterprise gate)', async () => {
    commitPersonalFence()
    let calls = 0
    setProjectMembersAdminForTests({
      ...unusedAdmin(),
      listProductSpacesR3: async () => {
        calls += 1
        return {
          contractVersion: 'poo196-contract-r3',
          spaces: {
            contractVersion: '2025-11-27',
            personalProductSpaceId: PERSONAL_SPACE_ID,
            productSpaces: [PERSONAL_SPACE],
          },
          enterpriseSummaries: [],
        } as unknown as Awaited<ReturnType<ProjectMembersAdmin['listProductSpacesR3']>>
      },
    })

    const response = await pmListProductSpacesR3({ accountId: ACCOUNT_ID })
    expect(calls).toBe(1)
    expect(response.enterpriseSummaries).toHaveLength(0)
  })

  it('rejects a renderer account that is not the trusted account', async () => {
    setProjectMembersAdminForTests(unusedAdmin())
    try {
      await pmListProductSpacesR3({ accountId: ACCOUNT_ID_OTHER })
      expect.unreachable()
    } catch (error) {
      expect(errCodeOf(error)).toBe('pm_scope_changed')
    }
  })
})
