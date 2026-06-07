import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const repoRoot = join(import.meta.dir, '../../../..')

function listFiles(root: string): string[] {
  if (!existsSync(root)) return []

  const entries = readdirSync(root)
  const files: string[] = []

  for (const entry of entries) {
    const path = join(root, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) {
      files.push(...listFiles(path))
    } else if (stats.isFile()) {
      files.push(path)
    }
  }

  return files
}

function sourceMatches(root: string, pattern: RegExp): string[] {
  return listFiles(root)
    .filter(path => !path.includes('/__tests__/'))
    .filter(path => !path.endsWith('.map'))
    .filter(path => pattern.test(readFileSync(path, 'utf8')))
    .map(path => relative(repoRoot, path))
    .sort()
}

describe('onboarding cleanup contract', () => {
  it('removes onboarding files and components from the Electron source tree', () => {
    const removedPaths = [
      'apps/electron/src/renderer/components/onboarding',
      'apps/electron/src/main/onboarding.ts',
      'apps/electron/src/renderer/hooks/useOnboarding.ts',
      'apps/electron/src/renderer/components/app-shell/SetupAuthBanner.tsx',
    ]

    expect(removedPaths.filter(path => existsSync(join(repoRoot, path)))).toEqual([])
  })

  it('removes onboarding and SetupAuthBanner references from production Electron source', () => {
    const matches = sourceMatches(
      join(repoRoot, 'apps/electron/src'),
      /onboarding|Onboarding|useOnboarding|SetupAuthBanner/
    )

    expect(matches).toEqual([])
  })

  it('removes the onboarding RPC handler from server-core registration', () => {
    const removedPaths = [
      'packages/server-core/src/handlers/rpc/onboarding.ts',
      'packages/server-core/src/handlers/rpc/onboarding-platform.test.ts',
    ]

    expect(removedPaths.filter(path => existsSync(join(repoRoot, path)))).toEqual([])

    const matches = sourceMatches(
      join(repoRoot, 'packages/server-core/src/handlers/rpc'),
      /registerOnboardingHandlers|handlers\/rpc\/onboarding|\.\/onboarding/
    )

    expect(matches).toEqual([])
  })
})
