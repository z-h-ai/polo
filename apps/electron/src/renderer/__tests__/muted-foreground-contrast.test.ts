import { describe, expect, it, mock } from 'bun:test'

// Review #6: secondary text must actually clear WCAG AA. These assertions
// pin the muted-foreground token VALUES (not just "not fg-50") by computing
// WCAG contrast ratios from the declared colors, so a regression below the
// 4.5:1 line fails here with the measured number in the message.

mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))
const indexCss = (await import('../index.css?raw')).default
const base = (await import('../../../../../.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css?raw')).default
const review = (await import('../../../../../.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css?raw')).default
const { createClientWorkbenchStyle } = await import('../lib/client-workbench-style')

const AA_NORMAL_TEXT = 4.5

/** oklch() → gamma sRGB (CSS Color 4 matrices), rounded to 8-bit like the
 * compositor does before blending/reporting. */
function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  const gamma = (c: number): number => {
    const clamped = Math.min(1, Math.max(0, c))
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
  }
  return [gamma(r), gamma(g), gamma(bl)].map(v => Math.round(v * 255)) as [number, number, number]
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map(c => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

function parseOklch(value: string): [number, number, number] {
  const m = value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/)
  if (!m) throw new Error('Not an oklch value: ' + value)
  return oklchToRgb(Number(m[1]), Number(m[2]), Number(m[3]))
}

/** Extract `--name` from the given `:root { … }` / `.dark { … }` block. */
function tokenIn(css: string, scopePattern: RegExp, name: string): string {
  const scope = css.match(scopePattern)?.[1]
  const value = scope?.match(new RegExp(name.replace(/-/g, '\\-') + '\\s*:\\s*([^;]+)'))?.[1]?.trim()
  if (!value) throw new Error('Missing token ' + name + ' in scope')
  return value
}

describe('muted-foreground token clears WCAG AA in each theme', () => {
  it('light theme: oklch(0.52 0.012 270) ≥ 4.5:1 against the light background', () => {
    const muted = tokenIn(indexCss, /:root\s*\{([^}]+)\}/, '--muted-foreground')
    expect(muted).toMatch(/oklch\(0\.52\s+0\.012\s+270\)/)
    const bg = tokenIn(indexCss, /:root\s*\{([^}]+)\}/, '--background')
    const ratio = contrastRatio(parseOklch(muted), parseOklch(bg))
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })

  it('dark theme: its own value (never the light one) ≥ 4.5:1 against the dark background', () => {
    const darkScope = indexCss.match(/^\.dark\s*\{([^}]+)\}/m)
    expect(darkScope).not.toBeNull()
    const muted = darkScope![1]!.match(/--muted-foreground\s*:\s*([^;]+)/)?.[1]!.trim()!
    const background = darkScope![1]!.match(/--background\s*:\s*([^;]+)/)?.[1]!.trim()!
    // The light value must not leak into the dark scope.
    expect(muted).not.toBe('oklch(0.52 0.012 270)')
    expect(muted).toMatch(/^oklch\(0\.7/)
    const ratio = contrastRatio(parseOklch(muted), parseOklch(background))
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })

  it('workbench material scope: muted alias resolves to the §13.14 value ≥ 4.5:1 on the canvas', () => {
    const style = createClientWorkbenchStyle(base, review)
    expect(style['--muted-foreground']).toBe('var(--client-material-fg-muted)')
    // Resolve the alias against the tokens shipped in the same adapter output.
    const materialMuted = style['--client-material-fg-muted']!
    expect(materialMuted).toMatch(/^#[0-9a-f]{6}$/i)
    const canvas = style['--background']!
    const ratio = contrastRatio(hexToRgb(materialMuted), hexToRgb(canvas))
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  })
})

describe('frozen POO-41 surface overrides stay at or above the AA line', () => {
  it('light frozen surfaces keep oklch(0.52 …), dark frozen surfaces their own value', () => {
    const lightFrozen = indexCss.match(/--muted-foreground:\s*oklch\(0\.52 0\.012 270\)/g) ?? []
    const darkFrozen = indexCss.match(/\.dark [^{]*\{[^}]*--muted-foreground:\s*oklch\(0\.68 0\.01 270\)/g) ?? []
    expect(lightFrozen.length).toBeGreaterThanOrEqual(2) // home hub + catalog
    expect(darkFrozen.length).toBeGreaterThanOrEqual(1)
  })
})
