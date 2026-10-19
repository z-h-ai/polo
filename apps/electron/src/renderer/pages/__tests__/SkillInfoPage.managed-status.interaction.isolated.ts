import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactNode } from 'react'
import { createStore, Provider } from 'jotai'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'

GlobalRegistrator.register()
setupI18n()

mock.module('@/components/info', () => {
  const Page = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
  Page.Header = ({ title, titleMenu }: { title: string; titleMenu?: ReactNode }) =>
    createElement('header', null, title, titleMenu)
  Page.Content = ({ children }: { children?: ReactNode }) =>
    createElement('main', null, children)
  Page.Hero = ({ title, tagline }: { title: string; tagline?: string }) =>
    createElement('section', null, title, tagline)
  const Section = ({ children }: { children?: ReactNode }) =>
    createElement('section', null, children)
  const Table = ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children)
  Table.Row = ({ label, value, children }: {
    label: string
    value?: ReactNode
    children?: ReactNode
  }) => createElement('div', null, label, value, children)
  return {
    Info_Page: Page,
    Info_Section: Section,
    Info_Table: Table,
    Info_Markdown: ({ children }: { children?: ReactNode }) =>
      createElement('pre', null, children),
  }
})
mock.module('@/components/app-shell/SkillMenu', () => ({
  SkillMenu: ({ onDelete }: { onDelete?: () => void }) => (
    createElement('button', { type: 'button', onClick: onDelete }, 'Delete Skill')
  ),
}))
mock.module('@/components/ui/skill-avatar', () => ({
  SkillAvatar: () => createElement('span'),
}))
mock.module('@/components/ui/EditPopover', () => ({
  EditPopover: ({ trigger }: { trigger?: ReactNode }) => createElement('span', null, trigger),
  EditButton: () => createElement('button', { type: 'button' }, 'Edit'),
  getEditConfig: () => ({}),
}))
mock.module('@/context/AppShellContext', () => ({
  useActiveWorkspace: () => ({ id: 'workspace-one', remoteServer: false }),
}))
mock.module('@/lib/navigate', () => ({
  navigate: mock(() => {}),
  routes: { view: { skills: () => '/skills' } },
}))
mock.module('@/lib/platform', () => ({
  getFileManagerName: () => 'Finder',
}))
mock.module('sonner', () => ({
  toast: {
    error: mock(() => {}),
    success: mock(() => {}),
  },
}))

const { cleanup, render, screen } = await import('@testing-library/react')
const { default: SkillInfoPage } = await import('../SkillInfoPage')

function baseSkill(slug: string, name: string, source: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    metadata: { name, description: `${name} description` },
    content: 'Instructions.',
    path: `/workspace-one/skills/${slug}`,
    source,
    ...extra,
  }
}

const DISABLED_HINT = 'This skill is disabled for this account and workspace. New sessions will not see it; running sessions keep their locked version.'
const SHADOW_HINT = 'This skill overrides a bundled skill with the same name. It cannot be disabled; deleting it restores the bundled version.'

let skills: Array<Record<string, unknown>>
let managedStatuses: Array<Record<string, unknown>>

beforeEach(async () => {
  await i18n.changeLanguage('en')
  skills = []
  managedStatuses = []
  window.confirm = mock(() => false)
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getSkills: async () => skills,
      // Read-only enablement facts for the detail page.
      listManagedSkills: async () => ({
        ok: true as const,
        workspaceId: 'workspace-one',
        revision: 0,
        items: managedStatuses,
      }),
      setManagedSkillEnablement: async () => ({ ok: true as const, slug: '', enabled: true, revision: 1 }),
      onSkillsChanged: () => () => {},
      onCreatorSkillProgress: () => () => {},
      creatorSkillGetSafetyStatus: async () => ({
        success: true as const,
        artifactId: 'artifact-one',
        version: '1.0.0',
        archiveChecksum: 'a'.repeat(64),
        status: 'active',
      }),
      creatorSkillUpdateSafetyStatus: async () => ({ success: true as const }),
      creatorSkillIgnoreVersion: async () => ({ success: true as const }),
      creatorSkillGetDownloadGrant: async () => ({ success: false as const, errorCode: 'temporary_network_failure' }),
      creatorSkillInstall: async () => ({ success: true as const, operationId: 'op' }),
      creatorSkillCancel: async () => ({ success: true as const }),
      deleteSkill: () => ({ managed: false }),
      showInFolder: async () => {},
      openUrl: async () => {},
    },
  })
})

afterEach(() => {
  cleanup()
})

/**
 * Info_Table.Row renders label and value into one div, so the Availability
 * row's text content is the label and value concatenated.
 */
function availabilityRow(value: string) {
  return screen.getByText((_, element) => element?.textContent === `Availability${value}`)
}

function renderPage(skillSlug: string) {
  return render(createElement(
    Provider,
    { store: createStore() },
    createElement(
      I18nextProvider,
      { i18n },
      createElement(SkillInfoPage, {
        skillSlug,
        workspaceId: 'workspace-one',
        sessionId: 'session-one',
      }),
    ),
  ))
}

describe('SkillInfoPage read-only enablement status (POO-106 S1)', () => {
  it('reports a bundled skill as always available and hosts no toggle (SM-18a)', async () => {
    skills = [baseSkill('bundled-one', 'Bundled One', 'bundled')]
    managedStatuses = [
      { slug: 'bundled-one', source: 'bundled', enabled: true, toggleable: false, managed: false, shadowedBuiltin: false },
    ]
    renderPage('bundled-one')

    expect(await screen.findByText('Bundled One')).toBeTruthy()
    expect(availabilityRow('Built-in — always available')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('shows the disabled banner and Off state for a locally disabled skill', async () => {
    skills = [baseSkill('review-skill', 'Review Skill', 'workspace')]
    managedStatuses = [
      { slug: 'review-skill', source: 'workspace', enabled: false, toggleable: true, managed: false, shadowedBuiltin: false },
    ]
    renderPage('review-skill')

    expect(await screen.findByText(DISABLED_HINT)).toBeTruthy()
    expect(availabilityRow('Disabled')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('explains a shadowedBuiltin entry instead of offering a toggle (SM-18e)', async () => {
    skills = [baseSkill('over-builtin', 'Shadow User', 'workspace')]
    managedStatuses = [
      { slug: 'over-builtin', source: 'workspace', enabled: true, toggleable: false, managed: false, shadowedBuiltin: true },
    ]
    renderPage('over-builtin')

    expect(await screen.findByText('Shadow User')).toBeTruthy()
    expect(availabilityRow(SHADOW_HINT)).toBeTruthy()
    expect(screen.queryByText(DISABLED_HINT)).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('reports an enabled user skill as Enabled', async () => {
    skills = [baseSkill('review-skill', 'Review Skill', 'workspace')]
    managedStatuses = [
      { slug: 'review-skill', source: 'workspace', enabled: true, toggleable: true, managed: false, shadowedBuiltin: false },
    ]
    renderPage('review-skill')

    expect(await screen.findByText('Review Skill')).toBeTruthy()
    expect(availabilityRow('Enabled')).toBeTruthy()
    expect(screen.queryByText(DISABLED_HINT)).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
