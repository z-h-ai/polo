import { useLayoutEffect, type CSSProperties } from 'react'
import baseCss from '../../../../../.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css?raw'
import reviewCss from '../../../../../.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css?raw'
import { useOptionalTheme } from '@/context/ThemeContext'

export type WorkbenchStyle = CSSProperties & Record<`--${string}`, string>

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = css.match(new RegExp('(?:^|\\n)' + escaped + '\\s*\\{([^}]+)\\}'))?.[1]
  if (!block) throw new Error('Missing workbench source rule: ' + selector)
  return block
}

function declaration(block: string, name: string): string {
  const value = block.match(new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)'))?.[1]?.trim()
  if (!value) throw new Error('Missing workbench source declaration: ' + name)
  return value
}

/** Read the owned CSS sources in cascade order, including a final declaration
 * without a semicolon. Only tokens and font/focus rules enter the renderer;
 * prototype selectors, demo state and assistant styling never do. */
export function createClientWorkbenchStyle(base: string, review: string): WorkbenchStyle {
  const tokens: Record<`--${string}`, string> = {}
  for (const css of [base, review]) {
    for (const root of css.matchAll(/(?:^|\n):root\s*\{([^}]+)\}/g)) {
      for (const item of root[1]!.matchAll(/(?:^|;)\s*(--[\w-]+)\s*:\s*([^;]+)/g)) {
        tokens[item[1] as `--${string}`] = item[2]!.trim()
      }
    }
  }
  if (!tokens['--surface'] || !tokens['--shadow-panel']) {
    throw new Error('Incomplete current workbench source tokens')
  }
  // Review #6: muted body text must clear WCAG AA. The fg-50 mix measures
  // ~3.3:1 on the workbench surface, so the semantic alias binds to the
  // Spec §13.14 material muted foreground (#60636a), which measures 5.8:1
  // against the #fbfbfa canvas. fg-40/fg-50 stay available for decorative
  // and disabled semantics at their call sites.
  if (!tokens['--client-material-fg-muted']) {
    throw new Error('Missing workbench source muted foreground token')
  }

  // Inherited custom properties have already resolved against the renderer
  // root. Rebind every consumed alias in THIS page/portal scope instead.
  for (const percent of [1.5, 2, 3, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95]) {
    tokens[`--foreground-${percent}`] = tokens[`--fg-${percent}`]
      ? `var(--fg-${percent})`
      : `color-mix(in srgb, var(--foreground) ${percent}%, var(--background))`
  }
  for (const name of ['foreground', 'accent', 'info', 'success', 'destructive']) {
    const hex = tokens[`--${name}`]?.match(/^#([0-9a-f]{6})$/i)?.[1]
    if (!hex) throw new Error('Expected canonical RGB base color: ' + name)
    tokens[`--${name}-rgb`] = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')
  }
  Object.assign(tokens, {
    '--background-elevated': 'var(--surface)',
    '--foreground-dimmed': 'var(--foreground-80)',
    '--card': 'var(--surface)', '--card-foreground': 'var(--foreground)',
    '--popover': 'var(--surface)', '--popover-foreground': 'var(--foreground)',
    '--muted': 'var(--fg-5)', '--muted-foreground': 'var(--client-material-fg-muted)',
    '--secondary': 'var(--fg-5)', '--secondary-foreground': 'var(--foreground)',
    '--primary': 'var(--accent)', '--primary-foreground': 'var(--on-accent)',
    '--input': 'var(--border)', '--ring': 'var(--accent)',
    '--workbench-info': 'var(--info)',
    '--md-bullets': 'var(--fg-50)', '--md-counters': 'var(--fg-50)',
    '--shadow-xs': 'var(--shadow-minimal)', '--shadow-modal-small': 'var(--shadow-panel)',
    '--info-text': 'color-mix(in oklab, var(--info) 50%, var(--foreground))',
    '--success-text': 'color-mix(in oklab, var(--success) 50%, var(--foreground))',
    '--destructive-text': 'color-mix(in oklab, var(--destructive) 50%, var(--foreground))',
  })
  const focus = rule(review, 'button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible')
  tokens['--client-workbench-focus-outline'] = declaration(focus, 'outline')
  tokens['--client-workbench-focus-offset'] = declaration(focus, 'outline-offset')
  const body = rule(base, 'body')
  const fontFamily = declaration(body, 'font-family')
  tokens['--font-sans'] = fontFamily
  tokens['--font-default'] = 'var(--font-sans)'
  return {
    ...tokens, fontFamily,
    // The canonical body uses browser-default line metrics and font features.
    lineHeight: 'normal', fontFeatureSettings: 'normal',
    fontSize: declaration(rule(base, 'html'), 'font-size'),
    fontOpticalSizing: declaration(rule(base, 'html'), 'font-optical-sizing') as CSSProperties['fontOpticalSizing'],
    WebkitFontSmoothing: declaration(body, '-webkit-font-smoothing') as CSSProperties['WebkitFontSmoothing'],
  }
}

