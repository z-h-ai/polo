import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@z-h-ai/shared/i18n/setupI18n'

GlobalRegistrator.register()
setupI18n()

mock.module('@/components/ui/entity-panel', () => ({
  EntityPanel: ({ items, mapItem }: {
    items: unknown[]
    mapItem: (item: unknown) => { title: ReactNode; badges?: ReactNode }
  }) => createElement(
    'div',
    null,
    ...items.map((item, index) => {
      const mapped = mapItem(item)
      return createElement('div', { key: index }, mapped.title, mapped.badges)
    }),
  ),
}))
mock.module('@/components/ui/entity-list-empty', () => ({
  EntityListEmptyScreen: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))
mock.module('@/components/ui/skill-avatar', () => ({
  SkillAvatar: () => createElement('span'),
}))
mock.module('@/components/app-shell/SkillMenu', () => ({
  SkillMenu: () => createElement('span'),
}))
mock.module('@/components/app-shell/SendResourceToWorkspaceDialog', () => ({
  SendResourceToWorkspaceDialog: () => null,
}))
mock.module('@/components/ui/EditPopover', () => ({
  EditPopover: () => null,
  getEditConfig: () => ({}),
}))
mock.module('@/context/AppShellContext', () => ({
  useActiveWorkspace: () => ({ remoteServer: false }),
  useAppShellContext: () => ({
    workspaces: [{ id: 'workspace-one' }],
    activeWorkspaceId: 'workspace-one',
  }),
}))

const { cleanup, render, screen } = await import('@testing-library/react')
const { SkillsListPanel } = await import('../../app-shell/SkillsListPanel')
const { InlineSkillMention } = await import('../skill-mention-menu')

const skill = {
  slug: 'review-skill',
  metadata: { name: 'Review Skill', description: 'Review.' },
  content: 'Instructions.',
  path: '/workspace/skills/review-skill',
  source: 'workspace' as const,
  creatorSafetyCheckStatus: 'failed' as const,
  creatorInstallation: {
    artifactId: 'artifact-one',
    organizationId: 'organization-one',
    slug: 'review-skill',
    version: '1.0.0',
    archiveChecksum: 'a'.repeat(64),
    contentDigest: 'b'.repeat(64),
    installedAt: '2026-07-30T00:00:00.000Z',
    lastKnownStatus: 'active' as const,
    lastCheckedAt: new Date().toISOString(),
  },
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

function withI18n(node: ReactNode) {
  return createElement(I18nextProvider, { i18n }, node)
}

describe('Creator Skill failed safety surfaces', () => {
  it('renders the failed current check in the Skill list and @ candidate', () => {
    render(withI18n(createElement(SkillsListPanel, {
      skills: [skill],
      onDeleteSkill: () => {},
      onSkillClick: () => {},
      workspaceId: 'workspace-one',
    })))
    expect(screen.getByText('Safety status could not be refreshed')).toBeTruthy()

    cleanup()
    render(withI18n(createElement(InlineSkillMention, {
      open: true,
      onOpenChange: () => {},
      skills: [skill],
      onSelect: () => {},
      position: { x: 100, y: 100 },
      workspaceId: 'workspace-one',
    })))
    expect(screen.getByText('Safety status could not be refreshed')).toBeTruthy()
  })
})
