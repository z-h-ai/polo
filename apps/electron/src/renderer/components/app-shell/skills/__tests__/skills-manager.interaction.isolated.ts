import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'

GlobalRegistrator.register()
setupI18n()

mock.module('@/components/ui/skill-avatar', () => ({
  SkillAvatar: () => createElement('span'),
}))
mock.module('@/context/OrganizationContext', () => ({
  useOptionalOrganizationContext: () => null,
}))
mock.module('@polo-ai/ui', () => ({
  Spinner: () => createElement('span', { 'data-testid': 'spinner' }),
}))

const { cleanup, render, screen, fireEvent, waitFor } = await import('@testing-library/react')
const { SkillsManagerPanel } = await import('../SkillsManagerPanel')
const { SkillDetailSheet } = await import('../SkillDetailSheet')
const { SkillInstallSheet } = await import('../SkillInstallSheet')
const typeHelpers = await import('../types')

import type { LoadedSkill } from '../../../../../shared/types'
import type { ManagedSkill } from '../types'

const builtinSkill: ManagedSkill = {
  slug: 'research',
  name: '资料研究',
  description: '查找资料、梳理重点并保留来源。',
  origin: 'builtin',
  originLabel: 'builtin',
  enabled: true,
  restricted: false,
}

const distributedSkill: ManagedSkill = {
  slug: 'growth-cases',
  name: '增长案例检索',
  description: '根据提问检索增长方法，整理可参考的案例。',
  origin: 'circle',
  originLabel: '100-0-0',
  provider: '晨星增长工作室 · 晨星增长圈 / 晨星设计圈',
  installedVersion: '1.0.0',
  enabled: false,
  restricted: false,
}

