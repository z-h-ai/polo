import type { ProductSpaceAppIdentity } from '@polo-ai/shared/protocol'

const scalarKeys = [
  'accountId', 'productSpaceId', 'catalogEntryId', 'artifactInstanceId',
  'versionId', 'version', 'catalogRevision', 'availability',
] as const
const identityKeys = [...scalarKeys, 'sources']
const sourceKeys = ['kind', 'name', 'circleId']

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key))
}

function isNonBlankString(value: unknown): value is string {
  // Validate shape without normalizing the bytes used for equality.
  return typeof value === 'string' && value.trim().length > 0
}

function isIdentity(value: unknown): value is ProductSpaceAppIdentity {
  if (!hasExactKeys(value, identityKeys)
    || !scalarKeys.every(key => isNonBlankString(value[key]))
    || !['available', 'unavailable', 'blocked', 'withdrawn'].includes(value.availability as string)
    || !Array.isArray(value.sources) || value.sources.length === 0) return false
  // Indexed iteration rejects sparse arrays as well as malformed members.
  for (let index = 0; index < value.sources.length; index += 1) {
    const source: unknown = value.sources[index]
    if (!hasExactKeys(source, sourceKeys)
      || !isNonBlankString(source.kind)
      || !(source.name === null || isNonBlankString(source.name))
      || !(source.circleId === null || isNonBlankString(source.circleId))) return false
  }
  return true
}

/**
 * Compare the complete sealed Catalog identity, independent of object key
 * insertion order. Source order and duplicate counts remain significant.
 * This is response reconciliation; Main still owns authoritative validation.
 */
export function sameProductSpaceAppIdentity(left: unknown, right: unknown): boolean {
  if (!isIdentity(left) || !isIdentity(right)) return false
  return left.accountId === right.accountId
    && left.productSpaceId === right.productSpaceId
    && left.catalogEntryId === right.catalogEntryId
    && left.artifactInstanceId === right.artifactInstanceId
    && left.versionId === right.versionId
    && left.version === right.version
    && left.catalogRevision === right.catalogRevision
    && left.availability === right.availability
    && left.sources.length === right.sources.length
    && left.sources.every((source, index) => {
      const other = right.sources[index]!
      return source.kind === other.kind
        && source.name === other.name
        && source.circleId === other.circleId
    })
}
