import { afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, forwardRef, type ComponentProps } from 'react'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import type { MenuComponents } from '@/components/ui/menu-context'
import type { SessionStatus } from '@/config/session-status-config'

// These user-event interactions also run alongside the batch's full typechecks.
setDefaultTimeout(30_000)

if (typeof window === 'undefined') GlobalRegistrator.register()
setupI18n()
// The sibling LabelIcon in SessionMenuParts imports a Vite-only theme loader.
mock.module('@/context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }))
// cmdk uses browser layout APIs that happy-dom does not implement.
Element.prototype.scrollIntoView = () => {}
const { render, renderHook, screen, cleanup, waitFor, act } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { I18nextProvider } = await import('react-i18next')
const { SessionStatusMenu } = await import('../session-status-menu')
const { StatusMenuItems } = await import('../../app-shell/SessionMenuParts')
const { InlineLabelMenu, useInlineLabelMenu, filterSessionStatuses } = await import('../label-menu')

const TestMenuItem = forwardRef<HTMLDivElement, ComponentProps<MenuComponents['MenuItem']>>(
  ({ children, onClick }, ref) => createElement('div', { onClick, ref, role: 'button' }, children),
)

const states: SessionStatus[] = [
  { id: 'todo', label: 'Todo', isFixed: true },
  { id: 'cancelled', label: 'Cancelled', isFixed: true },
  { id: 'needs-review', label: 'Finance review', isDefault: true },
  { id: 'custom', label: 'Customer follow-up' },
  { id: 'unknown', label: 'Legacy state' },
].map(state => ({ resolvedColor: 'currentColor', icon: '●', iconColorable: true, ...state }))

function mountMenu(overrides: Record<string, unknown> = {}) {
  const selected: string[] = []
  const archived: string[] = []
  render(createElement(I18nextProvider, { i18n }, createElement(SessionStatusMenu, {
    states, activeState: 'todo', onSelect: id => selected.push(id),
    onArchive: () => archived.push('archive'), onUnarchive: () => archived.push('unarchive'),
    ...overrides,
  })))
  return { selected, archived }
}

beforeEach(async () => { await i18n.changeLanguage('zh-Hans') })
afterEach(cleanup)

describe('status menu localization', () => {
  it('searches Chinese display names and English aliases while selecting stored IDs', async () => {
    const user = userEvent.setup()
    const { selected } = mountMenu()
    expect(screen.getByText('待办')).toBeTruthy()
    expect(screen.getByText('Finance review')).toBeTruthy()
    expect(screen.getByText('Customer follow-up')).toBeTruthy()
    expect(screen.getByText('Legacy state')).toBeTruthy()
    const input = screen.getByRole('combobox')
    await user.type(input, '已取消')
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1))
    await user.click(screen.getByRole('option', { name: /已取消/ }))
    expect(selected).toEqual(['cancelled'])
    await user.clear(input)
    await user.type(input, 'Cancelled')
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1))
    expect(screen.getByRole('option', { name: /已取消/ })).toBeTruthy()
  })

  it('refreshes a mounted menu and its active search on language changes', async () => {
    const user = userEvent.setup()
    mountMenu()
    const input = screen.getByRole('combobox')
    await user.type(input, '待办')
    expect(screen.getByRole('option', { name: /待办/ })).toBeTruthy()
    await act(async () => { await i18n.changeLanguage('en') })
    await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0))
    expect(screen.getByText('No status found')).toBeTruthy()
    expect(input.getAttribute('placeholder')).toBe('Filter statuses...')
    await user.clear(input)
    expect(screen.getByText('Todo')).toBeTruthy()
    expect(screen.getByText('Archive')).toBeTruthy()
    await act(async () => { await i18n.changeLanguage('zh-Hans') })
    expect(screen.getByText('待办')).toBeTruthy()
    expect(screen.getByText('归档')).toBeTruthy()
    expect(screen.getByText('Finance review')).toBeTruthy()
  })

  it('translates empty results and both archive actions without changing callbacks', async () => {
    const user = userEvent.setup()
    const { archived } = mountMenu({ isArchived: true })
    await user.click(screen.getByText('取消归档'))
    expect(archived).toEqual(['unarchive'])
    await user.type(screen.getByRole('combobox'), 'no-such-status')
    await waitFor(() => expect(screen.getByText('未找到状态')).toBeTruthy())
    expect(screen.queryByText('取消归档')).toBeNull()
  })

  it('searches localized sidebar and inline status choices without rewriting records', async () => {
    const original = JSON.stringify(states)
    expect(filterSessionStatuses(states, '待办').map(s => s.id)).toEqual(['todo'])
    expect(filterSessionStatuses(states, 'Todo').map(s => s.id)).toEqual(['todo'])
    expect(filterSessionStatuses(states, 'Finance').map(s => s.id)).toEqual(['needs-review'])
    await i18n.changeLanguage('en')
    expect(filterSessionStatuses(states, '待办')).toEqual([])
    expect(JSON.stringify(states)).toBe(original)
  })

  it('keeps the inline menu open when the user types a Chinese status query', () => {
    const { result } = renderHook(() => useInlineLabelMenu({
      inputRef: { current: null }, labels: [], sessionStatuses: states, onSelect: () => {},
    }))
    act(() => result.current.handleInputChange('#待办', 3))
    expect(result.current.isOpen).toBe(true)
    expect(filterSessionStatuses(result.current.states, result.current.filter).map(s => s.id)).toEqual(['todo'])
  })

  it('translates the inline menu section headers and add-label fallback', () => {
    render(createElement(I18nextProvider, { i18n }, createElement(InlineLabelMenu, {
      open: true, onOpenChange: () => {}, onSelect: () => {},
      states, items: [{ id: 'test-label', label: 'Client label', config: { id: 'test-label', name: 'Client label' } }],
      position: { x: 100, y: 400 },
    })))
    expect(screen.getByText('状态')).toBeTruthy()
    expect(screen.getByText('标签')).toBeTruthy()
    expect(screen.getByText('Client label')).toBeTruthy()
    cleanup()
    render(createElement(I18nextProvider, { i18n }, createElement(InlineLabelMenu, {
      open: true, onOpenChange: () => {}, onSelect: () => {}, items: [],
      onAddLabel: () => {}, position: { x: 100, y: 400 },
    })))
    expect(screen.getByText('添加新标签')).toBeTruthy()
  })

  it('keeps desktop status items reactive and passes their real IDs', async () => {
    const selected: string[] = []
    render(createElement(I18nextProvider, { i18n }, createElement(StatusMenuItems, {
      sessionStatuses: states, onSelect: id => selected.push(id),
      menu: { MenuItem: TestMenuItem },
    })))
    const user = userEvent.setup()
    await user.click(screen.getByText('已取消'))
    expect(selected).toEqual(['cancelled'])
    await act(async () => { await i18n.changeLanguage('en') })
    expect(screen.getByText('Cancelled')).toBeTruthy()
    expect(screen.getByText('Finance review')).toBeTruthy()
  })
})
