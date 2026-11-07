import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'

GlobalRegistrator.register()
setupI18n()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { HomeSpaceContext } = await import('../HomeSpaceContext')

const circles = [
  { circleId: 'circle-bridge', name: '桥岸圈子' },
  { circleId: 'circle-north', name: '北辰圈子' },
]

function withProvider(props: {
  spaceName: string
  spaceKind: 'personal' | 'enterprise' | null
  spaceCategory?: 'organization' | 'project' | 'personal' | 'unknown'
  creatorCircles: Array<{ circleId: string; name: string }>
  spaceKey?: string
}) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(HomeSpaceContext, { ...props }),
  )
}

function renderWithContext(props: {
  spaceName: string
  spaceKind: 'personal' | 'enterprise' | null
  spaceCategory?: 'organization' | 'project' | 'personal' | 'unknown'
  creatorCircles: Array<{ circleId: string; name: string }>
}) {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(HomeSpaceContext, { ...props }),
    ),
  )
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
})

afterEach(() => {
  cleanup()
})

describe('HomeSpaceContext — 我的圈子 relation entry (REQ-022)', () => {
  it('renders the relation entry for a personal space with creator_circle relations', () => {
    renderWithContext({
      spaceName: '我的空间',
      spaceKind: 'personal',
      creatorCircles: circles,
    })

    const entry = screen.getByTestId('product-space-relation-my-circles')
    expect(entry).toBeTruthy()
    // POO-41 frozen copy: 我的圈子 + N 个圈子.
    expect(entry.textContent).toContain('我的圈子')
    expect(entry.textContent).toContain('2 个圈子')
    // The circles relation view is closed until the entry is clicked.
    expect(screen.queryByTestId('product-space-relation-my-circles-view')).toBeNull()
  })

  it('opens the in-place circles relation view and returns', () => {
    renderWithContext({
      spaceName: '我的空间',
      spaceKind: 'personal',
      creatorCircles: circles,
    })

    fireEvent.click(screen.getByTestId('product-space-relation-my-circles'))
    const view = screen.getByTestId('product-space-relation-my-circles-view')
    expect(view).toBeTruthy()
    expect(view.textContent).toContain('桥岸圈子')
    expect(view.textContent).toContain('北辰圈子')
    // Circle relations never leak into a space list shape.
    expect(screen.queryByTestId('product-space-item')).toBeNull()

    fireEvent.click(screen.getByTestId('product-space-relation-my-circles-back'))
    expect(screen.queryByTestId('product-space-relation-my-circles-view')).toBeNull()
    expect(screen.getByTestId('product-space-relation-my-circles')).toBeTruthy()
  })

  it('collapses the circles view when the space flips to enterprise on the same mount', () => {
    const initial = {
      spaceName: '我的空间',
      spaceKey: 'ctx-personal',
      spaceKind: 'personal' as const,
      creatorCircles: circles,
    }
    const view = render(withProvider(initial))

    fireEvent.click(screen.getByTestId('product-space-relation-my-circles'))
    expect(screen.getByTestId('product-space-relation-my-circles-view')).toBeTruthy()

    // Identity flips to enterprise on the SAME mounted instance: the
    // circles relation view must never linger.
    view.rerender(withProvider({
      spaceName: '北辰智能科技',
      spaceKey: 'ctx-enterprise',
      spaceKind: 'enterprise',
      creatorCircles: circles,
    }))

    expect(screen.queryByTestId('product-space-relation-my-circles-view')).toBeNull()
    expect(screen.queryByTestId('product-space-relation-my-circles')).toBeNull()
  })

  it('collapses the circles view when relations are emptied on the same mount', () => {
    const initial = {
      spaceName: '我的空间',
      spaceKey: 'ctx-personal',
      spaceKind: 'personal' as const,
      creatorCircles: circles,
    }
    const view = render(withProvider(initial))

    fireEvent.click(screen.getByTestId('product-space-relation-my-circles'))
    expect(screen.getByTestId('product-space-relation-my-circles-view')).toBeTruthy()

    // Relations emptied (e.g. a failed refresh invalidates them): the view
    // collapses and the entry disappears with the lost guard.
    view.rerender(withProvider({
      ...initial,
      creatorCircles: [],
    }))

    expect(screen.queryByTestId('product-space-relation-my-circles-view')).toBeNull()
    expect(screen.queryByTestId('product-space-relation-my-circles')).toBeNull()
  })

  it('collapses the circles view when only the space identity changes', () => {
    const initial = {
      spaceName: '我的空间',
      spaceKey: 'ctx-account-a',
      spaceKind: 'personal' as const,
      creatorCircles: circles,
    }
    const view = render(withProvider(initial))

    fireEvent.click(screen.getByTestId('product-space-relation-my-circles'))
    expect(screen.getByTestId('product-space-relation-my-circles-view')).toBeTruthy()

    // Same shape, different ProductSpace identity: the mounted circles view
    // is reset to the context view for the new identity.
    view.rerender(withProvider({
      ...initial,
      spaceKey: 'ctx-account-b',
    }))

    expect(screen.queryByTestId('product-space-relation-my-circles-view')).toBeNull()
    expect(screen.getByTestId('product-space-relation-my-circles')).toBeTruthy()
  })

  it('renders no relation entry for a personal space without creator_circle relations', () => {
    renderWithContext({
      spaceName: '我的空间',
      spaceKind: 'personal',
      creatorCircles: [],
    })

    expect(screen.queryByTestId('product-space-relation-my-circles')).toBeNull()
    expect(screen.queryByTestId('product-space-relation-my-circles-view')).toBeNull()
  })

  it('renders no relation entry for an enterprise space even with relations', () => {
    renderWithContext({
      spaceName: '北辰智能科技',
      spaceKind: 'enterprise',
      creatorCircles: circles,
    })

    expect(screen.queryByTestId('product-space-relation-my-circles')).toBeNull()
    expect(screen.queryByTestId('product-space-relation-my-circles-view')).toBeNull()
  })
})

