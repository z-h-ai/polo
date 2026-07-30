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
}

let listInput: unknown

beforeEach(async () => {
  await i18n.changeLanguage('en')
  listInput = undefined
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
        versions: [],
      }),
    },
  })
})

afterEach(() => {
  cleanup()
})

function renderPanel(canManage: boolean) {
  return render(createElement(
    I18nextProvider,
    { i18n },
    createElement(CreatorArtifactsPanel, {
      organizationId,
      canManage,
      workspaceId: null,
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
})
