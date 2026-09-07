import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Review R31/R32 responsive-boundary contract, proven against the FRESH
 * manifest-selected renderer CSS produced by `bun run electron:build`
 * (Vite emits `.vite/manifest.json` because the renderer build sets
 * `build.manifest: true`).
 *
 *   width ≤ 760px   → mobile    (base styles)
 *   width 761–1080  → tablet    (min-[761px] overrides)
 *   width ≥ 1081px  → desktop   (min-[1081px] overrides)
 *
 * Tailwind v4 compiles `max-[760px]` as width < 760px (exclusive), which
 * would break the inclusive frozen boundaries. The Home launcher therefore
 * expresses mobile/tablet-first base styles with `min-[761px]` /
 * `min-[1081px]` overrides, and this test pins the EMITTED media-query
 * semantics of those exact Home launcher utilities so the contract cannot
 * regress.
 */
const rendererDist = join(import.meta.dir, '..', '..', '..', 'dist', 'renderer')
const manifestPath = join(rendererDist, '.vite', 'manifest.json')

interface ViteManifestEntry {
  file?: string
  css?: string[]
  src?: string
  isEntry?: boolean
  imports?: string[]
}

function manifestSelectedRendererCss(): string {
  if (!existsSync(manifestPath)) {
    throw new Error(
      'dist/renderer/.vite/manifest.json missing — run `bun run electron:build` (build.manifest: true) before this test',
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, ViteManifestEntry>
  // The Home route lives in the main renderer entry (src/renderer/index.html).
  // Vite attaches CSS to the ENTRY/CHUNK nodes of the import graph, so the
  // authoritative selection = walk imports from the entry and collect the
  // union of `css` arrays.
  const entryKey = Object.keys(manifest).find(
    key => key.endsWith('index.html') && manifest[key]?.isEntry,
  )
  if (!entryKey) {
    throw new Error('manifest has no isEntry for index.html — stale build output?')
  }
  const visited = new Set<string>()
  const cssFiles: string[] = []
  const walk = (key: string): void => {
    if (visited.has(key)) return
    visited.add(key)
    const node = manifest[key]
    if (!node) return
    for (const css of node.css ?? []) cssFiles.push(css)
    for (const imported of node.imports ?? []) walk(imported)
  }
  walk(entryKey)
  const uniqueCss = [...new Set(cssFiles)]
  if (uniqueCss.length !== 1) {
    throw new Error(
      `expected exactly one manifest-selected CSS asset for the renderer entry graph, got ${uniqueCss.length}: ${uniqueCss.join(', ')}`,
    )
  }
  return readFileSync(join(rendererDist, uniqueCss[0]!), 'utf8')
}

/** Strip ALL whitespace so minified media-query spacing cannot matter. */
function flatten(css: string): string {
  return css.replace(/\s+/g, '')
}

/** Extract the flattened bodies of every `@media <query> { ... }` block. */
function mediaBodies(flatCss: string, mediaQuery: string): string[] {
  const marker = `@media${mediaQuery}`
  const bodies: string[] = []
  let index = flatCss.indexOf(marker)
  while (index !== -1) {
    let depth = 0
    let bodyStart = -1
    for (let i = index + marker.length; i < flatCss.length; i++) {
      const ch = flatCss[i]
      if (ch === '{') {
        depth += 1
        if (depth === 1) bodyStart = i + 1
      } else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          bodies.push(flatCss.slice(bodyStart, i))
          break
        }
      }
    }
    index = flatCss.indexOf(marker, index + marker.length)
  }
  return bodies
}

/** The block with NO media query (the ≤760px mobile base layer). */
function baseBodies(flatCss: string): string {
  // Remove every media block, leaving only unconditionally-emitted rules.
  let out = flatCss
  for (const marker of ['@media(min-width:761px)', '@media(min-width:1081px)']) {
    let index = out.indexOf(marker)
    while (index !== -1) {
      let depth = 0
      for (let i = index + marker.length; i < out.length; i++) {
        const ch = out[i]
        if (ch === '{') depth += 1
        else if (ch === '}') {
          depth -= 1
          if (depth === 0) {
            out = out.slice(0, index) + out.slice(i + 1)
            index = out.indexOf(marker)
            break
          }
        }
      }
    }
  }
  return out
}

