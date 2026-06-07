import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SETTINGS_ITEMS } from '../menu-schema'
import { parseRoute } from '../route-parser'
import { isValidSettingsSubpage, SETTINGS_PAGES, VALID_SETTINGS_SUBPAGES } from '../settings-registry'

const repoRoot = fileURLToPath(new URL('../../../../..', import.meta.url))
const rendererRoot = join(repoRoot, 'apps/electron/src/renderer')

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      if (entry === '__tests__') return []
      return collectSourceFiles(path)
    }
    return /\.(ts|tsx)$/.test(entry) ? [path] : []
  })
}

describe('settings registry after removing manual model configuration', () => {
  it('does not expose the removed settings route in shared registries or direct URL parsing', () => {
    expect(SETTINGS_PAGES.map((page) => page.id)).not.toContain('ai')
    expect(VALID_SETTINGS_SUBPAGES).not.toContain('ai')
    expect(SETTINGS_ITEMS.map((item) => item.id)).not.toContain('ai')
    expect(isValidSettingsSubpage('ai')).toBe(false)
    expect(parseRoute('settings/ai')).toBeNull()
  })

  it('has no production renderer references to the removed settings page or setup controls', () => {
    const removedTerms = [
      ['Ai', 'Settings', 'Page'].join(''),
      ['api', 'setup'].join(''),
      ['Api', 'Key', 'Input'].join(''),
      ['OAuth', 'Connect'].join(''),
    ]

    const matches = collectSourceFiles(rendererRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return removedTerms
        .filter((term) => source.includes(term))
        .map((term) => `${relative(repoRoot, path)}: ${term}`)
    })

    expect(matches).toEqual([])
  })
})
