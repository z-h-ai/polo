import type { TFunction } from 'i18next'

export interface CreatorSkillErrorPayload {
  code?: unknown
  errorCode?: unknown
  message?: unknown
  diagnostic?: unknown
}

export function translateCreatorSkillError(
  t: TFunction,
  payload?: CreatorSkillErrorPayload,
): string {
  const rawCode = payload?.errorCode ?? payload?.code
  const errorCode = typeof rawCode === 'string' && /^[A-Za-z0-9_]+$/.test(rawCode)
    ? rawCode
    : 'unknown'
  const unknown = t('creatorSkills.errors.unknown')
  return t(`creatorSkills.errors.${errorCode}`, { defaultValue: unknown })
}

export function creatorSkillErrorDiagnostic(
  payload?: CreatorSkillErrorPayload,
): string | undefined {
  if (typeof payload?.diagnostic === 'string' && payload.diagnostic.trim()) {
    return payload.diagnostic
  }
  if (
    typeof payload?.errorCode !== 'string'
    && typeof payload?.code !== 'string'
    && typeof payload?.message !== 'string'
  ) {
    return undefined
  }
  return JSON.stringify({
    ...(typeof payload.errorCode === 'string'
      ? { errorCode: payload.errorCode }
      : {}),
    ...(typeof payload.code === 'string' ? { code: payload.code } : {}),
    ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
  })
}
