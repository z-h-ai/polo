import { describe, expect, it, mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import {
  calculateCreatorSkillArchiveChecksum,
  prepareCreatorSkillUploadFile,
  preflightCreatorSkillUploadFile,
  uploadCreatorSkillArchive,
} from '../creator-skill-upload'

const prepared = {
  sizeBytes: 9,
  archiveChecksum: 'a'.repeat(64),
}
const grant = {
  method: 'PUT' as const,
  url: 'https://uploads.example.test/object',
  headers: { 'content-type': 'application/zip' },
  expiresAt: '2030-01-01T00:00:00.000Z',
  uploadGeneration: 1,
  expectedSizeBytes: prepared.sizeBytes,
  expectedArchiveChecksum: prepared.archiveChecksum,
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

    await expect(uploadCreatorSkillArchive(file, grant, prepared, {
      signal: new AbortController().signal,
      fetchImpl,
    })).resolves.toEqual({
      sizeBytes: file.size,
      archiveChecksum: prepared.archiveChecksum,
    })
  })

  it('calculates SHA-256 incrementally with bounded slices', async () => {
    const sliceSizes: number[] = []
    class TrackingFile extends File {
      override slice(start?: number, end?: number, contentType?: string): Blob {
        sliceSizes.push((end ?? this.size) - (start ?? 0))
        return super.slice(start, end, contentType)
      }
    }
    const file = new TrackingFile(['abc'], 'payload.bin')
    await expect(calculateCreatorSkillArchiveChecksum(file, {
      signal: new AbortController().signal,
      chunkBytes: 2,
    })).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sliceSizes).toEqual([2, 1])
  })

  it('matches SHA-256 across block and chunk boundaries', async () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 4097]) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 31 + size) & 0xff)
      const file = new File([bytes], `payload-${size}.bin`)
      const expected = createHash('sha256').update(bytes).digest('hex')
      await expect(calculateCreatorSkillArchiveChecksum(file, {
        signal: new AbortController().signal,
        chunkBytes: 37,
      })).resolves.toBe(expected)
    }
  })

  it('binds preflight and checksum preparation to cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const file = new File(['abc'], 'payload.bin')
    await expect(calculateCreatorSkillArchiveChecksum(file, {
      signal: controller.signal,
      chunkBytes: 1,
    })).rejects.toMatchObject({ errorCode: 'creator_skill_upload_cancelled' })
  })

  it('prepares a valid archive with its exact size and checksum', async () => {
    const file = new File([zipBlobPart({
      'review-helper/SKILL.md': strToU8('---\nname: Review\ndescription: Test\n---\nBody'),
    })], 'review-helper.zip')
    const result = await prepareCreatorSkillUploadFile(file, 'review-helper', {
      signal: new AbortController().signal,
      chunkBytes: 7,
    })
    expect(result.sizeBytes).toBe(file.size)
    expect(result.archiveChecksum).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects a grant that is not bound to the prepared archive', async () => {
    const file = new File(['zip bytes'], 'review-helper.zip')
    await expect(uploadCreatorSkillArchive(file, {
      ...grant,
      expectedArchiveChecksum: 'b'.repeat(64),
    }, prepared, {
      signal: new AbortController().signal,
      fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    })).rejects.toMatchObject({ errorCode: 'checksum_mismatch' })
  })

  it('maps a rejected signed URL and cancellation to stable errors', async () => {
    const file = new File(['zip bytes'], 'review-helper.zip')
    await expect(uploadCreatorSkillArchive(file, grant, prepared, {
      signal: new AbortController().signal,
      fetchImpl: (async () => new Response(null, { status: 403 })) as unknown as typeof fetch,
    })).rejects.toMatchObject({ errorCode: 'upload_expired' })

    const controller = new AbortController()
    controller.abort()
    await expect(uploadCreatorSkillArchive(file, grant, prepared, {
      signal: controller.signal,
      fetchImpl: (async () => { throw new Error('aborted') }) as unknown as typeof fetch,
    })).rejects.toMatchObject({
      errorCode: 'creator_skill_upload_cancelled',
    })
  })
})
