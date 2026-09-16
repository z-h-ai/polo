import { atom } from 'jotai'

export type CreatorSkillSafetyCheckStatus = 'checking' | 'ok' | 'failed'

export const creatorSkillSafetyCheckStatesAtom = atom<
  Record<string, CreatorSkillSafetyCheckStatus>
>({})

export function creatorSkillSafetyIdentityKey(input: {
  workspaceId: string
  artifactId: string
  version: string
  archiveChecksum: string
}): string {
  return [
    input.workspaceId,
    input.artifactId,
    input.version,
    input.archiveChecksum,
  ].join('\0')
}
