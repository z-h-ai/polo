import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'

// Bun does not execute Vite import.meta.glob in the theme loader.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

GlobalRegistrator.register()
setupI18n()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ProductSpaceSelectScreen } = await import('../ProductSpaceSelectScreen')

const personalId = 'space-personal'
const personalSpace = {
  id: personalId,
  kind: 'personal',
  name: '我的空间',
  accessMode: 'active',
  payer: { kind: 'account' },
} as unknown as ProductSpaceSummary
const enterpriseSpace = {
  id: 'space-ent',
  kind: 'enterprise',
  enterpriseId: 'enterprise-1',
  name: '星辰传媒',
  role: 'member',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'enterprise-1' },
} as unknown as ProductSpaceSummary
const secondEnterprise = {
  id: 'space-ent-2',
  kind: 'enterprise',
  enterpriseId: 'enterprise-2',
  name: '蓝湖设计',
  role: 'manager',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'enterprise-2' },
} as unknown as ProductSpaceSummary
const restrictedEnterprise = {
  id: 'space-ent-restricted',
  kind: 'enterprise',
  enterpriseId: 'enterprise-3',
  name: '恒岳法务',
  role: 'member',
  accessMode: 'read_only',
  restrictionCode: 'billing_restricted',
  payer: { kind: 'enterprise', enterpriseId: 'enterprise-3' },
} as unknown as ProductSpaceSummary

function renderScreen(overrides: Record<string, unknown> = {}) {
  const onConfirm = mock(() => {})
  const onLogout = mock(() => {})
  const utils = render(createElement(
    I18nextProvider,
    { i18n },
    createElement(ProductSpaceSelectScreen, {
      spaces: [personalSpace, enterpriseSpace],
      activeProductSpaceId: personalId,
      selectionSource: 'fresh',
      account: { displayName: '王晓蕴', username: 'wangxy' },
      submitting: false,
      onConfirm,
      onLogout,
      ...overrides,
    }),
  ))
  return { onConfirm, onLogout, ...utils }
}

function items() {
  return screen.getAllByTestId('product-space-select-item')
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
})

afterEach(() => {
  cleanup()
})

describe('ProductSpaceSelectScreen · 默认选中（M3）', () => {
  it('回访：stored active 企业置顶并默认选中，副文案不使用首登欢迎语', () => {
    renderScreen({ selectionSource: 'stored', activeProductSpaceId: 'space-ent' })
    const rows = items()
    expect(rows.map(row => row.getAttribute('data-space-id'))).toEqual(['space-ent', personalId])
    expect(rows[0]!.getAttribute('data-active')).toBe('true')
    expect(rows[1]!.getAttribute('data-active')).toBe('false')
    expect(screen.getByTestId('product-space-select-confirm').textContent).toBe('进入「星辰传媒」')
    expect(screen.getByText('你的账号有多个空间。已为你选中上次使用的空间，确认后进入。')).toBeTruthy()
    expect(screen.queryByTestId('product-space-select-recommended-tag')).toBeNull()
  })

  it('首登：无本地记忆时 active 企业置顶、默认选中并带「推荐」标记', () => {
    renderScreen()
    const rows = items()
    expect(rows.map(row => row.getAttribute('data-space-id'))).toEqual(['space-ent', personalId])
    expect(rows[0]!.getAttribute('data-active')).toBe('true')
    expect(screen.getByTestId('product-space-select-recommended-tag').textContent).toBe('推荐')
    expect(screen.getByText('欢迎加入 Polo AI！根据企业邀请，为你推荐要进入的空间。')).toBeTruthy()
  })

  it('首登且唯一 active 企业是受限企业时不推荐受限空间，兜底 bootstrap 已提交空间', () => {
    renderScreen({
      spaces: [personalSpace, restrictedEnterprise],
      activeProductSpaceId: personalId,
    })
    const rows = items()
    expect(rows[0]!.getAttribute('data-space-id')).toBe(personalId)
    expect(rows[0]!.getAttribute('data-active')).toBe('true')
    expect(screen.queryByTestId('product-space-select-recommended-tag')).toBeNull()
    expect(screen.getByTestId('product-space-select-confirm').textContent).toBe('进入「我的空间」')
  })

  it('记忆失效（上次空间受限）不得自动恢复为默认（S3），改为推荐可用企业并说明缘由', () => {
    renderScreen({
      spaces: [personalSpace, restrictedEnterprise, enterpriseSpace],
      activeProductSpaceId: personalId,
      selectionSource: 'memory-invalid',
    })
    const rows = items()
    expect(rows[0]!.getAttribute('data-space-id')).toBe('space-ent')
    expect(rows[0]!.getAttribute('data-active')).toBe('true')
    expect(screen.getByTestId('product-space-select-recommended-tag')).toBeTruthy()
    expect(screen.getByText('上次使用的空间当前不可用，已为你推荐可进入的空间。')).toBeTruthy()
    expect(screen.queryByText('你的账号有多个空间。已为你选中上次使用的空间，确认后进入。')).toBeNull()
  })

  it('首登但无可用推荐（企业全部受限）时使用中性副文案，不虚构推荐', () => {
    renderScreen({
      spaces: [personalSpace, restrictedEnterprise],
      activeProductSpaceId: personalId,
      selectionSource: 'fresh',
    })
    expect(screen.queryByTestId('product-space-select-recommended-tag')).toBeNull()
    expect(screen.getByText('你的账号有多个空间。选择要进入的空间，确认后进入。')).toBeTruthy()
  })

  it('回访 stored 为个人空间时个人置顶默认选中', () => {
    renderScreen({ spaces: [enterpriseSpace, personalSpace], activeProductSpaceId: personalId, selectionSource: 'stored' })
    const rows = items()
    expect(rows.map(row => row.getAttribute('data-space-id'))).toEqual([personalId, 'space-ent'])
    expect(rows[0]!.getAttribute('data-active')).toBe('true')
  })
})

