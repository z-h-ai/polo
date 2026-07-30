import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'

GlobalRegistrator.register()
setupI18n()

mock.module('@polo-ai/ui', () => ({
  Spinner: () => createElement('span', { 'data-testid': 'spinner' }),
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { CreatorArtifactsPanel } = await import('../CreatorArtifactsPanel')

const organizationId = 'organization-one'
const commonArtifact = {
  organizationId,
  status: 'published' as const,
  createdByUserId: 'user-one',
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
}
const webApp = {
  ...commonArtifact,
  id: 'web-app-one',
  type: 'web_app' as const,
  slug: 'Legacy_App',
  name: 'Legacy Dashboard',
}
const skill = {
  ...commonArtifact,
  id: 'skill-one',
  type: 'skill' as const,
  slug: 'review-skill',
  name: 'Review Skill',
  latestPublishedVersion: '1.0.0',
}

let listInput: unknown
let detailVersions: Array<Record<string, unknown>>

beforeEach(async () => {
  await i18n.changeLanguage('en')
  listInput = undefined
  detailVersions = []
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      creatorArtifactGetCapabilities: async () => ({
        success: true as const,
        creatorSkillArtifacts: true,
      }),
      creatorArtifactList: async (input: unknown) => {
        listInput = input
        return {
          success: true as const,
          artifacts: [webApp, skill],
        }
      },
      creatorArtifactGet: async () => ({
        success: true as const,
        artifact: skill,
        versions: detailVersions,
      }),
      creatorSkillGetTarget: async () => ({
        success: true as const,
        workspaceId: 'workspace-one',
        name: 'Workspace One',
        path: '/workspace-one',
        writable: true,
      }),
      creatorSkillGetDownloadGrant: async () => ({
        success: true as const,
        artifactId: skill.id,
        organizationId,
        slug: skill.slug,
        version: '1.0.0',
        url: 'https://download.example.test/review-skill.zip',
        expiresAt: '2030-01-01T00:00:00.000Z',
        archiveChecksum: 'a'.repeat(64),
        contentDigest: 'b'.repeat(64),
        manifest: [],
        validationPolicy: {
          version: '1',
          maxArchiveBytes: 20 * 1024 * 1024,
          maxFileCount: 200,
          maxFileBytes: 5 * 1024 * 1024,
          maxExpandedBytes: 50 * 1024 * 1024,
        },
      }),
      creatorSkillInstall: async (input: { operationId: string }) => ({
        success: false as const,
        operationId: input.operationId,
        errorCode: 'workspace_read_only',
        stage: 'prepare' as const,
        diagnostic: JSON.stringify({
          errorCode: 'workspace_read_only',
          stage: 'prepare',
        }),
        retryable: false,
      }),
    },
  })
})

afterEach(() => {
  cleanup()
})

function renderPanel(canManage: boolean, workspaceId: string | null = null) {
  return render(createElement(
    I18nextProvider,
    { i18n },
    createElement(CreatorArtifactsPanel, {
      organizationId,
      canManage,
      workspaceId,
    }),
  ))
}

describe('CreatorArtifactsPanel', () => {
  it('requests an aggregate catalog and renders Web App and Skill type badges', async () => {
    renderPanel(false)

    expect(await screen.findAllByText('Legacy Dashboard')).toHaveLength(2)
    expect(await screen.findByText('Review Skill')).toBeTruthy()
    expect(listInput).toEqual({
      organizationId,
      includeDrafts: false,
    })
    const rows = screen.getAllByTestId('creator-artifact-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Web App')
    expect(rows[1]!.textContent).toContain('Skill')
  })

  it('uses the localized initial changelog for the first Skill version', async () => {
    renderPanel(true)
    const skillRow = await screen.findByText('Review Skill')
    fireEvent.click(skillRow.closest('button')!)

    await waitFor(() => {
      const input = document.querySelector('#creator-skill-changelog') as HTMLInputElement | null
      expect(input?.value).toBe('Initial release')
    })
  })

  it('localizes workspace mutation errors without a server message', async () => {
    detailVersions = [{
      id: 'version-one',
      artifactId: skill.id,
      version: '1.0.0',
      status: 'published',
      createdAt: '2026-07-30T00:00:00.000Z',
      publishedAt: '2026-07-30T00:00:00.000Z',
      uploadGeneration: 1,
    }]
    renderPanel(false, 'workspace-one')
    const skillRow = await screen.findByText('Review Skill')
    fireEvent.click(skillRow.closest('button')!)
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))

    expect((await screen.findByRole('alert')).textContent)
      .toContain('This workspace is read-only. Skill changes are not allowed.')
    expect(i18n.t('creatorSkills.errors.workspace_context_mismatch'))
      .toBe('This workspace is no longer the active workspace. Reopen it and try again.')
  })
})
