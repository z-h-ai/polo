import type { CreatorSkillSafetyStatus } from '@z-h-ai/shared/creator-skills'

export interface CreatorSkillSafetyRefreshIdentity {
  workspaceId: string
  artifactId: string
  version: string
  archiveChecksum: string
}

type SafetyStatusResponse =
  | ({ success: true } & CreatorSkillSafetyStatus)
  | {
      success: false
      errorCode?: string
      message?: string
    }

export interface CreatorSkillSafetyRefreshResult {
  response: SafetyStatusResponse
  current: boolean
  persisted: boolean
}

export interface CreatorSkillSafetyRefreshApi {
  getSafetyStatus(input: {
    artifactId: string
    version: string
    archiveChecksum: string
  }): Promise<SafetyStatusResponse>
  updateSafetyStatus(input: {
    workspaceId: string
    status: CreatorSkillSafetyStatus
    checkedAt: string
  }): Promise<{ success: boolean }>
}

const inFlightRefreshes = new Map<
  string,
  Promise<CreatorSkillSafetyRefreshResult>
>()
const refreshGenerations = new Map<string, number>()

export function creatorSkillSafetyRefreshKey(
  identity: CreatorSkillSafetyRefreshIdentity,
): string {
  return [
    identity.workspaceId,
    identity.artifactId,
    identity.version,
    identity.archiveChecksum,
  ].join('\0')
}

export function invalidateCreatorSkillSafetyRefresh(
  identity: CreatorSkillSafetyRefreshIdentity,
): void {
  const key = creatorSkillSafetyRefreshKey(identity)
  refreshGenerations.set(key, (refreshGenerations.get(key) ?? 0) + 1)
  inFlightRefreshes.delete(key)
}

export function refreshCreatorSkillSafetyStatus(
  identity: CreatorSkillSafetyRefreshIdentity,
  api: CreatorSkillSafetyRefreshApi = {
    getSafetyStatus: input =>
      window.electronAPI.creatorSkillGetSafetyStatus(input) as Promise<SafetyStatusResponse>,
    updateSafetyStatus: input =>
      window.electronAPI.creatorSkillUpdateSafetyStatus(input),
  },
): Promise<CreatorSkillSafetyRefreshResult> {
  const key = creatorSkillSafetyRefreshKey(identity)
  const existing = inFlightRefreshes.get(key)
  if (existing) return existing

  const generation = (refreshGenerations.get(key) ?? 0) + 1
  refreshGenerations.set(key, generation)
  const request = (async (): Promise<CreatorSkillSafetyRefreshResult> => {
    const response = await api.getSafetyStatus({
      artifactId: identity.artifactId,
      version: identity.version,
      archiveChecksum: identity.archiveChecksum,
    })
    const current = refreshGenerations.get(key) === generation
    if (!response.success || !current) {
      return { response, current, persisted: false }
    }
    const update = await api.updateSafetyStatus({
      workspaceId: identity.workspaceId,
      status: {
        artifactId: response.artifactId,
        version: response.version,
        archiveChecksum: response.archiveChecksum,
        status: response.status,
        safeVersion: response.safeVersion,
      },
      checkedAt: new Date().toISOString(),
    })
    return {
      response,
      current: refreshGenerations.get(key) === generation,
      persisted: update.success,
    }
  })()
  inFlightRefreshes.set(key, request)
  void request.finally(() => {
    if (inFlightRefreshes.get(key) === request) {
      inFlightRefreshes.delete(key)
    }
  }).catch(() => {
    // Callers receive the original rejection; this branch only handles the
    // promise returned by finally so it cannot become an unhandled rejection.
  })
  return request
}