describe('ProductSpaceSelectScreen · 列表标记（M5/S3）', () => {
  it('企业条目带「企业 · 角色」，受限条目带「受限」，个人不带企业标记', () => {
    renderScreen({
      spaces: [personalSpace, enterpriseSpace, restrictedEnterprise],
      activeProductSpaceId: personalId,
    })
    const rows = items()
    expect(rows).toHaveLength(3)
    // 推荐置顶后：推荐企业、个人、受限企业（personal-first 只约束其余项）
    expect(rows.map(row => row.getAttribute('data-space-id'))).toEqual(['space-ent', personalId, 'space-ent-restricted'])
    expect(rows[0]!.textContent).toContain('企业 · Member')
    expect(rows[0]!.getAttribute('data-space-kind')).toBe('enterprise')
    expect(rows[1]!.getAttribute('data-space-kind')).toBe('personal')
    expect(rows[1]!.textContent).not.toContain('企业 ·')
    const restrictedRow = rows.find(row => row.getAttribute('data-restricted') === 'true')
    expect(restrictedRow?.textContent).toContain('受限')
    expect(restrictedRow?.textContent).toContain('恒岳法务')
  })
})

describe('ProductSpaceSelectScreen · 选中与确认', () => {
  it('点击其他行迁移选中且 CTA 文案跟随，确认回调恰携带一次所选 id', () => {
    const { onConfirm } = renderScreen()
    const rows = items()
    fireEvent.click(rows[1]!)
    expect(rows[1]!.getAttribute('data-active')).toBe('true')
    expect(rows[0]!.getAttribute('data-active')).toBe('false')
    expect(screen.getByTestId('product-space-select-confirm').textContent).toBe('进入「我的空间」')
    fireEvent.click(screen.getByTestId('product-space-select-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith(personalId)
  })

  it('选中受限行后显示受限说明，说明不带空间名以外的能力承诺', () => {
    renderScreen({
      spaces: [enterpriseSpace, restrictedEnterprise, personalSpace],
      activeProductSpaceId: 'space-ent',
    })
    expect(screen.queryByTestId('product-space-select-restricted-note')).toBeNull()
    const restrictedRow = items().find(row => row.getAttribute('data-space-id') === 'space-ent-restricted')
    fireEvent.click(restrictedRow!)
    const note = screen.getByTestId('product-space-select-restricted-note')
    expect(note.textContent).toContain('「恒岳法务」当前受限')
    expect(note.textContent).toContain('沿用该空间的既有限制')
    expect(note.textContent).toContain('不会被自动恢复为默认空间')
  })

  it('submitting 期间确认按钮禁用，不产生第二次提交', () => {
    const { onConfirm } = renderScreen({ submitting: true })
    const confirm = screen.getByTestId('product-space-select-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('退出登录回调原样透传，不触发确认；账号块带 aria-label', () => {
    const { onConfirm, onLogout } = renderScreen()
    expect(screen.getByTestId('product-space-select-account').getAttribute('aria-label')).toBe('当前登录账号')
    fireEvent.click(screen.getByTestId('product-space-select-logout'))
    expect(onLogout).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('ProductSpaceSelectScreen · 键盘（listbox 语义）', () => {
  it('ArrowDown/ArrowUp 在列表内移动选中，Enter 等同点击确认按钮', () => {
    const { onConfirm } = renderScreen({
      spaces: [enterpriseSpace, secondEnterprise, personalSpace],
      activeProductSpaceId: 'space-ent',
      selectionSource: 'stored',
    })
    const listbox = screen.getByRole('listbox')
    expect(items()[0]!.getAttribute('data-space-id')).toBe('space-ent')
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    expect(items().find(row => row.getAttribute('data-space-id') === personalId)!.getAttribute('data-active')).toBe('true')
    fireEvent.keyDown(listbox, { key: 'ArrowUp' })
    fireEvent.keyDown(listbox, { key: 'ArrowUp' })
    // 从第一行向上回绕到列表末行（space-ent-2）
    const wrapped = items().find(row => row.getAttribute('data-space-id') === 'space-ent-2')
    expect(wrapped!.getAttribute('data-active')).toBe('true')
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith('space-ent-2')
  })
})
