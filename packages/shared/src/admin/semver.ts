export type CatalogSemVerOrder = -1 | 0 | 1

interface ParsedCatalogSemVer {
  normalized: string
  core: [string, string, string]
  prerelease: string[] | null
}

const CATALOG_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function parseCatalogSemVer(version: string): ParsedCatalogSemVer | null {
  const normalized = version.trim().replace(/^v(?=\d)/i, '')
  const match = CATALOG_SEMVER_PATTERN.exec(normalized)
  if (!match) return null
  return {
    normalized,
    core: [match[1]!, match[2]!, match[3]!],
    prerelease: match[4]?.split('.') ?? null,
  }
}

function compareNumericIdentifiers(left: string, right: string): CatalogSemVerOrder {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1
  if (left === right) return 0
  return left > right ? 1 : -1
}

function comparePrereleaseIdentifiers(
  left: string,
  right: string,
): CatalogSemVerOrder {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) {
    return compareNumericIdentifiers(left, right)
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  if (left === right) return 0
  return left > right ? 1 : -1
}

/**
 * Normalizes the Catalog version compatibility prefix while enforcing strict
 * SemVer 2.0 syntax. Numeric identifiers are deliberately kept as strings so
 * versions larger than Number.MAX_SAFE_INTEGER remain valid and comparable.
 */
export function normalizeCatalogSemVer(version: string): string | null {
  return parseCatalogSemVer(version)?.normalized ?? null
}

export function isValidCatalogSemVer(version: string): boolean {
  return parseCatalogSemVer(version) !== null
}

/**
 * Compares two strict Catalog SemVer values. Build metadata is ignored as
 * required by SemVer 2.0. Returns null when either side is invalid.
 */
export function compareCatalogSemVer(
  leftVersion: string,
  rightVersion: string,
): CatalogSemVerOrder | null {
  const left = parseCatalogSemVer(leftVersion)
  const right = parseCatalogSemVer(rightVersion)
  if (!left || !right) return null

  for (let index = 0; index < left.core.length; index += 1) {
    const order = compareNumericIdentifiers(left.core[index]!, right.core[index]!)
    if (order !== 0) return order
  }

  if (!left.prerelease && !right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    const order = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier)
    if (order !== 0) return order
  }
  return 0
}
