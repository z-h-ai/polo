import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import {
  analyzeCreatorAppPayload,
  createCanonicalCreatorAppBundle,
  normalizeCreatorAppPayloadRoot,
  type CreatorAppEntryCandidate,
  type CreatorAppPayloadEntry,
} from '@polo-ai/shared/admin'

export type CreatorAppPublicationResult = {
  appId: string
  releaseId: string
  version: string
  status: 'published'
  checksum?: string
  sizeBytes?: number
}

type StoredPublication = CreatorAppPublicationResult & {
  organizationId: string
  name: string
  mode: 'website' | 'upload'
  createdAt: string
  websiteUrl?: string
}

/** Durable local Admin boundary used by the embedded server. */
export class CreatorAppPublicationService {
  constructor(private readonly root = join(process.env.POLO_AI_CONFIG_DIR || join(homedir(), '.polo-ai'), 'creator-app-publications')) {}

  async publishWebsite(input: {
    organizationId: string; name: string; websiteUrl: string
  }): Promise<CreatorAppPublicationResult> {
    const appId = `app-${randomUUID()}`
    const result: StoredPublication = {
      appId, releaseId: `website-${randomUUID()}`, version: '1.0.0', status: 'published',
      organizationId: input.organizationId, name: input.name, mode: 'website',
      websiteUrl: input.websiteUrl, createdAt: new Date().toISOString(),
    }
    await this.persist(result)
    return result
  }

  async publishUpload(input: {
    organizationId: string; name: string; entries: CreatorAppPayloadEntry[]; entry?: CreatorAppEntryCandidate
  }): Promise<CreatorAppPublicationResult | { status: 'needs_entry_selection'; candidates: CreatorAppEntryCandidate[] }> {
    const entries = normalizeCreatorAppPayloadRoot(input.entries)
    const analysis = analyzeCreatorAppPayload(entries)
    if (analysis.status === 'invalid') throw new Error(analysis.message)
    if (analysis.status === 'needs_entry_selection' && !input.entry) {
      return { status: 'needs_entry_selection', candidates: analysis.candidates }
    }
    const candidate = input.entry ?? (analysis.status === 'ready' ? analysis.candidate : undefined)
    if (!candidate) throw new Error('Choose which detected file starts the application.')
    const publications = await this.readIndex()
    const patch = publications.filter(item => item.organizationId === input.organizationId && item.name === input.name && item.mode === 'upload').length
    const version = `1.0.${patch}`
    const appId = `app-${randomUUID()}`
    const bundle = createCanonicalCreatorAppBundle({ entries, appId, version, name: input.name, entry: candidate })
    const result: StoredPublication = {
      appId, releaseId: `release-${randomUUID()}`, version, status: 'published',
      checksum: bundle.checksum, sizeBytes: bundle.sizeBytes,
      organizationId: input.organizationId, name: input.name, mode: 'upload', createdAt: new Date().toISOString(),
    }
    await this.persist(result, bundle.archive)
    return result
  }

  private async readIndex(): Promise<StoredPublication[]> {
    try { return JSON.parse(await readFile(join(this.root, 'index.json'), 'utf8')) as StoredPublication[] } catch { return [] }
  }

  private async persist(publication: StoredPublication, archive?: Uint8Array): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (archive) {
      const bundlePath = join(this.root, `${publication.appId}.zip`)
      await writeFile(`${bundlePath}.${randomUUID()}.tmp`, archive, { mode: 0o600 })
      // A completed Bundle is never overwritten; only the final artifact survives.
      const files = await readdir(this.root)
      const staged = files.find(file => file.startsWith(`${publication.appId}.zip.`) && file.endsWith('.tmp'))
      if (!staged) throw new Error('Failed to stage final Bundle.')
      await rename(join(this.root, staged), bundlePath)
    }
    const index = await this.readIndex()
    index.push(publication)
    const path = join(this.root, 'index.json')
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(index)}\n`, { mode: 0o600 })
    await rename(tmp, path)
    await writeFile(join(this.root, 'audit.jsonl'), `${JSON.stringify({ event: 'published', ...publication })}\n`, { flag: 'a', mode: 0o600 })
  }
}
