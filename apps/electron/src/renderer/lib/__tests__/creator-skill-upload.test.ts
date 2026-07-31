import { describe, expect, it, mock } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import {
  preflightCreatorSkillUploadFile,
  uploadCreatorSkillArchive,
} from '../creator-skill-upload'

const grant = {
  method: 'PUT' as const,
  url: 'https://uploads.example.test/object',
  headers: { 'content-type': 'application/zip' },
  expiresAt: '2030-01-01T00:00:00.000Z',
  uploadGeneration: 1,
}

function zipBlobPart(entries: Record<string, Uint8Array>): ArrayBuffer {
  const bytes = zipSync(entries)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('Creator Skill direct upload', () => {
  it('preflights the ZIP root without extracting the archive', async () => {
    const valid = new File([zipBlobPart({
      'review-helper/SKILL.md': strToU8('---\nname: Review\ndescription: Test\n---\nBody'),
      'review-helper/references/guide.txt': strToU8('guide'),
    })], 'review-helper.zip')
    await expect(preflightCreatorSkillUploadFile(valid, 'review-helper')).resolves.toBeUndefined()

    const traversal = new File([zipBlobPart({
      '../SKILL.md': strToU8('unsafe'),
    })], 'unsafe.zip')
    await expect(preflightCreatorSkillUploadFile(traversal, 'review-helper'))
      .rejects.toMatchObject({ errorCode: 'invalid_skill_archive' })
  })

  it('sends the user-selected File directly to the signed URL', async () => {
    const file = new File(['zip bytes'], 'review-helper.zip', { type: 'application/zip' })
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      expect(init?.body).toBe(file)
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch

    await expect(uploadCreatorSkillArchive(file, grant, {
      signal: new AbortController().signal,
      fetchImpl,
    })).resolves.toEqual({
      sizeBytes: file.size,
    })
  })

  it('maps a rejected signed URL and cancellation to stable errors', async () => {
    const file = new File(['zip bytes'], 'review-helper.zip')
    await expect(uploadCreatorSkillArchive(file, grant, {
      signal: new AbortController().signal,
      fetchImpl: (async () => new Response(null, { status: 403 })) as unknown as typeof fetch,
    })).rejects.toMatchObject({ errorCode: 'upload_expired' })

    const controller = new AbortController()
    controller.abort()
    await expect(uploadCreatorSkillArchive(file, grant, {
      signal: controller.signal,
      fetchImpl: (async () => { throw new Error('aborted') }) as unknown as typeof fetch,
    })).rejects.toMatchObject({
      errorCode: 'creator_skill_upload_cancelled',
    })
  })
})
