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

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { default: SkillInfoPage } = await import('../SkillInfoPage')

const installation = {
  artifactId: 'artifact-one',
  organizationId: 'organization-one',
  slug: 'review-skill',
  version: '1.0.0',
  archiveChecksum: 'a'.repeat(64),
  contentDigest: 'b'.repeat(64),
  installedAt: '2026-07-30T00:00:00.000Z',
  lastKnownStatus: 'active' as const,
  lastCheckedAt: new Date().toISOString(),
}
const skill = {
  slug: 'review-skill',
  metadata: {
    name: 'Review Skill',
    description: 'Review instructions.',
  },
  content: 'Instructions.',
  path: '/workspace-one/skills/review-skill',
  source: 'workspace' as const,
  creatorInstallation: installation,
}

let safetyResponse: () => Promise<Record<string, unknown>>
let deleteSkillResponse: () => Promise<Record<string, unknown>>
let uninstallInputs: Array<Record<string, unknown>>
let installInputs: Array<Record<string, unknown>>

beforeEach(async () => {
  await i18n.changeLanguage('en')
  safetyResponse = async () => ({
    success: false as const,
    errorCode: 'temporary_network_failure',
  })
  deleteSkillResponse = async () => ({ managed: true, detached: true })
  uninstallInputs = []
  installInputs = []
  window.confirm = mock(() => false)
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getSkills: async () => [skill],
      onSkillsChanged: () => () => {},
      onCreatorSkillProgress: () => () => {},
      creatorSkillGetSafetyStatus: () => safetyResponse(),
      creatorSkillUpdateSafetyStatus: async () => ({ success: true as const }),
      creatorSkillIgnoreVersion: async () => ({ success: true as const }),
      creatorSkillGetDownloadGrant: async (input: { version: string }) => ({
        success: true as const,
        artifactId: installation.artifactId,
        organizationId: installation.organizationId,
        slug: installation.slug,
        version: input.version,
        url: 'https://download.example.test/review-skill.zip',
        expiresAt: '2030-01-01T00:00:00.000Z',
        archiveChecksum: 'c'.repeat(64),
        contentDigest: 'd'.repeat(64),
        manifest: [],
        validationPolicy: {
          version: '1',
          maxArchiveBytes: 20 * 1024 * 1024,
          maxFileCount: 200,
          maxFileBytes: 5 * 1024 * 1024,
          maxExpandedBytes: 50 * 1024 * 1024,
        },
      }),
      creatorSkillInstall: async (input: Record<string, unknown>) => {
        installInputs.push(input)
        return {
          success: true as const,
          operationId: input.operationId,
        }
      },
      creatorSkillCancel: async () => ({ success: true as const }),
      deleteSkill: () => deleteSkillResponse(),
      creatorSkillUninstall: async (input: Record<string, unknown>) => {
        uninstallInputs.push(input)
        return {
          success: true as const,
          operationId: input.operationId,
        }
      },
      showInFolder: async () => {},
      openUrl: async () => {},
    },
  })
})

afterEach(() => {
  cleanup()
})

function renderPage() {
  return render(createElement(
    Provider,
    { store: createStore() },
    createElement(
      I18nextProvider,
      { i18n },
      createElement(SkillInfoPage, {
        skillSlug: skill.slug,
        workspaceId: 'workspace-one',
        sessionId: 'session-one',
      }),
    ),
  ))
}

describe('SkillInfoPage Creator Skill interactions', () => {
  it('shows a failed safety refresh immediately even when lastCheckedAt is fresh', async () => {
    renderPage()

    expect(await screen.findByText('Safety status could not be refreshed')).toBeTruthy()
    expect(screen.getByText('Review Skill')).toBeTruthy()
  })

  it('offers a secondary destructive confirmation and force deletes modified content', async () => {
    safetyResponse = async () => ({
      success: true as const,
      artifactId: installation.artifactId,
      version: installation.version,
      archiveChecksum: installation.archiveChecksum,
      status: 'active',
    })
    let confirmation = ''
    window.confirm = mock(message => {
      confirmation = String(message)
      return true
    })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Skill' }))

    await waitFor(() => {
      expect(confirmation).toContain('Permanently delete')
      expect(confirmation).toContain('cannot be undone')
      expect(uninstallInputs).toHaveLength(1)
      expect(uninstallInputs[0]).toMatchObject({
        workspaceId: 'workspace-one',
        slug: 'review-skill',
        forceDeleteModified: true,
      })
    })
  })

  it('offers and executes an explicit safe rollback for a revoked newer version', async () => {
    safetyResponse = async () => ({
      success: true as const,
      artifactId: installation.artifactId,
      version: installation.version,
      archiveChecksum: installation.archiveChecksum,
      status: 'revoked',
      safeVersion: '0.9.0',
    })
    renderPage()

    expect(await screen.findByText('Safe rollback to version 0.9.0 is available')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }))

    await waitFor(() => expect(installInputs).toHaveLength(1))
    expect(installInputs[0]).toMatchObject({
      workspaceId: 'workspace-one',
      grant: {
        artifactId: installation.artifactId,
        version: '0.9.0',
      },
    })
    expect(installInputs[0]).not.toHaveProperty('sessionId')
    expect(installInputs[0]).not.toHaveProperty('workingDirectory')
  })
})
