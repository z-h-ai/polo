import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactNode } from 'react'
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

const { cleanup, render, screen } = await import('@testing-library/react')
// The legacy SkillsListPanel was replaced by the skills manager panel
// (POO-70 HiFi WS-ASSISTANT-SKILLS); the stale-safety badge moved with it.
const { SkillsManagerPanel } = await import('../../app-shell/skills/SkillsManagerPanel')
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
    render(withI18n(createElement(SkillsManagerPanel, {
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
