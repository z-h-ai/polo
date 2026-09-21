import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Repo root: __tests__ -> hifi -> components -> renderer -> src -> electron -> apps -> root
const REPO_ROOT = join(import.meta.dir, '../../../../../../../')
const G4_CSS_PATH = join(REPO_ROOT, 'docs/mvp-complete-flow-hifi/sources/g4-product.css')
const TOKENS_CSS_PATH = join(import.meta.dir, '../tokens.css')

/**
 * Extracts `--custom-prop: value;` pairs from the first rule matching
 * `selector` (must include the opening brace, e.g. `':root {'`).
 */
function parseCustomProperties(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`selector not found: ${selector}`)
  const open = css.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) throw new Error(`unbalanced block for selector: ${selector}`)
  const body = css.slice(open + 1, end)
  const vars: Record<string, string> = {}
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[match[1]!] = match[2]!.replace(/\s+/g, ' ').trim()
  }
  return vars
}

/** Makes a `--hifi-*` value comparable to its g4 source (var refs unprefixed). */
function normalizeValue(value: string): string {
  return value.replace(/var\(--hifi-/g, 'var(--').replace(/\s+/g, ' ').trim()
}

const g4Css = readFileSync(G4_CSS_PATH, 'utf-8')
const tokensCss = readFileSync(TOKENS_CSS_PATH, 'utf-8')

const g4Root = parseCustomProperties(g4Css, ':root {')
const g4Dark = parseCustomProperties(g4Css, '[data-theme="dark"] {')
const hifiRoot = parseCustomProperties(tokensCss, ':root {')
const hifiDark = parseCustomProperties(tokensCss, '.dark {')

describe('hifi tokens.css parity with g4-product.css', () => {
  it('defines every g4 :root token as --hifi-* with an identical value', () => {
    const missing: string[] = []
    const mismatches: string[] = []
    for (const [name, g4Value] of Object.entries(g4Root)) {
      const hifiName = `--hifi-${name.replace(/^--/, '')}`
      const hifiValue = hifiRoot[hifiName]
      if (hifiValue === undefined) {
        missing.push(hifiName)
        continue
      }
      if (normalizeValue(hifiValue) !== normalizeValue(g4Value)) {
        mismatches.push(`${hifiName}: ${normalizeValue(hifiValue)} != ${normalizeValue(g4Value)}`)
      }
    }
    expect(missing).toEqual([])
    expect(mismatches).toEqual([])
  })

  it('keeps every --hifi-* token whose unprefixed name exists in g4 in sync', () => {
    const mismatches: string[] = []
    for (const [hifiName, hifiValue] of Object.entries(hifiRoot)) {
      const g4Name = hifiName.replace(/^--hifi-/, '--')
      const g4Value = g4Root[g4Name]
      if (g4Value === undefined) continue // hifi-only additions (type ladder etc.)
      if (normalizeValue(hifiValue) !== normalizeValue(g4Value)) {
        mismatches.push(`${hifiName}: ${normalizeValue(hifiValue)} != ${normalizeValue(g4Value)}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('defines every g4 dark-theme token in the .dark block with an identical value', () => {
    const missing: string[] = []
    const mismatches: string[] = []
    for (const [name, g4Value] of Object.entries(g4Dark)) {
      const hifiName = `--hifi-${name.replace(/^--/, '')}`
      const hifiValue = hifiDark[hifiName]
      if (hifiValue === undefined) {
        missing.push(hifiName)
        continue
      }
      if (normalizeValue(hifiValue) !== normalizeValue(g4Value)) {
        mismatches.push(`${hifiName}: ${normalizeValue(hifiValue)} != ${normalizeValue(g4Value)}`)
      }
    }
    expect(missing).toEqual([])
    expect(mismatches).toEqual([])
  })

  it('covers the full g4 foreground-mix ladder the HiFi screens rely on', () => {
    for (const step of [3, 5, 10, 20, 40, 50, 60, 70, 80]) {
      expect(hifiRoot[`--hifi-fg-${step}`]).toBeDefined()
    }
  })

  it('wires the tokens into the Tailwind v4 theme namespaces', () => {
    expect(tokensCss).toContain('--color-hifi-surface: var(--hifi-surface)')
    expect(tokensCss).toContain('--color-hifi-fg-50: var(--hifi-fg-50)')
    expect(tokensCss).toContain('--color-hifi-accent-soft: var(--hifi-accent-soft)')
    expect(tokensCss).toContain('--radius-hifi-md: var(--hifi-radius-md)')
    expect(tokensCss).toContain('--radius-hifi-card: var(--hifi-radius-card)')
    expect(tokensCss).toContain('--text-hifi-md: var(--hifi-font-size-md)')
    // index.css must import the token sheet (only additive change allowed).
    const indexCss = readFileSync(join(REPO_ROOT, 'apps/electron/src/renderer/index.css'), 'utf-8')
    expect(indexCss).toContain('components/hifi/tokens.css')
  })
})
