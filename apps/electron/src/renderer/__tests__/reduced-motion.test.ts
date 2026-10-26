import { describe, expect, it, mock } from 'bun:test'

// Review #4: the OS "reduce motion" setting must be actually consumed — the
// CSS fallback must survive the client-workbench token extraction (which only
// lifts :root{} custom properties from the design-system sources), and the
// Framer Motion side must consume the same setting, not fake it via CSS.

mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))
const indexCss = (await import('../index.css?raw')).default
const mainTsx = (await import('../main.tsx?raw')).default
const base = (await import('../../../../../.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css?raw')).default
const review = (await import('../../../../../.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css?raw')).default
const { createClientWorkbenchStyle } = await import('../lib/client-workbench-style')

describe('reduced-motion fallback in the renderer stylesheet', () => {
  it('declares the prefers-reduced-motion media query with pseudo-elements', () => {
    const query = indexCss.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/)
    expect(query).not.toBeNull()
    const body = query![0]
    expect(body).toContain('*::before')
    expect(body).toContain('*::after')
    expect(body).toContain('transition: none !important')
    expect(body).toContain('animation: none !important')
    expect(body).toContain('scroll-behavior: auto !important')
  })
})

describe('the media query survives the workbench token extraction', () => {
  it('extraction lifts only custom properties, never motion declarations', () => {
    const style = createClientWorkbenchStyle(base, review)
    // Real CSS properties in the adapter output (fontFamily, lineHeight, …)
    // must stay free of motion declarations; `--transition-*` duration tokens
    // are values, not declarations, and don't override the media query.
    const propertyKeys = Object.keys(style).filter(key => !key.startsWith('--'))
    expect(propertyKeys.length).toBeGreaterThan(0)
    for (const key of propertyKeys) {
      expect(key).not.toMatch(/transition|animation|scroll-behavior/)
      expect(String(style[key as keyof typeof style])).not.toMatch(
        /transition|animation:\s|scroll-behavior/)
    }
  })

  it('so the document-level media query stays authoritative for every scope', () => {
    // The design-system source also ships the rule, but its rules are dropped
    // by the token pipeline — only index.css reaches the live document.
    expect(review).toMatch(/@media\(prefers-reduced-motion:reduce\)/)
    expect(indexCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
  })
})

describe('Framer Motion consumes the system setting', () => {
  it('mounts MotionConfig with reducedMotion="user" around the app root', () => {
    expect(mainTsx).toMatch(/<MotionConfig\s+reducedMotion="user">/)
    expect(mainTsx).toMatch(/from 'motion\/react'/)
  })
})