describe('Home launcher responsive-boundary contract (manifest-selected compiled CSS)', () => {
  const flatCss = flatten(manifestSelectedRendererCss())
  const tabletBlocks = mediaBodies(flatCss, '(min-width:761px)')
  const desktopBlocks = mediaBodies(flatCss, '(min-width:1081px)')
  const base = baseBodies(flatCss)

  it('emits the Home launcher tablet rules ONLY inside the 761px block', () => {
    expect(tabletBlocks.length).toBeGreaterThan(0)
    const joined = tabletBlocks.join('\n')
    expect(joined.includes('.min-\\[761px\\]\\:flex-row{flex-direction:row}')).toBe(true)
    expect(joined.includes('.min-\\[761px\\]\\:items-end{align-items:flex-end}')).toBe(true)
    expect(joined.includes('.min-\\[761px\\]\\:px-\\[26px\\]{padding-inline:26px}')).toBe(true)
    expect(joined.includes('.min-\\[761px\\]\\:pt-\\[36px\\]{padding-top:36px}')).toBe(true)
    expect(joined.includes('.min-\\[761px\\]\\:pb-\\[58px\\]{padding-bottom:58px}')).toBe(true)
    // Absence from conflicting layers: the hero row/tablet padding rules must
    // NOT appear in the desktop block or the mobile base layer.
    const desktopJoined = desktopBlocks.join('\n')
    expect(desktopJoined.includes('.min-\\[761px\\]\\:flex-row{flex-direction:row}')).toBe(false)
    expect(desktopJoined.includes('.min-\\[761px\\]\\:px-\\[26px\\]{padding-inline:26px}')).toBe(false)
    expect(base.includes('.min-\\[761px\\]\\:flex-row{flex-direction:row}')).toBe(false)
    expect(base.includes('.min-\\[761px\\]\\:px-\\[26px\\]{padding-inline:26px}')).toBe(false)
  })

  it('emits the Home launcher desktop rules ONLY inside the 1081px block', () => {
    expect(desktopBlocks.length).toBeGreaterThan(0)
    const joined = desktopBlocks.join('\n')
    expect(joined.includes('.min-\\[1081px\\]\\:min-h-\\[222px\\]{min-height:222px}')).toBe(true)
    expect(joined.includes('.min-\\[1081px\\]\\:p-\\[20px\\]{padding:20px}')).toBe(true)
    expect(joined.includes('.min-\\[1081px\\]\\:px-\\[44px\\]{padding-inline:44px}')).toBe(true)
    expect(joined.includes('.min-\\[1081px\\]\\:pt-\\[46px\\]{padding-top:46px}')).toBe(true)
    expect(joined.includes('.min-\\[1081px\\]\\:pb-\\[72px\\]{padding-bottom:72px}')).toBe(true)
    // Absence from conflicting layers: the desktop geometry must NOT appear
    // in the 761px block or the mobile base layer.
    const tabletJoined = tabletBlocks.join('\n')
    expect(tabletJoined.includes('.min-\\[1081px\\]\\:min-h-\\[222px\\]{min-height:222px}')).toBe(false)
    expect(tabletJoined.includes('.min-\\[1081px\\]\\:p-\\[20px\\]{padding:20px}')).toBe(false)
    expect(base.includes('.min-\\[1081px\\]\\:min-h-\\[222px\\]{min-height:222px}')).toBe(false)
    expect(base.includes('.min-\\[1081px\\]\\:p-\\[20px\\]{padding:20px}')).toBe(false)
  })

  it('keeps 760px in the mobile base: compact launcher geometry without any media query', () => {
    expect(base.includes('.min-h-\\[210px\\]{min-height:210px}')).toBe(true)
    expect(base.includes('.p-\\[18px\\]{padding:18px}')).toBe(true)
    expect(base.includes('.flex-col{flex-direction:column}')).toBe(true)
    expect(base.includes('.items-start{align-items:flex-start}')).toBe(true)
    // The compact mobile geometry must NOT be re-emitted under the tablet or
    // desktop min-width blocks (those layers widen the geometry instead).
    const tabletJoined = tabletBlocks.join('\n')
    const desktopJoined = desktopBlocks.join('\n')
    expect(tabletJoined.includes('.min-h-\\[210px\\]{min-height:210px}')).toBe(false)
    expect(desktopJoined.includes('.min-h-\\[210px\\]{min-height:210px}')).toBe(false)
    expect(tabletJoined.includes('.p-\\[18px\\]{padding:18px}')).toBe(false)
    expect(desktopJoined.includes('.p-\\[18px\\]{padding:18px}')).toBe(false)
  })

  it('covers the full 760/761/1080/1081 contract: exactly the two inclusive min-width boundaries for the Home launcher', () => {
    // The ONLY min-width boundaries the Home launcher utilities participate
    // in are 761px and 1081px — no other min-width media query may carry
    // Home launcher geometry rules.
    const otherBoundaries = new Set<string>()
    for (const match of flatCss.matchAll(/@media\(min-width:(\d+px)\)/g)) {
      const boundary = match[1]!
      if (boundary !== '761px' && boundary !== '1081px') otherBoundaries.add(boundary)
    }
    for (const boundary of otherBoundaries) {
      for (const body of mediaBodies(flatCss, `(min-width:${boundary})`)) {
        expect(body.includes('.min-\\[1081px\\]\\:min-h-\\[222px\\]')).toBe(false)
        expect(body.includes('.min-\\[1081px\\]\\:p-\\[20px\\]')).toBe(false)
        expect(body.includes('.min-\\[761px\\]\\:flex-row')).toBe(false)
        expect(body.includes('.min-\\[761px\\]\\:px-\\[26px\\]')).toBe(false)
      }
    }
  })
})
