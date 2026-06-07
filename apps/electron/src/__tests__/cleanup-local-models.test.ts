import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const repoRoot = join(import.meta.dir, '../../../..')

const productionExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.svg', '.md'])
const removedProvider = ['ol', 'lama'].join('')
const removedCamel = ['local', 'Model'].join('')
const removedPascal = ['Local', 'Model'].join('')
const removedWords = ['local', 'model'].join(' ')
const removedLlmWords = ['local', 'llm'].join(' ')
const removedStep = ['Local', 'Model', 'Step'].join('')
const removedSourcePattern = new RegExp(
  `${removedProvider}|${removedCamel}|${removedPascal}|${removedWords}|${removedLlmWords}`,
  'i',
)

function extensionOf(path: string): string {
  const match = /\.[^.]+$/.exec(path)
  return match?.[0] ?? ''
}

function collectProductionFiles(root: string): string[] {
  if (!existsSync(root)) return []

  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry)
    const stat = statSync(path)

    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') return []
      return collectProductionFiles(path)
    }

    return stat.isFile() && productionExtensions.has(extensionOf(path)) ? [path] : []
  })
}

function sourceMatches(root: string, pattern: RegExp): string[] {
  return collectProductionFiles(root)
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(repoRoot, path))
    .sort()
}

describe('keyless endpoint cleanup contract', () => {
  it('removes keyless endpoint references from production source', () => {
    const matches = [
      ...sourceMatches(join(repoRoot, 'apps'), removedSourcePattern),
      ...sourceMatches(join(repoRoot, 'packages'), removedSourcePattern),
    ]

    expect(matches).toEqual([])
  })

  it('removes the deleted setup step and removed provider variants', () => {
    const removedPaths = [
      `apps/electron/src/renderer/components/onboarding/${removedStep}.tsx`,
      `apps/electron/src/renderer/assets/provider-icons/${removedProvider}.svg`,
    ]

    expect(removedPaths.filter((path) => existsSync(join(repoRoot, path)))).toEqual([])

    const matches = [
      ...sourceMatches(
        join(repoRoot, 'apps/electron/src'),
        new RegExp(`${removedStep}|provider:\\s*['"]${removedProvider}['"]`),
      ),
      ...sourceMatches(
        join(repoRoot, 'packages'),
        new RegExp(`provider:\\s*['"]${removedProvider}['"]|['"]${removedProvider}['"]\\s*\\|`),
      ),
    ]

    expect(matches).toEqual([])
  })

  it('has no removed provider package dependencies', () => {
    const dependencyPattern = new RegExp(`["'].*${removedProvider}.*["']\\s*:`, 'i')
    const packageJsonMatches = [
      ...sourceMatches(join(repoRoot, 'apps'), dependencyPattern),
      ...sourceMatches(join(repoRoot, 'packages'), dependencyPattern),
      ...sourceMatches(repoRoot, dependencyPattern).filter((path) => path === 'package.json'),
    ]

    expect(packageJsonMatches).toEqual([])
  })
})
