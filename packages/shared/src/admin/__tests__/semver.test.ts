import { describe, expect, it } from 'bun:test'
import {
  compareCatalogSemVer,
  isValidCatalogSemVer,
  normalizeCatalogSemVer,
} from '../semver.ts'

describe('Catalog strict SemVer 2.0', () => {
  it('normalizes the compatibility v prefix and accepts valid prerelease/build data', () => {
    expect(normalizeCatalogSemVer(' v1.2.3-rc.1+build.5 ')).toBe(
      '1.2.3-rc.1+build.5',
    )
    expect(isValidCatalogSemVer('V0.0.0')).toBe(true)
  })

  it('compares numeric identifiers as strings beyond JavaScript safe integers', () => {
    expect(compareCatalogSemVer(
      '90071992547409931234567890.0.0',
      '9007199254740993123456789.0.0',
    )).toBe(1)
    expect(compareCatalogSemVer(
      '1.0.0-90071992547409931234567890',
      '1.0.0-9007199254740993123456789',
    )).toBe(1)
  })

  it('implements prerelease precedence and ignores build metadata', () => {
    expect(compareCatalogSemVer('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareCatalogSemVer('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1)
    expect(compareCatalogSemVer('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareCatalogSemVer('1.0.0+new', '1.0.0+old')).toBe(0)
  })

  it('rejects fourth segments, leading zeroes, and malformed identifiers', () => {
    for (const version of [
      '1.2.3.4',
      '01.2.3',
      '1.0.0-01',
      '1.0.0-alpha..1',
      'release-1',
    ]) {
      expect(normalizeCatalogSemVer(version)).toBeNull()
      expect(compareCatalogSemVer(version, '1.0.0')).toBeNull()
    }
  })
})
