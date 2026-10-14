import { describe, expect, it, mock } from 'bun:test'
import { buildAdminPreloadApi } from '../admin-api'
import { RPC_CHANNELS } from '../../shared/types'

describe('ProductSpace Skill native controls reach Main', () => {
  it('forwards only addressing and operation facts, never an account or grant', async () => {
    const calls: unknown[][] = []
    const api = buildAdminPreloadApi({ invoke: mock(async (...args: unknown[]) => { calls.push(args); return { success: true } }), on: mock(() => () => {}) }) as any
    const install = { workspaceId: 'workspace', catalogEntryId: 'entry', operationId: '00000000-0000-4000-8000-000000000001' }
    const uninstall = { workspaceId: 'workspace', subjectKind: 'enterprise_instance', subjectId: 'instance', versionId: 'version', operationId: '00000000-0000-4000-8000-000000000002' }
    await api.productSpaceSetSkillEnablement('space', 'instance', true)
    await api.productSpaceInstallSkill(install)
    await api.productSpaceUninstallSkill(uninstall)
    expect(calls).toEqual([[RPC_CHANNELS.productSpace.SET_SKILL_ENABLEMENT, 'space', 'instance', true], [RPC_CHANNELS.productSpace.INSTALL_SKILL, install], [RPC_CHANNELS.productSpace.UNINSTALL_SKILL, uninstall]])
  })
})
