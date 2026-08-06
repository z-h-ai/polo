import {
  prepareCreatorSkillUploadFile,
  uploadCreatorSkillArchive,
  type PreparedCreatorSkillArchive,
} from '../../src/renderer/lib/creator-skill-upload'
import type { CreatorSkillUploadGrant } from '../../src/shared/types'

const preparedFiles = new Map<string, {
  file: File
  prepared: PreparedCreatorSkillArchive
}>()

function decodeBase64(value: string): ArrayBuffer {
  const decoded = atob(value)
  const buffer = new ArrayBuffer(decoded.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return buffer
}

const harness = {
  async prepare(base64: string, filename: string, slug: string) {
    const file = new File([decodeBase64(base64)], filename, { type: 'application/zip' })
    const controller = new AbortController()
    const prepared = await prepareCreatorSkillUploadFile(file, slug, {
      signal: controller.signal,
    })
    const handle = crypto.randomUUID()
    preparedFiles.set(handle, { file, prepared })
    return { handle, ...prepared }
  },

  async upload(handle: string, grant: CreatorSkillUploadGrant) {
    const entry = preparedFiles.get(handle)
    if (!entry) throw new Error('Prepared Creator Skill upload handle is unavailable')
    const controller = new AbortController()
    try {
      return await uploadCreatorSkillArchive(entry.file, grant, entry.prepared, {
        signal: controller.signal,
      })
    } finally {
      preparedFiles.delete(handle)
    }
  },
}

;(window as unknown as { __creatorSkillUploadHarness: typeof harness })
  .__creatorSkillUploadHarness = harness