describe('HomeSpaceContext — UB5 (U14) 空间身份层级', () => {
  it('classifies the title from the authoritative spaceCategory — organization / project / personal / unknown — with the real name verbatim', () => {
    // The committed name deliberately contains「项目空间」: the category
    // prefix never strips or rewrites the user-chosen name.
    const cases = [
      { spaceCategory: 'organization', expected: '当前单位：Apollo 项目空间' },
      { spaceCategory: 'project', expected: '当前项目：Apollo 项目空间' },
      { spaceCategory: 'personal', expected: '个人空间：Apollo 项目空间' },
      { spaceCategory: 'unknown', expected: '当前空间：Apollo 项目空间' },
    ] as const
    for (const item of cases) {
      const view = renderWithContext({
        spaceName: 'Apollo 项目空间',
        spaceKind: item.spaceCategory === 'personal' ? 'personal' : 'enterprise',
        spaceCategory: item.spaceCategory,
        creatorCircles: [],
      })
      expect(screen.getByTestId('home-space-context-title').textContent).toBe(item.expected)
      // The name is never rendered raw — the category template wraps it.
      expect(screen.queryByText('Apollo 项目空间')).toBeNull()
      view.unmount()
    }
  })

  it('defaults to the neutral 当前空间 face when no category is provided (fail-closed, never a wrong commitment)', () => {
    renderWithContext({
      spaceName: '未分类空间',
      spaceKind: 'enterprise',
      creatorCircles: [],
    })
    expect(screen.getByTestId('home-space-context-title').textContent).toBe('当前空间：未分类空间')
  })

  it('renders the compact default state — 8px vertical padding, 13px semibold name, 12px secondary description on one wrapping row', () => {
    renderWithContext({
      spaceName: '很长很长的空间名称很长很长的空间名称很长很长的空间名称很长很长的空间名称',
      spaceKind: 'enterprise',
      spaceCategory: 'organization',
      creatorCircles: [],
    })
    const section = screen.getByTestId('home-space-context')
    expect(section.className).toContain('py-[8px]')
    const title = screen.getByTestId('home-space-context-title')
    expect(title.className).toContain('text-[13px]')
    expect(title.className).toContain('font-semibold')
    expect(title.className).toContain('min-w-0')
    const description = screen.getByText('发布到当前空间的应用。')
    expect(description.className).toContain('text-[12px]')
    expect(description.className).toContain('text-muted-foreground')
  })

  it('keeps the circles entry personal-only beside the compact identity row and the relation view intact', () => {
    const view = renderWithContext({
      spaceName: '我的空间',
      spaceKind: 'personal',
      spaceCategory: 'personal',
      creatorCircles: circles,
    })
    expect(screen.getByTestId('home-space-context-title').textContent).toBe('个人空间：我的空间')
    fireEvent.click(screen.getByTestId('product-space-relation-my-circles'))
    expect(screen.getByTestId('product-space-relation-my-circles-view')).toBeTruthy()
    fireEvent.click(screen.getByTestId('product-space-relation-my-circles-back'))
    expect(screen.getByTestId('home-space-context-title').textContent).toBe('个人空间：我的空间')
    view.unmount()
  })
})
