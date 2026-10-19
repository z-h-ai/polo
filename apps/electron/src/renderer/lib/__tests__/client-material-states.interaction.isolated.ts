import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

// Bun does not execute Vite import.meta.glob in the theme loader. The holder
// lets each case pick the resolved theme the way ThemeContext would: isDark
// covers scenic/dark-only hosts and presetTheme marks user-supplied themes.
const themeState: {
  mode?: 'light' | 'dark'
  isDark?: boolean
  presetTheme?: object | null
} = {}
mock.module('@/context/ThemeContext', () => ({
  useOptionalTheme: () =>
    themeState.mode === undefined
      ? undefined
      : {
          resolvedMode: themeState.mode,
          isDark: themeState.isDark ?? themeState.mode === 'dark',
          presetTheme: themeState.presetTheme ?? null,
        },
}))

GlobalRegistrator.register()

const { createClientMaterialTokens, useClientMaterialScope } = await import('../client-workbench-style')
const review = (await import('../../../../../../.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css?raw')).default
const rendererCss = (await import('../../index.css?raw')).default
const { clientWorkbenchDialogClassName, clientWorkbenchMenuClassName, clientWorkbenchPrimaryClassName, clientWorkbenchButtonClassName, clientWorkbenchDestructiveClassName } = await import('@/components/ui/client-workbench')

const { act, cleanup, render } = await import('@testing-library/react')

const CANVAS = 'color-mix(in srgb,var(--client-material-base-background) 93%,transparent)'
const LIST = 'color-mix(in srgb,var(--surface) 94%,transparent)'
const READING = 'color-mix(in srgb,var(--surface) 99%,transparent)'
const CARD = 'color-mix(in srgb,var(--surface) 98%,transparent)'
const BRAND = 'color-mix(in srgb,#f7f7f8 94%,transparent)'
const SELECTED_BG = 'color-mix(in srgb,var(--client-material-base-accent) 9%,transparent)'
// Spec §13.14 前景/禁用族是合同字面色（不是从宿主基色派生的值）。
const PLACEHOLDER = '#676a73'
const DISABLED_BG = '#e2e4e8'
const DISABLED_FG = '#747983'

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.clientMaterial
  themeState.mode = undefined
  themeState.isDark = undefined
  themeState.presetTheme = undefined
})

function MaterialHost() {
  useClientMaterialScope()
  return null
}

