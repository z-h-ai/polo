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
  const safe: Record<string, string> = {}
  if (typeof payload?.diagnostic === 'string' && payload.diagnostic.trim()) {
    try {
      const parsed = JSON.parse(payload.diagnostic) as unknown
      if (parsed && typeof parsed === 'object') {
        const candidate = parsed as Record<string, unknown>
        if (
          typeof candidate.operationId === 'string'
          && candidate.operationId.length <= 128
          && /^[A-Za-z0-9_-]+$/.test(candidate.operationId)
        ) {
          safe.operationId = candidate.operationId
        }
        if (
          typeof candidate.stage === 'string'
          && ['download', 'validate', 'prepare', 'commit', 'refresh']
            .includes(candidate.stage)
        ) {
          safe.stage = candidate.stage
        }
        if (
          typeof candidate.errorCode === 'string'
          && /^[A-Za-z0-9_]+$/.test(candidate.errorCode)
        ) {
          safe.errorCode = candidate.errorCode
        }
        if (
          typeof candidate.path === 'string'
          && candidate.path.length <= 4_096
          && !candidate.path.startsWith('/')
          && !/^[A-Za-z]:/.test(candidate.path)
          && !candidate.path.includes('\\')
          && !candidate.path.split('/').some(segment => segment === '..')
        ) {
          safe.path = candidate.path
        }
      }
    } catch {
      // Ignore opaque backend diagnostics. Only the allowlisted structure is
      // safe to expose or copy from the renderer.
    }
  }
  if (
    !safe.errorCode
    && typeof payload?.errorCode === 'string'
    && /^[A-Za-z0-9_]+$/.test(payload.errorCode)
  ) {
    safe.errorCode = payload.errorCode
  }
  if (
    !safe.errorCode
    && typeof payload?.code === 'string'
    && /^[A-Za-z0-9_]+$/.test(payload.code)
  ) {
    safe.code = payload.code
  }
  return Object.keys(safe).length > 0 ? JSON.stringify(safe) : undefined
}
