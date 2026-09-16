export function compareStableCreatorSkillVersion(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function actionableCreatorSkillSafeVersion(input: {
  candidate?: string
  installedVersion: string
  ignoredVersion?: string
  status: 'active' | 'revoked' | 'archived'
}): string | null {
  const { candidate, installedVersion, ignoredVersion, status } = input
  if (
    !candidate
    || candidate === installedVersion
    || candidate === ignoredVersion
  ) {
    return null
  }
  const comparison = compareStableCreatorSkillVersion(candidate, installedVersion)
  if (comparison > 0 || (status === 'revoked' && comparison < 0)) {
    return candidate
  }
  return null
}
