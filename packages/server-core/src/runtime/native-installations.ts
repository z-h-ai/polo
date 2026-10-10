import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { CONFIG_DIR } from '@polo-ai/shared/config'
import {
  NativeInstallationAdmissionSchema, NativeInstallationReportSchema,
  NativeInstallationReceiptSchema,
  type NativeInstallationAdmission, type NativeInstallationAdmissionRequest,
  type NativeInstallationReport, type NativeInstallationReceipt,
} from '@polo-ai/shared/admin'

export interface NativeInstallationTransport {
  admit(accountId: string, input: NativeInstallationAdmissionRequest): Promise<NativeInstallationAdmission>
  report(accountId: string, input: NativeInstallationReport): Promise<NativeInstallationReceipt>
}
let transport: NativeInstallationTransport | null = null
export function setNativeInstallationTransport(next: NativeInstallationTransport): void { transport = next }
export async function admitTrustedNativeInstallation(accountId: string, input: NativeInstallationAdmissionRequest) {
  if (!transport) throw new Error('Trusted installation session transport is unavailable')
  const admission = NativeInstallationAdmissionSchema.parse(await transport.admit(accountId, input))
  if (admission.accountId !== accountId || admission.productSpaceId !== input.productSpaceId
    || admission.version !== input.version || admission.checksum !== input.checksum
    || (input.subjectKind !== 'creator_skill' && (admission.subjectKind !== input.subjectKind || admission.subjectId !== input.subjectId || admission.versionId !== input.versionId))) {
    throw new Error('Installation admission changed its original identity')
  }
  return admission
}

// Bindings stay on this device. Paths, package bytes and credentials never
// enter the generated wire contract or the transport's report request.
export const NativeInstallationBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('app'), accountId: z.string().uuid(), productSpaceId: z.string().uuid(), subjectId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('skill'), workspaceRoot: z.string().min(1), slug: z.string().min(1).max(128) }).strict(),
])
export type NativeInstallationBinding = z.infer<typeof NativeInstallationBindingSchema>
const IntentSchema = z.object({ id: z.string().uuid(), admission: NativeInstallationAdmissionSchema, binding: NativeInstallationBindingSchema,
  action: z.enum(['install','uninstall']), partitionId: z.string().uuid() }).strict()
const RecordSchema = z.object({ admission: NativeInstallationAdmissionSchema, admissions: z.array(NativeInstallationAdmissionSchema), binding: NativeInstallationBindingSchema, partitionId: z.string().uuid(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), lastState: z.enum(['installed','uninstalled','managed_detached']).nullable().default(null) }).strict()
const StateSchema = z.object({ schemaVersion: z.literal(1), deviceId: z.string().uuid(), records: z.array(RecordSchema), intents: z.array(IntentSchema),
  pending: z.array(z.object({ accountId: z.string().uuid(), report: NativeInstallationReportSchema }).strict()) }).strict()
type State = z.infer<typeof StateSchema>
export type NativeInstallationSnapshot = Pick<NativeInstallationReport,'state'|'installedAdmissionIds'|'unmappedVersionCount'>
export type NativeInstallationIntent = z.infer<typeof IntentSchema>
function key(admission: NativeInstallationAdmission, binding: NativeInstallationBinding) {
  return JSON.stringify([admission.accountId,admission.productSpaceId,admission.subjectKind,admission.subjectId,binding])
}

/** Durable journal/outbox. A prepared intent retains the ORIGINAL scope
 * before a native mutation; a healthy native commit witness is required to
 * recover it. Corrupt/missing ledger JSON never synthesizes an uninstall. */
