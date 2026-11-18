/**
 * WorkspacePicker — the zero-workspace empty state.
 *
 * With no server workspaces the picker must explain itself (「还没有工作区」)
 * instead of showing only a divider plus the create form; on a failed load
 * the retry affordance owns the surface and the empty-state copy stays out.
 * Isolated happy-dom render (shared-process pattern, see TopBar.app-menu.isolated.ts).
 *
 * Run per-file: `bun test apps/electron/src/renderer/components/workspace/__tests__/WorkspacePicker.empty-state.isolated.ts`
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}
setupI18n()

// Mutable fixtures — tests reassign before a fresh render.
let serverWorkspaces: Array<{ id: string; name: string; slug: string }> = []
let loadError: Error | null = null
mock.module('@polo-ai/ui', () => ({ Spinner: () => null }))

Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
  getServerWorkspaces: async () => {
    if (loadError) throw loadError
    return serverWorkspaces
  },
} })

const { render, screen, cleanup, waitFor } = await import('@testing-library/react')
const { WorkspacePicker } = await import('../WorkspacePicker')

function tree() {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(WorkspacePicker, { onSelectWorkspace: () => {} }),
  )
}

afterEach(() => {
  cleanup()
  serverWorkspaces = []
  loadError = null
})

describe('WorkspacePicker empty state', () => {
  it('explains the zero-workspace state next to the create form', async () => {
    render(tree())

    await waitFor(() => expect(screen.getByText(i18n.t('workspace.noWorkspacesYet') as string)).toBeTruthy())
    // The create form below stays the primary action.
    expect(screen.getByText(i18n.t('workspace.createWorkspace') as string)).toBeTruthy()
    expect(screen.queryByTestId('workspace-picker-retry')).toBeNull()
  })

  it('hides the empty-state copy once a workspace exists', async () => {
    serverWorkspaces = [{ id: 'ws-1', name: 'Main', slug: 'main' }]
    render(tree())

    await waitFor(() => expect(screen.getByText('Main')).toBeTruthy())
    expect(screen.queryByText(i18n.t('workspace.noWorkspacesYet') as string)).toBeNull()
  })

  it('stays out of the failed-load face so the retry affordance owns it', async () => {
    loadError = new Error('boom')
    render(tree())

    await waitFor(() => expect(screen.getByTestId('workspace-picker-retry')).toBeTruthy())
    expect(screen.queryByText(i18n.t('workspace.noWorkspacesYet') as string)).toBeNull()
  })
})
