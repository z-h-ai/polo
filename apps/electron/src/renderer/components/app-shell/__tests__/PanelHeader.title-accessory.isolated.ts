import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { atom } from 'jotai'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

// Isolated-process pattern (see LeftSidebar.user-menu.isolated.ts): register
// happy-dom only when no window exists, pin a macOS userAgent.
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

// PanelHeader reads the shell context for the compact-mode flag and the
// stoplight compensation; the shell isn't mounted here, so pin both to the
// desktop defaults the navigator header runs under.
mock.module('@/context/AppShellContext', () => ({
  useAppShellContext: () => ({ leadingAction: undefined, isCompactMode: false }),
  useOptionalAppShellContext: () => null,
}))
mock.module('@/context/StoplightContext', () => ({ useCompensateForStoplight: () => false }))

const { render, screen, cleanup } = await import('@testing-library/react')
const { PanelHeader } = await import('../PanelHeader')

function tree(props: Record<string, unknown>) {
  return createElement(I18nextProvider, { i18n }, createElement(PanelHeader, props as never))
}

afterEach(() => {
  cleanup()
})

/**
 * POO-202: the navigator (session list) header reads left·center·right —
 * sidebar collapse control on the far left, the title at the true center,
 * the list filter trigger in the right-hand cluster. PanelHeader models that
 * with the `titleAccessory` slot (right cluster, before `actions`); passing
 * it switches the desktop header to the symmetric three-column layout, with
 * `leadingAction` staying in the left column.
 */
describe('PanelHeader titleAccessory slot (POO-202)', () => {
  it('P202-04: the accessory renders in the right-hand cluster, before the actions', () => {
    render(tree({
      title: i18n.t('sidebar.allSessions'),
      titleAccessory: createElement('button', {
        'data-testid': 'title-accessory-probe',
        type: 'button',
      }),
      actions: createElement('button', {
        'data-testid': 'actions-probe',
        type: 'button',
      }),
    }))
    const title = screen.getByText(i18n.t('sidebar.allSessions'))
    const accessory = screen.getByTestId('title-accessory-probe')
    const actions = screen.getByTestId('actions-probe')
    // The accessory no longer rides inside the title row.
    expect(accessory.parentElement).not.toBe(title.parentElement)
    // DOM order inside the right cluster: accessory first, actions after,
    // both under the same right-hand column.
    expect(accessory.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(accessory.parentElement!.parentElement).toBe(actions.parentElement!.parentElement)
  })

  it('P202-05: without an accessory nothing extra renders and the legacy layout is kept', () => {
    render(tree({ title: i18n.t('sidebar.allSessions') }))
    expect(screen.queryByTestId('title-accessory-probe')).toBeNull()
  })

  it('P202-06: with an accessory the header splits into three distinct columns — leading · title · right', () => {
    render(tree({
      title: i18n.t('sidebar.allSessions'),
      leadingAction: createElement('button', {
        'data-testid': 'leading-action-probe',
        type: 'button',
      }),
      titleAccessory: createElement('button', {
        'data-testid': 'title-accessory-probe',
        type: 'button',
      }),
    }))
    const leading = screen.getByTestId('leading-action-probe')
    const title = screen.getByText(i18n.t('sidebar.allSessions'))
    const accessory = screen.getByTestId('title-accessory-probe')
    // Three separate columns: left (leading), center (title), right (accessory).
    expect(leading.parentElement).not.toBe(title.parentElement)
    expect(title.parentElement).not.toBe(accessory.parentElement)
    expect(leading.parentElement).not.toBe(accessory.parentElement)
    // DOM order: leading, then the centered title, then the right cluster.
    expect(leading.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(title.compareDocumentPosition(accessory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