export class NativeInstallationOutbox {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly root: string, private readonly send: () => NativeInstallationTransport | null = () => transport) {}
  private async exists() {
    try { await access(join(this.root,'journal.json')); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  private async exclusive<T>(operation: (state: State) => Promise<T>): Promise<T> {
    const work = this.tail.catch(() => {}).then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const lockPath = join(this.root,'journal.lock')
      let lock
      try { lock = await open(lockPath,'wx',0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // Crash recovery only releases an extinct owner's lock. A running
        // foreign process or unreadable lock remains protected.
        const previous = z.object({ pid: z.number().int().positive() }).parse(JSON.parse(await readFile(lockPath,'utf8')))
        try { process.kill(previous.pid,0); throw new Error('Installation journal has a live owner') }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe }
        await unlink(lockPath); lock = await open(lockPath,'wx',0o600)
      }
      try {
        await lock.writeFile(JSON.stringify({pid: process.pid})); await lock.sync()
        let state: State
        try { state = StateSchema.parse(JSON.parse(await readFile(join(this.root,'journal.json'),'utf8'))) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          state = { schemaVersion: 1, deviceId: randomUUID(), records: [], intents: [], pending: [] }
        }
        return await operation(state)
      } finally { await lock.close(); await unlink(lockPath) }
    })
    this.tail = work
    return work
  }
  private async persist(state: State) {
    StateSchema.parse(state)
    const temporary = join(this.root,`journal-${randomUUID()}.tmp`), destination = join(this.root,'journal.json')
    const handle = await open(temporary,'wx',0o600)
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync() }
    finally { await handle.close() }
    await rename(temporary,destination)
    const directory = await open(this.root,'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  async prepare(admission: NativeInstallationAdmission, binding: NativeInstallationBinding, action: 'install'|'uninstall') {
    return this.exclusive(async state => {
      const checked = NativeInstallationAdmissionSchema.parse(admission), nativeBinding = NativeInstallationBindingSchema.parse(binding)
      let record = state.records.find(row => key(row.admission,row.binding) === key(checked,nativeBinding))
      if (!record) { record = { admission: checked, admissions: [checked], binding: nativeBinding, partitionId: randomUUID(), revision: 0, lastState: null }; state.records.push(record) }
      else if (!record.admissions.some(row => row.admissionId === checked.admissionId)) record.admissions.push(checked)
      const intent = { id: randomUUID(), admission: checked, binding: nativeBinding, action, partitionId: record.partitionId }
      state.intents.push(intent); await this.persist(state); return intent
    })
  }
  async retained(binding: NativeInstallationBinding) {
    const checked = NativeInstallationBindingSchema.parse(binding)
    return this.exclusive(async state => state.records.filter(row => JSON.stringify(row.binding) === JSON.stringify(checked)).flatMap(row => row.admissions))
  }
  async retainedManagedDetach(binding: NativeInstallationBinding) {
    const checked = NativeInstallationBindingSchema.parse(binding)
    return this.exclusive(async state => {
      const matching = state.records.filter(row => JSON.stringify(row.binding) === JSON.stringify(checked) && row.lastState === 'managed_detached')
      return matching.length === 1 ? matching[0]!.admission : null
    })
  }
  async commit(intentId: string, snapshot: NativeInstallationSnapshot, options: {deliver?: boolean} = {}) {
    await this.exclusive(async state => {
      const intent = state.intents.find(row => row.id === intentId); if (!intent) return
      const record = state.records.find(row => key(row.admission,row.binding) === key(intent.admission,intent.binding))!
      const revision = record.revision + 1
      const report = NativeInstallationReportSchema.parse({ contractVersion: 1, admissionId: intent.admission.admissionId,
        deviceId: state.deviceId, partitionId: intent.partitionId, eventId: randomUUID(), revision, observedAt: new Date().toISOString(), ...snapshot })
      record.revision = revision; record.admission = intent.admission; record.lastState = report.state
      state.pending.push({accountId: intent.admission.accountId, report}); state.intents = state.intents.filter(row => row.id !== intentId)
      // One workspace/slug holds one managed Skill. The verified replacement
      // commit also ends other original owners' managed installations there.
      // Retain each owner's admission/partition/token requirement; backups and
      // detached modified files are separate from a managed installation.
      if (intent.binding.kind === 'skill' && report.state === 'installed') {
        for (const previous of state.records) {
          if (previous === record || previous.lastState !== 'installed' || JSON.stringify(previous.binding) !== JSON.stringify(intent.binding)) continue
          const ended = NativeInstallationReportSchema.parse({contractVersion: 1,admissionId: previous.admission.admissionId,
            deviceId: state.deviceId,partitionId: previous.partitionId,eventId: randomUUID(),revision: previous.revision+1,
            observedAt: report.observedAt,state: 'uninstalled',installedAdmissionIds: [],unmappedVersionCount: 0})
          previous.revision = ended.revision; previous.lastState = ended.state
          state.pending.push({accountId: previous.admission.accountId,report: ended})
        }
      }
      await this.persist(state)
    })
    // Native completion has already committed. A transient transport error
    // keeps its durable outbox and never turns that success into a retry.
    if (options.deliver !== false) await this.flush()
  }
  async recover(check: (intent: NativeInstallationIntent) => Promise<NativeInstallationSnapshot|null>) {
    if (!await this.exists()) return
    const intents = await this.exclusive(async state => [...state.intents])
    for (const intent of intents) {
      const snapshot = await check(intent)
      if (snapshot) await this.commit(intent.id,snapshot)
    }
    await this.flush()
  }
  async flush() {
    const sender = this.send(); if (!sender) return
    if (!await this.exists()) return
    const pending = await this.exclusive(async state => [...state.pending])
    for (const row of pending) {
      try {
        const receipt = NativeInstallationReceiptSchema.parse(await sender.report(row.accountId,row.report))
        if (receipt.eventId !== row.report.eventId || receipt.revision !== row.report.revision) continue
        await this.exclusive(async state => { state.pending = state.pending.filter(item => item.report.eventId !== row.report.eventId); await this.persist(state) })
      } catch { /* Keep the immutable ORIGINAL account tuple for its next session. */ }
    }
  }
}
let defaultOutbox: NativeInstallationOutbox | null = null
export function getNativeInstallationOutbox() {
  if (!defaultOutbox) {
    defaultOutbox = new NativeInstallationOutbox(join(CONFIG_DIR,'native-installations'))
    const retry = setInterval(() => { void defaultOutbox?.flush().catch(() => {}) },30_000)
    retry.unref()
  }
  return defaultOutbox
}
