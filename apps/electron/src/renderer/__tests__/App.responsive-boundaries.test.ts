import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Review R31/R32 responsive-boundary contract, proven against the COMPILED
 * renderer CSS produced by `bun run electron:build` (Vite/Tailwind output):
 *
 *   width ≤ 760px   → mobile    (base styles)
 *   width 761–1080  → tablet    (min-[761px] overrides)
 *   width ≥ 1081px  → desktop   (min-[1081px] overrides)
 *
 * Tailwind v4 compiles `max-[760px]` as width < 760px (exclusive), which
 * would break the inclusive frozen boundaries. The Home launcher therefore
 * expresses mobile/tablet-first base styles with `min-[761px]` /
 * `min-[1081px]` overrides, and this test pins the EMITTED media-query
 * semantics so the contract cannot regress.
 */
const assetsDir = join(import.meta.dir, '..', '..', '..', 'dist', 'renderer', 'assets')

function compiledRendererCss(): string {
  if (!existsSync(assetsDir)) {
    throw new Error('renderer assets missing — run `bun run electron:build` before this test')
  }
  const cssFiles = readdirSync(assetsDir)
    .filter(name => name.startsWith('index-') && name.endsWith('.css'))
  if (cssFiles.length === 0) {
    throw new Error('no compiled index-*.css found — run `bun run electron:build` before this test')
  }
  return readFileSync(join(assetsDir, cssFiles[0]!), 'utf8')
}

function mediaBodies(css: string, mediaQuery: string): string[] {
  // Extract the bodies of every `@media <mediaQuery> { ... }` block (single
  // nesting level is sufficient for Tailwind utility output).
  const bodies: string[] = []
  const marker = `@media${mediaQuery}`
  let index = css.indexOf(marker)
  while (index !== -1) {
    let depth = 0
    let bodyStart = -1
    for (let i = index + marker.length; i < css.length; i++) {
      const ch = css[i]
      if (ch === '{') {
        depth += 1
        if (depth === 1) bodyStart = i + 1
      } else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          bodies.push(css.slice(bodyStart, i))
          break
        }
      }
    }
    index = css.indexOf(marker, index + marker.length)
  }
  return bodies
}

describe('Home launcher responsive-boundary contract (compiled CSS)', () => {
  const css = compiledRendererCss()

  it('emits NO exclusive max-width media queries at 760px or 1080px', () => {
    expect(css.includes('max-width: 760px')).toBe(false)
    expect(css.includes('max-width: 1080px')).toBe(false)
  })

  it('includes 760px in the mobile base: hero stacks and launcher cards use the compact geometry', () => {
    // Base styles sit OUTSIDE every media query, so they govern ≤760px.
    expect(css.includes('.min-h-\\[210px\\]{min-height:210px}')).toBe(true)
    expect(css.includes('.p-\\[18px\\]{padding:18px}')).toBe(true)
    expect(css.includes('.flex-col')).toBe(true)
    expect(css.includes('.items-start')).toBe(true)
  })

  it('switches to tablet semantics at exactly 761px: hero row with bottom-aligned side action', () => {
    const bodies = mediaBodies(css, '(min-width:761px)')
    expect(bodies.length).toBeGreaterThan(0)
    const joined = bodies.join('\n')
    expect(joined.includes('.min-\\[761px\\]\\:flex-row{flex-direction:row}')).toBe(true)
    expect(joined.includes('.min-\\[761px\\]\\:items-end{align-items:flex-end}')).toBe(true)
    expect(joined.includes('.min-\\[761px\\]\\:px-\\[26px\\]{padding-inline:26px}')).toBe(true)
    expect(joined.includes('.min-\\[761px\\]\\:pt-\\[36px\\]{padding-top:36px}')).toBe(true)
  })

  it('keeps 1080px in tablet and switches to desktop at exactly 1081px: full-size launcher cards', () => {
    const bodies = mediaBodies(css, '(min-width:1081px)')
    expect(bodies.length).toBeGreaterThan(0)
    const joined = bodies.join('\n')
    expect(joined.includes('.min-\\[1081px\\]\\:min-h-\\[222px\\]{min-height:222px}')).toBe(true)
    expect(joined.includes('.min-\\[1081px\\]\\:p-\\[20px\\]{padding:20px}')).toBe(true)
    expect(joined.includes('.min-\\[1081px\\]\\:px-\\[44px\\]{padding-inline:44px}')).toBe(true)
    expect(joined.includes('.min-\\[1081px\\]\\:pt-\\[46px\\]{padding-top:46px}')).toBe(true)
  })
})