describe('POO-105 client material tokens', () => {
  it('extracts the full material family from the canonical review source', () => {
    const tokens = createClientMaterialTokens(review)
    expect(tokens['--client-material-base-background']).toBe('#fbfbfa')
    expect(tokens['--client-material-base-accent']).toBe('#6e56cf')
    expect(tokens['--client-material-canvas']).toBe(CANVAS)
    expect(tokens['--client-material-list']).toBe(LIST)
    expect(tokens['--client-material-reading']).toBe(READING)
    expect(tokens['--client-material-card']).toBe(CARD)
    expect(tokens['--client-material-blur']).toBe('24px')
    expect(tokens['--client-material-fg-secondary']).toBe('#45474f')
    expect(tokens['--client-material-fg-muted']).toBe('#60636a')
    expect(tokens['--client-material-placeholder']).toBe(PLACEHOLDER)
    expect(tokens['--client-material-selected-bg']).toBe(SELECTED_BG)
    expect(tokens['--client-material-selected-fg']).toBe('#392d65')
    expect(tokens['--client-material-disabled-bg']).toBe(DISABLED_BG)
    expect(tokens['--client-material-disabled-fg']).toBe(DISABLED_FG)
    expect(tokens['--client-material-brand']).toBe(BRAND)
  })

  it('fails visibly when the owned source loses a material token', () => {
    const broken = review.replace('--client-material-canvas:', '--client-material-missing:')
    expect(() => createClientMaterialTokens(broken)).toThrow('--client-material-canvas')
  })

  it('publishes the light scope on the renderer root so portals inherit it', () => {
    render(createElement(MaterialHost))
    expect(document.documentElement.dataset.clientMaterial).toBe('light')
    expect(document.documentElement.style.getPropertyValue('--client-material-canvas')).toBe(CANVAS)
    expect(document.documentElement.style.getPropertyValue('--client-material-list')).toBe(LIST)
    expect(document.documentElement.style.getPropertyValue('--client-material-reading')).toBe(READING)
    expect(document.documentElement.style.getPropertyValue('--client-material-card')).toBe(CARD)
    expect(document.documentElement.style.getPropertyValue('--client-material-placeholder')).toBe(PLACEHOLDER)
    expect(document.documentElement.style.getPropertyValue('--client-material-disabled-bg')).toBe(DISABLED_BG)
    expect(document.documentElement.style.getPropertyValue('--client-material-disabled-fg')).toBe(DISABLED_FG)
  })

  it('retracts marker and tokens on unmount and never publishes outside the default light theme', () => {
    const { unmount } = render(createElement(MaterialHost))
    expect(document.documentElement.dataset.clientMaterial).toBe('light')
    unmount()
    expect(document.documentElement.dataset.clientMaterial).toBeUndefined()
    expect(document.documentElement.style.getPropertyValue('--client-material-canvas')).toBe('')

    // 深色（含 scenic/dark-only 的 isDark）不投放。
    themeState.mode = 'light'
    themeState.isDark = true
    render(createElement(MaterialHost))
    expect(document.documentElement.dataset.clientMaterial).toBeUndefined()
    unmount()

    // 自定义主题文件（presetTheme）不投放——材质只属于默认浅色主题。
    themeState.isDark = undefined
    themeState.presetTheme = { id: 'custom' }
    render(createElement(MaterialHost))
    expect(document.documentElement.dataset.clientMaterial).toBeUndefined()
    expect(document.documentElement.style.getPropertyValue('--client-material-canvas')).toBe('')
  })

  it('keeps the foreground contract solid: literal hex, never alpha carriers', () => {
    // 透明度只作用于背景色：材质规则里的前景/placeholder/禁用值必须是
    // 合同字面实色（Spec §13.14 直接点名 hex），不允许 rgba/透明形式。
    for (const name of ['--client-material-fg-secondary', '--client-material-fg-muted', '--client-material-placeholder', '--client-material-disabled-fg', '--client-material-disabled-bg', '--client-material-selected-fg']) {
      const value = createClientMaterialTokens(review)[name as '--client-material-fg-secondary']
      expect(value).toMatch(/^#[0-9a-f]{6}$/i)
    }
    const selected = createClientMaterialTokens(review)['--client-material-selected-bg']
    // 选中背景是唯一的强调色透明载体：accent 9%。
    expect(selected).toBe('color-mix(in srgb,var(--client-material-base-accent) 9%,transparent)')
  })

  it('wires the semantic classes into the owned portal compositions', () => {
    expect(clientWorkbenchDialogClassName).toContain('client-material-card')
    expect(clientWorkbenchMenuClassName).toContain('client-material-card')
    expect(clientWorkbenchPrimaryClassName).toContain('client-material-control')
    expect(clientWorkbenchButtonClassName).toContain('client-material-control')
    expect(clientWorkbenchDestructiveClassName).toContain('client-material-control')
  })

  it('keeps the scoped rules and the BG-01 header contract in the renderer css', () => {
    for (const selector of [
      "[data-client-material='light'] .client-material-canvas",
      "[data-client-material='light'] .client-material-bar",
      "[data-client-material='light'] .client-material-list",
      "[data-client-material='light'] .client-material-reading",
      "[data-client-material='light'] .client-material-card",
      "[data-client-material='light'] .client-material-brand",
      "[data-client-material='light'] .client-material-fg-secondary",
      "[data-client-material='light'] .client-material-fg-muted",
      "[data-client-material='light'] input::placeholder",
      "[data-client-material='light'] .client-material-selected",
      "[data-client-material='light'] .client-material-control:disabled",
      "[data-client-material='light'] .client-material-action:disabled",
      "[data-client-material='light'] .client-material-input-disabled",
    ]) {
      expect(rendererCss).toContain(selector)
    }
    // Header 与底板同层：bar 不画第二块色板（背景透明让画布板透出），
    // blur 只为滚动内容穿过 fixed bar 提供可读性；任何滚动态无细线。
    const barBlock = rendererCss.match(/\[data-client-material='light'\] \.client-material-bar \{([^}]+)\}/)?.[1] ?? ''
    expect(barBlock).toContain('background: transparent')
    expect(barBlock).toContain('border-bottom-color: transparent')
    expect(barBlock).toContain('backdrop-filter: blur(var(--client-material-blur))')
    // 选中合同落在两处：9% 背景 + 深紫文字。
    const selectedBlock = rendererCss.match(/\[data-client-material='light'\] \.client-material-selected \{([^}]+)\}/)?.[1] ?? ''
    expect(selectedBlock).toContain('background: var(--client-material-selected-bg)')
    expect(selectedBlock).toContain('color: var(--client-material-selected-fg)')
    // 材质规则在层外压掉 hover utility，需配套 hover 语义类；禁用无容器淡化
    // 且光标表态。
    expect(rendererCss).toContain("[data-client-material='light'] .client-material-fg-hover:hover")
    const actionBlock = rendererCss.match(/\[data-client-material='light'\] \.client-material-action:disabled \{([^}]+)\}/)?.[1] ?? ''
    expect(actionBlock).toContain('opacity: 1')
    expect(actionBlock).toContain('cursor: not-allowed')
  })
})