const currentLightStyle = Object.freeze(createClientWorkbenchStyle(baseCss, reviewCss))

export function useClientWorkbenchStyle(): WorkbenchStyle | undefined {
  return useOptionalTheme()?.resolvedMode === 'dark' ? undefined : currentLightStyle
}

/** POO-105 默认浅色微透材质（Spec §13.14）：只有 --client-material-* 家族
 * 允许进入宿主作用域；字体、别名与焦点规则仍归完整适配器与其现有消费者。
 * 深色、未标记宿主不投放，材质规则随之失效并回落既有不透明样式。
 * base-background/base-accent 是派生令牌的字面锚点，必须与派生值一起发布，
 * 否则 color-mix 在宿主 root 求值不到。 */
const MATERIAL_TOKEN_NAMES = [
  '--client-material-base-background',
  '--client-material-base-accent',
  '--client-material-canvas',
  '--client-material-list',
  '--client-material-reading',
  '--client-material-card',
  '--client-material-brand',
  '--client-material-blur',
  '--client-material-fg-secondary',
  '--client-material-fg-muted',
  '--client-material-placeholder',
  '--client-material-selected-bg',
  '--client-material-selected-fg',
  '--client-material-disabled-bg',
  '--client-material-disabled-fg',
] as const

export type ClientMaterialTokens = Record<(typeof MATERIAL_TOKEN_NAMES)[number], string>

export function createClientMaterialTokens(review: string): ClientMaterialTokens {
  const tokens: Partial<ClientMaterialTokens> = {}
  for (const root of review.matchAll(/(?:^|\n):root\s*\{([^}]+)\}/g)) {
    for (const item of root[1]!.matchAll(/(?:^|;)\s*(--client-material-[\w-]+)\s*:\s*([^;]+)/g)) {
      tokens[item[1] as keyof ClientMaterialTokens] = item[2]!.trim()
    }
  }
  for (const name of MATERIAL_TOKEN_NAMES) {
    if (!tokens[name]) throw new Error('Missing client material token: ' + name)
  }
  return Object.freeze(tokens as ClientMaterialTokens)
}

const currentMaterialTokens = createClientMaterialTokens(reviewCss)

/**
 * Publish the light-material scope on the renderer root: portals (dialogs,
 * menus) render outside the shell DOM subtree, so the marker and the derived
 * tokens must live on `documentElement` for every scoped rule to see them.
 * Shell and onboarding are mutually exclusive hosts; each calls this once.
 * The scope is gated on the DEFAULT light theme only: `isDark` (unlike
 * `resolvedMode`) also covers scenic wallpapers and dark-only custom themes,
 * and a non-null `presetTheme` is a user-supplied theme file — Spec §13.14
 * excludes dark, custom and Scenic hosts from the light material values.
 * Gate changes remove the marker, which deactivates every material rule.
 * useLayoutEffect keeps the first painted frame from flashing opaque.
 */
export function useClientMaterialScope(): void {
  const theme = useOptionalTheme()
  const inactive = (theme?.isDark ?? false) || theme?.presetTheme != null
  useLayoutEffect(() => {
    const root = document.documentElement
    if (inactive) {
      delete root.dataset.clientMaterial
      return
    }
    root.dataset.clientMaterial = 'light'
    for (const [name, value] of Object.entries(currentMaterialTokens)) {
      root.style.setProperty(name, value)
    }
    return () => {
      delete root.dataset.clientMaterial
      for (const name of Object.keys(currentMaterialTokens)) {
        root.style.removeProperty(name)
      }
    }
  }, [inactive])
}
