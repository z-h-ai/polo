import { readFileSync } from 'node:fs'

const patternUrl = new URL('./strict-semver-pattern.txt', import.meta.url)

export const STRICT_SEMVER_PATTERN_SOURCE = readFileSync(patternUrl, 'utf8').trim()

if (
  !STRICT_SEMVER_PATTERN_SOURCE.startsWith('^')
  || !STRICT_SEMVER_PATTERN_SOURCE.endsWith('$')
) {
  throw new Error('Strict SemVer contract must be anchored')
}

const strictSemverPattern = new RegExp(STRICT_SEMVER_PATTERN_SOURCE)

export function isStrictSemver(value: string): boolean {
  return strictSemverPattern.test(value)
}

export function parseStrictSemverTag(tag: string): string | undefined {
  if (!tag.startsWith('v')) return undefined
  const version = tag.slice(1)
  return isStrictSemver(version) ? version : undefined
}
