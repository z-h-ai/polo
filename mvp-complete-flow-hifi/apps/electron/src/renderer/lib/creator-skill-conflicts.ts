import type { TFunction } from 'i18next'
import type {
  CreatorSkillConflictDetails,
  CreatorSkillInstallConflict,
  CreatorSkillInstallIdentity,
} from '../../shared/types'

function identityLabel(
  t: TFunction,
  identity: CreatorSkillInstallIdentity,
): string {
  const source = t(`creatorSkills.install.source.${identity.source}`)
  const version = identity.version ?? t('creatorSkills.install.versionUnknown')
  const artifact = identity.artifactId
    ? t('creatorSkills.install.artifactIdentity', {
        artifactId: identity.artifactId,
      })
    : t('creatorSkills.install.localIdentity')
  return t('creatorSkills.install.identity', {
    source,
    slug: identity.slug,
    version,
    artifact,
  })
}

export function creatorSkillConflictConfirmation(
  t: TFunction,
  input: {
    conflicts: CreatorSkillInstallConflict[]
    conflictDetails?: CreatorSkillConflictDetails
  },
): string {
  const conflicts = input.conflicts
    .map(conflict => t(`creatorSkills.conflict.${conflict}`))
    .join('\n')
  if (!input.conflictDetails) {
    return t('creatorSkills.install.confirmConflict', { conflicts })
  }
  const current = input.conflictDetails.existing.length > 0
    ? input.conflictDetails.existing
      .map(identity => identityLabel(t, identity))
      .join('\n')
    : t('creatorSkills.install.noExistingIdentity')
  const incoming = identityLabel(t, input.conflictDetails.incoming)
  return t(
    input.conflicts.includes('different_artifact')
      ? 'creatorSkills.install.confirmDifferentArtifact'
      : 'creatorSkills.install.confirmIdentityConflict',
    { conflicts, current, incoming },
  )
}