const revokedSkill: ManagedSkill = {
  ...distributedSkill,
  slug: 'sales-weekly',
  name: '销售周报',
  origin: 'org',
  installedVersion: '1.0.0',
  enabled: false,
  restricted: true,
  restrictedReason: 'revoked',
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

function withI18n(node: React.ReactElement) {
  return createElement(I18nextProvider, { i18n }, node)
}

const noOp = () => {}

describe('SkillsManagerPanel R6 rules', () => {
  it('R6-2: built-in skills can be disabled but never uninstalled', () => {
    render(withI18n(createElement(SkillsManagerPanel, {
      managedSkills: [builtinSkill],
      spaceKind: 'enterprise',
      spaceName: '晨星科技',
      onSkillClick: noOp,
      onDeleteSkill: noOp,
    })))
    expect(screen.getByText('资料研究')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove from this Mac' })).toBeNull()
  })

  it('R6-3: a distributed install shows as disabled with an explicit enable action', () => {
    render(withI18n(createElement(SkillsManagerPanel, {
      managedSkills: [distributedSkill],
      spaceKind: 'personal',
      spaceName: 'My space',
      onSkillClick: noOp,
      onDeleteSkill: noOp,
    })))
    expect(screen.getByText('Disabled')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
  })

  it('R6-4: toggling enable/disable only flips the badge — no navigation, no deletion, no task stop', () => {
    const onSkillClick = mock(() => {})
    const onDeleteSkill = mock(() => {})
    render(withI18n(createElement(SkillsManagerPanel, {
      managedSkills: [distributedSkill],
      spaceKind: 'personal',
      spaceName: 'My space',
      onSkillClick,
      onDeleteSkill,
    })))
    // The rule copy is part of the surface.
    expect(screen.getByText(/running tasks are unaffected/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    // Only the enablement flipped: no other panel action fired.
    expect(onSkillClick).not.toHaveBeenCalled()
    expect(onDeleteSkill).not.toHaveBeenCalled()
    expect(screen.getByText('Enabled')).toBeTruthy()
    expect(screen.queryByText('Disabled')).toBeNull()
  })

  it('R6-7: a revoked source keeps the row with re-verify, reason and uninstall paths', () => {
    render(withI18n(createElement(SkillsManagerPanel, {
      managedSkills: [revokedSkill],
      spaceKind: 'enterprise',
      spaceName: '晨星科技',
      onSkillClick: noOp,
      onDeleteSkill: noOp,
    })))
    expect(screen.getByText('Authorization lost · disabled')).toBeTruthy()
    expect(screen.getByText(/the local copy is kept/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View reason' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Re-verify authorization' })).toBeTruthy()
    // Copy kept: no enable/disable toggle while restricted.
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
  })

  it('discover tab shows both channels and the enterprise share card', () => {
    render(withI18n(createElement(SkillsManagerPanel, {
      managedSkills: [builtinSkill],
      discoverItems: [{
        slug: 'sales-weekly',
        name: '销售周报',
        description: '按团队格式汇总本周进展、风险和下周计划。',
        provider: '晨星科技 · 林晓共享',
        version: '1.0.0',
      }],
      spaceKind: 'enterprise',
      spaceName: '晨星科技',
      initialTab: 'discover',
      onSkillClick: noOp,
      onDeleteSkill: noOp,
    })))
    expect(screen.getByText('Shared library')).toBeTruthy()
    expect(screen.getByText('销售周报')).toBeTruthy()
    expect(screen.getByText('Installable')).toBeTruthy()
    expect(screen.getByText('Share my skill')).toBeTruthy()
  })
})

describe('SkillDetailSheet', () => {
  const detailProps = {
    spaceName: 'My space',
    onToggleEnabled: noOp,
    onUpdate: noOp,
    onReauthorize: noOp,
    onViewRestrictedReason: noOp,
    onRequestUninstall: noOp,
    onConfirmUninstall: noOp,
    onCancelUninstall: noOp,
    onBack: noOp,
  }

  it('R6-2: built-in detail has no uninstall entry', () => {
    render(withI18n(createElement(SkillDetailSheet, {
      ...detailProps,
      skill: builtinSkill,
    })))
    expect(screen.queryByRole('button', { name: 'Remove from this Mac' })).toBeNull()
  })

  it('distributed detail offers update, toggle and uninstall', () => {
    render(withI18n(createElement(SkillDetailSheet, {
      ...detailProps,
      skill: { ...distributedSkill, availableVersion: '1.1.0' },
    })))
    expect(screen.getByText('New version v1.1.0')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Update local version' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove from this Mac' })).toBeTruthy()
  })

  it('R6-5: the uninstall confirmation spells out that only the local copy goes', () => {
    render(withI18n(createElement(SkillDetailSheet, {
      ...detailProps,
      skill: distributedSkill,
      mode: 'confirm-uninstall',
    })))
    expect(screen.getByText('Only removes the copy on this Mac')).toBeTruthy()
    expect(screen.getByText(/Existing conversations, generated files and the shared source content are all kept/)).toBeTruthy()
  })

  it('R6-7: the restricted uninstall confirmation uses dedicated copy', () => {
    render(withI18n(createElement(SkillDetailSheet, {
      ...detailProps,
      skill: revokedSkill,
      mode: 'confirm-uninstall-restricted',
    })))
    expect(screen.getByText("This skill's source authorization has expired")).toBeTruthy()
    expect(screen.getByText(/Removal still only deletes the local copy/)).toBeTruthy()
  })
})

describe('SkillInstallSheet', () => {
  it('R6-3: install review states the default-disabled rule and never auto-enables', () => {
    render(withI18n(createElement(SkillInstallSheet, {
      name: '增长案例检索',
      description: '根据提问检索增长方法，整理可参考的案例。',
      provider: '晨星增长工作室',
      version: '1.0.0',
      spaceKind: 'personal',
      spaceName: 'My space',
      onInstall: noOp,
      onRetry: noOp,
      onBack: noOp,
    })))
    expect(screen.getByText(/Installing does not run any task right away/)).toBeTruthy()
    expect(screen.getByText(/You choose whether to enable it afterwards/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Install on this Mac' })).toBeTruthy()
  })

  it('the failed phase offers retry and back', () => {
    render(withI18n(createElement(SkillInstallSheet, {
      name: '增长案例检索',
      description: '',
      provider: '晨星增长工作室',
      version: '1.0.0',
      spaceKind: 'personal',
      spaceName: 'My space',
      phase: 'failed',
      onInstall: noOp,
      onRetry: noOp,
      onBack: noOp,
    })))
    expect(screen.getByText('Install not completed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry install' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
  })
})

describe('scene-bit helper re-export sanity', () => {
  it('decodes the boundary combination used by the demos', () => {
    expect(typeHelpers.decodeSkillSceneBits('110-1-1')).toEqual({
      version: '1.1.0',
      enabled: true,
      builtin: true,
    })
  })
})

// ============================================================================
// Prototype bit order + real-channel wiring (review fixes)
// ============================================================================

/** Workspace-backed copy so the row carries an executable uninstall channel. */
const workspaceLoadedSkill: LoadedSkill = {
  slug: 'growth-cases',
  metadata: { name: '增长案例检索', description: '根据提问检索增长方法，整理可参考的案例。' },
  content: '',
  path: '/workspace/skills/growth-cases',
  source: 'workspace',
}

describe('prototype bit order: builtin on/off rides the THIRD bit', () => {
  // Mirrors the demo helper (registry builtinSkill): `enabled: bits.builtin`.
  // The second bit belongs to the distributed skill row of the same scene.
  const builtinRowFromBits = (suffix: string): ManagedSkill => ({
    slug: 'research',
    name: '资料研究',
    description: '查找资料、梳理重点并保留来源。',
    origin: 'builtin',
    originLabel: 'builtin',
    enabled: typeHelpers.decodeSkillSceneBits(suffix).builtin,
    restricted: false,
  })

  it("P-M06-SKILLS default '100-0-1' renders the builtin row enabled", () => {
    render(withI18n(createElement(SkillsManagerPanel, {
      managedSkills: [builtinRowFromBits('100-0-1')],
      spaceKind: 'enterprise',
      spaceName: '晨星科技',
      onSkillClick: noOp,
      onDeleteSkill: noOp,
    })))
    expect(screen.getByText('Enabled')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy()
  })

  it("P-M06-BUILTIN-OFF-ENT '100-0-0' renders the builtin row disabled", () => {
    render(withI18n(createElement(SkillsManagerPanel, {
      managedSkills: [builtinRowFromBits('100-0-0')],
      spaceKind: 'enterprise',
      spaceName: '晨星科技',
      onSkillClick: noOp,
      onDeleteSkill: noOp,
    })))
    expect(screen.getByText('Disabled')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove from this Mac' })).toBeNull()
  })
})

describe('uninstall channel gating', () => {
  const detailProps = {
    spaceName: 'My space',
    onToggleEnabled: noOp,
    onUpdate: noOp,
    onReauthorize: noOp,
    onViewRestrictedReason: noOp,
    onRequestUninstall: noOp,
    onCancelUninstall: noOp,
    onBack: noOp,
  }

  it('rows without a real channel render a disabled confirm that never fires', () => {
    const onConfirmUninstall = mock(() => {})
    render(withI18n(createElement(SkillDetailSheet, {
      ...detailProps,
      skill: distributedSkill,
      mode: 'confirm-uninstall',
      onConfirmUninstall,
    })))
    const confirm = screen.getByTestId('confirm-uninstall') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onConfirmUninstall).not.toHaveBeenCalled()
  })

  it('the restricted list row disables uninstall when no channel backs it', () => {
    render(withI18n(createElement(SkillsManagerPanel, {
      managedSkills: [revokedSkill],
      spaceKind: 'enterprise',
      spaceName: '晨星科技',
      onSkillClick: noOp,
      onDeleteSkill: noOp,
    })))
    const uninstall = screen.getByRole('button', { name: 'Remove from this Mac' }) as HTMLButtonElement
    expect(uninstall.disabled).toBe(true)
    expect(uninstall.title).toBe(
      "This skill's source is not managed on this Mac, so it cannot be removed here",
    )
  })

  it('workspace-backed copies uninstall through onDeleteSkill (deleteSkill + creatorSkillUninstall)', () => {
    const onDeleteSkill = mock(() => {})
    render(withI18n(createElement(SkillsManagerPanel, {
      managedSkills: [{ ...distributedSkill, skill: workspaceLoadedSkill }],
      spaceKind: 'personal',
      spaceName: 'My space',
      onDeleteSkill,
    })))
    fireEvent.click(screen.getByRole('button', { name: 'Manage local version' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this Mac' }))
    fireEvent.click(screen.getByTestId('confirm-uninstall'))
    expect(onDeleteSkill).toHaveBeenCalledTimes(1)
    expect(onDeleteSkill).toHaveBeenCalledWith('growth-cases')
  })
})

describe('install flow', () => {
  afterEach(() => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  })

  it('without a channel the install stays self-consistent: new disabled row, discover flips to Manage', async () => {
    render(withI18n(createElement(SkillsManagerPanel, {
      managedSkills: [builtinSkill],
      discoverItems: [{
        slug: 'growth-cases',
        name: '增长案例检索',
        description: '根据提问检索增长方法，整理可参考的案例。',
        provider: '晨星增长工作室',
        version: '1.0.0',
      }],
      spaceKind: 'personal',
      spaceName: 'My space',
      initialTab: 'discover',
      onSkillClick: noOp,
      onDeleteSkill: noOp,
    })))
    fireEvent.click(screen.getByRole('button', { name: 'View & install' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install on this Mac' }))
    // Lands on the local list with a new default-disabled row.
    await waitFor(() => expect(screen.getByText('Disabled')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
    // Back on the discover tab the entry manages an installed copy.
    fireEvent.click(screen.getByRole('button', { name: 'From circles' }))
    expect(screen.getByRole('button', { name: 'Manage local version' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'View & install' })).toBeNull()
  })

  it('wired entries install through the real grant + creatorSkillInstall channel', async () => {
    const grant = mock(async () => ({
      success: true as const,
      artifactId: 'artifact-1',
      organizationId: 'org-1',
      slug: 'sales-weekly',
      version: '1.0.0',
      url: 'https://files.example.com/sales-weekly-1.0.0.tar',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      archiveChecksum: 'a'.repeat(64),
      contentDigest: 'b'.repeat(64),
      manifest: [],
      validationPolicy: 'strict',
    }))
    const install = mock(async () => ({ success: true as const, operationId: 'op-1' }))
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { creatorSkillGetDownloadGrant: grant, creatorSkillInstall: install },
    })
    render(withI18n(createElement(SkillsManagerPanel, {
      skills: [],
      discoverItems: [{
        slug: 'sales-weekly',
        name: '销售周报',
        description: '按团队格式汇总本周进展、风险和下周计划。',
        provider: '晨星科技 · 林晓共享',
        version: '1.0.0',
        installSource: { organizationId: 'org-1', artifactId: 'artifact-1' },
      }],
      spaceKind: 'enterprise',
      spaceName: '晨星科技',
      workspaceId: 'ws-1',
      initialTab: 'discover',
      onSkillClick: noOp,
      onDeleteSkill: noOp,
    })))
    fireEvent.click(screen.getByRole('button', { name: 'View & install' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install on this Mac' }))
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
    expect(grant).toHaveBeenCalledWith({
      organizationId: 'org-1',
      artifactId: 'artifact-1',
      version: '1.0.0',
    })
    expect((install.mock.calls[0] as unknown[])[0]).toMatchObject({
      workspaceId: 'ws-1',
      grant: { artifactId: 'artifact-1', organizationId: 'org-1', slug: 'sales-weekly' },
    })
    await waitFor(() => expect(screen.getByText('Disabled')).toBeTruthy())
  })

  it('a failed grant surfaces the install failure phase with retry', async () => {
    const grant = mock(async () => ({
      success: false,
      errorCode: 'artifact_not_found',
      diagnostic: '',
      retryable: true,
    }))
    const install = mock(async () => ({ success: true as const, operationId: 'op-1' }))
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { creatorSkillGetDownloadGrant: grant, creatorSkillInstall: install },
    })
    render(withI18n(createElement(SkillsManagerPanel, {
      skills: [],
      discoverItems: [{
        slug: 'sales-weekly',
        name: '销售周报',
        description: '按团队格式汇总本周进展、风险和下周计划。',
        provider: '晨星科技 · 林晓共享',
        version: '1.0.0',
        installSource: { organizationId: 'org-1', artifactId: 'artifact-1' },
      }],
      spaceKind: 'enterprise',
      spaceName: '晨星科技',
      workspaceId: 'ws-1',
      initialTab: 'discover',
      onSkillClick: noOp,
      onDeleteSkill: noOp,
    })))
    fireEvent.click(screen.getByRole('button', { name: 'View & install' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install on this Mac' }))
    await waitFor(() => expect(screen.getByText('Install not completed')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Retry install' })).toBeTruthy()
    // The real channel never installed anything: no local row was added.
    expect(screen.queryByText('Enabled')).toBeNull()
  })
})
