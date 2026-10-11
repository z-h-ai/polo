import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { billingExternalIdSchema, billingRequestAdmissionSchema, billingUsageSchema, type BillingRuntimeAdmissionInput, type BillingRuntimeUsageInput } from '@polo-ai/shared/admin/billing-runtime-contract'

export interface AppBillingJournalScope {
  accountId: string
  adminOrigin: string
  productSpaceId: string
  artifactInstanceId: string
  artifactVersionId: string
}
export interface AppBillingJournalEntry {
  version: 1
  key: string
  scope: AppBillingJournalScope
  runId: string
  phase: 'admission' | 'receipt' | 'conflict'
  admission: BillingRuntimeAdmissionInput
  receipt?: BillingRuntimeUsageInput
}
const MAX_ENTRIES = 4096
const MAX_ENTRY_BYTES = 16384
const encoded = (value: unknown) => JSON.stringify(value)
function checkedScope(value: AppBillingJournalScope): AppBillingJournalScope {
  if (Object.keys(value).some(key => !['accountId', 'adminOrigin', 'productSpaceId', 'artifactInstanceId', 'artifactVersionId'].includes(key))) throw new Error('Invalid billing journal scope')
  if (typeof value.accountId !== 'string' || !value.accountId || value.accountId.length > 128) throw new Error('Invalid billing journal account')
  for (const id of [value.productSpaceId, value.artifactInstanceId, value.artifactVersionId]) if (!billingExternalIdSchema.safeParse(id).success) throw new Error('Invalid billing journal identity')
  const url = new URL(value.adminOrigin)
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid billing journal origin')
  return { accountId: value.accountId, adminOrigin: value.adminOrigin, productSpaceId: value.productSpaceId, artifactInstanceId: value.artifactInstanceId, artifactVersionId: value.artifactVersionId }
}

/** Persistent ORIGINAL request metadata only. No output, prompts, credentials,
 * response headers or native lease keys can enter this journal. */
export class AppBillingOutbox {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }) }
  private key(scope: AppBillingJournalScope, runId: string, requestId: string): string {
    return createHash('sha256').update(encoded([scope, runId, requestId])).digest('hex')
  }
  private path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid billing journal key')
    return join(this.directory, `${key}.json`)
  }
  private read(key: string): AppBillingJournalEntry | null {
    const path = this.path(key)
    if (!existsSync(path)) return null
    const text = readFileSync(path, 'utf8')
    if (Buffer.byteLength(text) > MAX_ENTRY_BYTES) throw new Error('Billing journal exceeds bounded metadata')
    const row = JSON.parse(text) as AppBillingJournalEntry
    if (row.version !== 1 || row.key !== key || !['admission', 'receipt', 'conflict'].includes(row.phase) || Object.keys(row).some(k => !['version', 'key', 'scope', 'runId', 'phase', 'admission', 'receipt'].includes(k))) throw new Error('Invalid billing journal record')
    row.scope = checkedScope(row.scope)
    billingExternalIdSchema.parse(row.runId)
    row.admission = billingRequestAdmissionSchema.parse(row.admission)
    if (row.receipt !== undefined) row.receipt = billingUsageSchema.parse(row.receipt)
    if (this.key(row.scope, row.runId, row.admission.requestId) !== key || row.admission.productSpaceId !== row.scope.productSpaceId || row.receipt && (row.receipt.runId !== row.runId || row.receipt.requestId !== row.admission.requestId || row.receipt.productSpaceId !== row.scope.productSpaceId)) throw new Error('Billing journal identity mismatch')
    return row
  }
  private write(row: AppBillingJournalEntry): void {
    const body = encoded(row)
    if (Buffer.byteLength(body) > MAX_ENTRY_BYTES) throw new Error('Billing journal exceeds bounded metadata')
    const target = this.path(row.key)
    if (!existsSync(target) && readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length >= MAX_ENTRIES) throw new Error('Billing journal capacity reached')
    const temp = `${target}.${randomUUID()}.tmp`
    const descriptor = openSync(temp, 'wx', 0o600)
    try { writeFileSync(descriptor, body); fsyncSync(descriptor) } finally { closeSync(descriptor) }
    renameSync(temp, target)
    // Sync the directory entry on systems that support fsync of directories.
    try { const dir = openSync(this.directory, 'r'); try { fsyncSync(dir) } finally { closeSync(dir) } } catch {}
  }
  stageAdmission(scopeValue: AppBillingJournalScope, runId: string, input: unknown): string {
    const scope = checkedScope(scopeValue)
    billingExternalIdSchema.parse(runId)
    const admission = billingRequestAdmissionSchema.parse(input)
    if (admission.productSpaceId !== scope.productSpaceId) throw new Error('Billing journal space mismatch')
    const key = this.key(scope, runId, admission.requestId)
    const prior = this.read(key)
    if (prior) {
      if (prior.phase === 'conflict' || encoded(prior.admission) !== encoded(admission)) throw new Error('Original billing admission conflicts')
      return key
    }
    this.write({ version: 1, key, scope, runId, phase: 'admission', admission })
    return key
  }
  stageReceipt(scopeValue: AppBillingJournalScope, input: unknown): string {
    const scope = checkedScope(scopeValue)
    const receipt = billingUsageSchema.parse(input)
    const key = this.key(scope, receipt.runId, receipt.requestId)
    const prior = this.read(key)
    if (!prior || prior.phase === 'conflict') throw new Error('Original billing admission is unavailable')
    if (prior.receipt && encoded(prior.receipt) !== encoded(receipt)) throw new Error('Original billing receipt conflicts')
    this.write({ ...prior, phase: 'receipt', receipt })
    return key
  }
  entries(accountId: string, adminOrigin: string): AppBillingJournalEntry[] {
    const entries: AppBillingJournalEntry[] = []
    for (const name of readdirSync(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      try {
        const entry = this.read(name.slice(0, -5))
        if (entry && entry.phase !== 'conflict' && entry.scope.accountId === accountId && entry.scope.adminOrigin === adminOrigin) entries.push(entry)
      } catch { /* Keep invalid historical evidence; never execute it. */ }
    }
    return entries
  }
  applySettlement(key: string, settlement: 'pending' | 'confirmed' | 'no_charge'): void {
    if (settlement === 'pending') return
    if (settlement !== 'confirmed' && settlement !== 'no_charge') throw new Error('Unknown settlement')
    const path = this.path(key)
    if (existsSync(path)) unlinkSync(path)
  }
  markConflict(key: string): void {
    const prior = this.read(key)
    if (prior) this.write({ ...prior, phase: 'conflict' })
  }
}
