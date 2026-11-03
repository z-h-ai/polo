/**
 * poo196-project-context experience-review orchestrator.
 *
 * Real Electron + production renderer modules (ChatPage + the whole
 * project-context surface). Fixture boundaries: window manager / IPC /
 * login state (see README). The fixture store below is PROGRAMMABLE: the
 * orchestrator reprograms assets, capabilities, latency, fault codes and the
 * file-dialog queue per scenario. Every pc_* call is logged with latency and
 * outcome; console noise (error/warn/i18next) is captured from the very first
 * webContents. Evidence: screenshots (1440x900) + capture receipts +
 * runtime.json under $POO196_EVIDENCE_DIR.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { encodeRpcErrorCodeInMessage, readRpcErrorCode } from '../../src/shared/rpc-error-bridge'
import type { PcAssetDto, PcCapabilitiesResponse } from '@polo-ai/shared/protocol'
import {
  LONG_NAME_ASSET_ID,
  CURRENT_USER_ID,
  CREATED_ENTERPRISE_SPACE_ID,
  SESSION_PERSONAL,
  SESSION_PROJECT,
  fixtureSpaceList,
  initialAssets,
  initialCapabilities,
  initialPmInvitations,
  initialPmRoster,
  initialSearchIndex,
  searchAssets,
  sessionsById,
} from './fixture-data'

const BUILD = process.env.POO196_BUILD_DIR!
const OUT = process.env.POO196_EVIDENCE_DIR!
const SOURCE_REF = process.env.POO196_SOURCE_REF ?? 'unknown'

interface PcCallLog {
  method: string
  at: string
  ms: number
  outcome: 'ok' | 'fault' | 'error'
  summary: string
}

const result: {
  sourceRef: string
  electronVersion: string
  startedAt: string
  endedAt?: string
  viewport: { width: number; height: number }
  driverChannel: string
  scenarios: { name: string; ok: boolean; detail?: unknown }[]
  checks: { name: string; ok: boolean; detail?: unknown }[]
  consoleNoise: { errors: string[]; warnings: string[]; i18nWarnings: string[] }
  unknownApiCalls: string[]
  pcCalls: PcCallLog[]
  previewHttpRequests: string[]
  /** S-10 证据：预览守卫日志与被 CSP 拒绝的越界尝试（预期存在，不算噪音）。 */
  previewGuardEvents: string[]
  previewCspViolations: string[]
  /** R-4 证据：镜像生产 window-manager 的子帧导航守卫拦下的落点 URL。 */
  frameNavBlocks: string[]
  captures: unknown[]
  error?: string
} = {
  sourceRef: SOURCE_REF,
  electronVersion: process.versions.electron,
  startedAt: new Date().toISOString(),
  viewport: { width: 1440, height: 900 },
  driverChannel: 'BrowserWindow.executeJavaScript + webContents.sendInputEvent + production craft:submit-input event',
  scenarios: [],
  checks: [],
  consoleNoise: { errors: [], warnings: [], i18nWarnings: [] },
  unknownApiCalls: [],
  pcCalls: [],
  previewHttpRequests: [],
  previewGuardEvents: [],
  previewCspViolations: [],
  frameNavBlocks: [],
  captures: [],
}

const steps: string[] = []
const mark = (label: string) => { steps.push(label); if (steps.length > 80) steps.shift() }

const check = (name: string, ok: boolean, detail?: unknown) => {
  result.checks.push({ name, ok, detail })
  if (!ok) console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)?.slice(0, 300))
}

/* ── programmable fixture store ─────────────────────────────────────────── */

interface Fault { code: string; message?: string; once?: boolean }

const fixture = {
  assets: initialAssets(),
  capabilities: initialCapabilities() as PcCapabilitiesResponse,
  searchIndex: initialSearchIndex(initialAssets()),
  searchDegraded: false,
  latencyMs: 40,
  faults: new Map<string, Fault>(),
  onceFired: new Set<string>(),
  fileDialogQueue: [] as string[][],
  uploadProcessingState: 'processing' as PcAssetDto['current']['processing'],
  nextAssetId: 100,
  downloadDir: join(BUILD, 'fixture-downloads'),
  previewContent: new Map<string, string>(),
  /** POO-196 追加轮: programmable project-members store (D-B/D-C). */
  pm: {
    roster: initialPmRoster(),
    invitations: initialPmInvitations(),
    /** 'ok' → created; 'lost' → transport-level loss (no code); 'code:<c>' →
     * a coded admin failure. Not `once`-keyed: the scenario re-arms it. */
    createScript: 'ok',
    /** R2 扩展: the create-invitation response script — mirrors the real
     * admin's discriminated outcomes (created/replayed/existing/state_changed/
     * credential_unrecoverable), so the result-page faces are all reachable.
     * 'relative' mirrors an admin WITHOUT its public origin: the same
     * path-only link the real deployment used to hand out (E2-2 fixture
     * mirror). 'lost' is the transport-level loss the S2-ENG-3 replay loop
     * needs. */
    inviteScript: 'ok' as 'ok' | 'relative' | 'lost' | 'existing' | 'state_changed' | 'credential_unrecoverable',
    /** X2-9: this fixture deployment's invitation email capability, exactly
     * what the real admin now derives from its own delivery configuration. */
    emailDeliveryAvailable: true,
    /** S2-ENG-3: the request identity each normalized target holds — the same
     * key replayed returns the SAME invitation, a different key finds the
     * still-valid invitation as `existing` (no link). */
    invitationKeys: new Map<string, { key: string; invitationId: string; token: string }>(),
    /** R2 扩展: per-method fault injection for the pm surface (mirrors the pc
     * faults; 'plain' throws an uncoded transport-level error). */
    faults: new Map<string, Fault>(),
    receiptState: 'created' as 'created' | 'unknown',
    createdSpace: null as { productSpaceId: string; enterpriseName: string } | null,
    createCalls: [] as Array<Record<string, unknown>>,
    receiptCalls: [] as Array<Record<string, unknown>>,
    inviteCalls: [] as Array<Record<string, unknown>>,
  },
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function resetFixtureAssets() {
  fixture.assets = initialAssets()
  fixture.searchIndex = initialSearchIndex(fixture.assets)
  fixture.capabilities = initialCapabilities()
  fixture.searchDegraded = false
  fixture.faults.clear()
  fixture.onceFired.clear()
  fixture.fileDialogQueue = []
  fixture.uploadProcessingState = 'processing'
}

const nowIso = () => new Date().toISOString()
const in30d = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

/**
 * S-10 夹具正文：不可信 HTML 的一次完整越界尝试。`base` 是运行期 preview
 * server 的地址（previewPort 只有起服后才知道，只能现填）。被试向量——远程
 * fetch/XHR、外链 img/iframe、window.open、程序化点链接、表单自动提交、
 * 子帧 meta refresh 自导航（POO-196 R-4：无脚本也能把沙箱帧导航出去，
 * CSP 管不了导航，只有主进程 will-frame-navigate 能拦）。
 */
const hostilePreviewContent = (base: string): string => [
  '<!doctype html><html><head>',
  '<title>POO-196 hostile fixture</title>',
  // 不可信页面最常见的逃逸尝试：自带一份放宽的 CSP，期望与注入策略取并集。
  // 按规范浏览器对多策略取交集，这条必须无效。
  `<meta http-equiv="Content-Security-Policy" content="default-src *; img-src *; script-src * 'unsafe-inline' 'unsafe-eval'; connect-src *; frame-src *">`,
  // R-4 向量：0 秒自导航到信标落点。这条请求到达 preview server 即意味着
  // 帧逃出了 srcdoc 注入策略的覆盖范围（落地文档不再受注入 CSP 约束）。
  `<meta http-equiv="refresh" content="0;url=${base}/beacon/meta-refresh">`,
  '</head><body>',
  '<h1>POO-196 hostile preview</h1>',
  `<img src="${base}/beacon/img" alt="beacon">`,
  `<iframe src="${base}/beacon/iframe"></iframe>`,
  `<a id="l" href="${base}/beacon/link" target="_blank">external link</a>`,
  `<form id="f" action="${base}/beacon/form" method="GET"><button type="submit">go</button></form>`,
  '<script>',
  'function hit(url){ try { fetch(url).catch(function(){}) } catch (e) {} }',
  `hit('${base}/beacon/fetch');`,
  `try { var x = new XMLHttpRequest(); x.open('GET', '${base}/beacon/xhr', true); x.send(); } catch (e) {}`,
  `try { window.open('${base}/beacon/popup'); } catch (e) {}`,
  `try { document.getElementById('l').click(); } catch (e) {}`,
  `try { document.getElementById('f').requestSubmit(); } catch (e) {}`,
  // location.href 同类向量（R-4 的脚本变体），meta refresh 被拦后这条仍会试。
  `try { location.href = '${base}/beacon/location-href'; } catch (e) {}`,
  // R-4 探针：head 里的静态 meta refresh 是否被 Chromium 认账、运行期再追加
  // 一条 1 秒延迟的 meta refresh 作对照（console.warn → 噪音 warnings 桶，
  // 不碰「console 零 error」断言）。
  `try { console.warn('[poo196-probe] meta-refresh-in-head=' + document.querySelectorAll('meta[http-equiv="refresh"]').length) } catch (e) {}`,
  `try { var m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '1;url=${base}/beacon/meta-js'; document.head.appendChild(m); console.warn('[poo196-probe] meta-js appended') } catch (e) { console.warn('[poo196-probe] meta-js failed: ' + e) }`,
  '</script>',
  '</body></html>',
].join('')

/** pcReadAsset 的兜底正文与预览链路同一份，保证任一读取路径都拿到夹具向量。 */
const hostilePreviewBase = () => `http://127.0.0.1:${previewPort}`

function codedError(code: string, message: string): Error {
  // Production parity: the trusted side answers with a coded failure. ipc
  // serialization drops the `code` property, so the code rides the MESSAGE
  // (rpc-error-bridge marker); the fixture preload strips Electron's
  // "Error invoking remote method…" prefix and re-carries it the same way
  // build-api.ts codedErrors does, and readRpcErrorCode decodes it.
  return new Error(encodeRpcErrorCodeInMessage(code, message))
}

const summarize = (input: unknown): string => {
  try {
    const text = JSON.stringify(input)
    return text ? (text.length > 180 ? `${text.slice(0, 180)}…` : text) : ''
  } catch {
    return String(input)
  }
}

async function handlePc(method: string, input: Record<string, unknown>): Promise<unknown> {
  const started = Date.now()
  const jitter = Math.floor(Math.random() * 12)
  await delay(fixture.latencyMs + jitter)
  const fault = fixture.faults.get(method)
  const faultArmed = fault && (!fault.once || !fixture.onceFired.has(method))
  if (fault && faultArmed) {
    fixture.onceFired.add(method)
    result.pcCalls.push({ method, at: nowIso(), ms: Date.now() - started, outcome: 'fault', summary: `${fault.code} ${summarize(input)}` })
    const error = codedError(fault.code, fault.message ?? `fixture fault ${fault.code}`)
    if (readRpcErrorCode(error) !== fault.code) {
      console.error(`fixture: coded error self-check failed for ${fault.code}`)
    }
    throw error
  }
  try {
    const output = computePc(method, input)
    result.pcCalls.push({ method, at: nowIso(), ms: Date.now() - started, outcome: 'ok', summary: summarize(input) })
    return output
  } catch (error) {
    result.pcCalls.push({ method, at: nowIso(), ms: Date.now() - started, outcome: 'error', summary: String(error) })
    throw error
  }
}

/** POO-196 追加轮: project-members fixture boundary. Mirrors handlePc's log
 * shape (result.pcCalls stays the one place an auditor reads wire history).
 * R2 扩展: consults the pm fault map first (coded or plain errors), so the
 * 403/transport faces of the members surface are drivable. */
async function handlePm(method: string, input: Record<string, unknown>): Promise<unknown> {
  const started = Date.now()
  await delay(fixture.latencyMs)
  const record = (outcome: 'ok' | 'fault' | 'error', summary: string) => {
    result.pcCalls.push({ method, at: nowIso(), ms: Date.now() - started, outcome, summary })
  }
  const fault = fixture.pm.faults.get(method)
  const faultArmed = fault && (!fault.once || !fixture.onceFired.has(method))
  if (fault && faultArmed) {
    fixture.onceFired.add(method)
    record('fault', fault.code)
    if (fault.code === 'plain') throw new Error(fault.message ?? 'fixture transport dropped mid-request')
    throw codedError(fault.code, fault.message ?? `fixture fault ${fault.code}`)
  }
  try {
    const output = computePm(method, input, record)
    record('ok', summarize(input))
    return output
  } catch (error) {
    record('error', String(error))
    throw error
  }
}

function computePm(
  method: string,
  input: Record<string, unknown>,
  record: (outcome: 'ok' | 'fault', summary: string) => void,
): unknown {
  const pm = fixture.pm
  switch (method) {
    case 'pmListProjectMembers':
      // X2-9: the capability bit rides the roster, like the real read model.
      return clone({ ...pm.roster, emailDeliveryAvailable: pm.emailDeliveryAvailable })
    case 'pmListProjectInvitations':
      return clone({
        productSpaceId: pm.roster.productSpaceId,
        viewerRole: pm.roster.viewerRole,
        invitations: pm.invitations,
        nextCursor: null,
      })
    case 'pmCreateEnterprise': {
      pm.createCalls.push(clone(input))
      if (pm.createScript === 'lost') {
        // No embedded polo-rpc-code marker: the renderer classifies this as
        // unresolved — the D-B 6 recovery path.
        throw new Error('fixture transport dropped before the response arrived')
      }
      if (pm.createScript.startsWith('code:')) {
        const code = pm.createScript.slice('code:'.length)
        record('fault', code)
        throw codedError(code, `fixture fault ${code}`)
      }
      const command = (input.command ?? {}) as Record<string, unknown>
      pm.createdSpace = {
        productSpaceId: CREATED_ENTERPRISE_SPACE_ID,
        enterpriseName: String(command.name ?? '新建项目'),
      }
      return {
        result: 'created',
        enterpriseId: 'ent-created',
        productSpaceId: pm.createdSpace.productSpaceId,
        viewerRole: 'owner',
        enterpriseName: pm.createdSpace.enterpriseName,
        createdAt: nowIso(),
      }
    }
    case 'pmQueryCreateReceipt': {
      pm.receiptCalls.push(clone(input))
      if (pm.receiptState === 'unknown' || !pm.createdSpace) return { state: 'unknown' }
      return {
        state: 'created',
        enterpriseId: 'ent-created',
        productSpaceId: pm.createdSpace.productSpaceId,
        createdAt: nowIso(),
      }
    }
    case 'pmCreateProjectInvitation': {
      pm.inviteCalls.push(clone(input))
      const command = (input.command ?? {}) as Record<string, unknown>
      const key = String(command.createRequestKey ?? 'pm-invite-unknown')
      const target = String(command.targetPhone ?? command.targetEmail ?? 'unknown-target')
      const baseInvitation = {
        invitationId: `inv-${pm.inviteCalls.length}`,
        status: 'active',
        maskedPhone: command.targetPhone ? `${String(command.targetPhone).slice(0, 3)}****${String(command.targetPhone).slice(-4)}` : null,
        maskedEmail: command.targetEmail ? String(command.targetEmail) : null,
        expiresAt: '2026-11-16T00:00:00+08:00',
        createdAt: nowIso(),
        acceptedAt: null,
      }
      // R2 扩展: script the discriminated outcomes the real admin produces
      // (existing / state_changed / credential_unrecoverable carry NO url).
      if (pm.inviteScript === 'existing' || pm.inviteScript === 'state_changed' || pm.inviteScript === 'credential_unrecoverable') {
        const status = pm.inviteScript === 'state_changed' ? 'accepted' : 'active'
        return {
          result: pm.inviteScript,
          invitation: { ...baseInvitation, status },
        }
      }
      // The credential derives from the request key, so a replay of the same
      // key hands back the SAME link — the real admin re-derives its HMAC
      // token; the fixture hashes the key.
      const token = Buffer.from(`invite:${key}`).toString('base64url')
      const linkOrigin = pm.inviteScript === 'relative' ? '' : 'https://fixture-admin.polo.invalid'
      if (pm.inviteScript === 'lost') {
        // The REAL loss this arm mirrors: the aggregate DID commit server-side,
        // only the response vanished — so the invitation and its request
        // identity are recorded here, and the same-key retry replays.
        pm.invitationKeys.set(target, { key, invitationId: baseInvitation.invitationId, token })
        pm.invitations.unshift({ ...baseInvitation })
        throw new Error('fixture transport dropped before the invitation response arrived')
      }
      const held = pm.invitationKeys.get(target)
      if (held && held.key === key) {
        // S2-ENG-3: an explicit retry of the same request replays — same
        // invitation, same still-valid link.
        const invitation = pm.invitations.find(entry => entry.invitationId === held.invitationId) ?? { ...baseInvitation, invitationId: held.invitationId }
        return {
          result: 'replayed',
          invitation,
          invitationUrl: `${linkOrigin}/invite/${held.token}`,
        }
      }
      if (held) {
        // D-C: a DIFFERENT key aimed at a target that still holds an active
        // invitation answers with that state and never a second credential.
        const invitation = pm.invitations.find(entry => entry.invitationId === held.invitationId)
        if (invitation && invitation.status === 'active') {
          return { result: 'existing', invitation }
        }
      }
      const invitation: { invitationId: string; status: string; maskedPhone: string | null; maskedEmail: string | null; expiresAt: string; createdAt: string; acceptedAt: string | null } = baseInvitation
      pm.invitationKeys.set(target, { key, invitationId: invitation.invitationId, token })
      pm.invitations.unshift(invitation)
      return {
        result: 'created',
        invitation,
        // E2-2 fixture mirror: the fixed admin builds an absolute https link
        // under its canonical origin; the 'relative' arm mirrors an admin
        // WITHOUT that origin (the real shape the review observed) so the
        // client's trusted-origin resolution stays exercised.
        invitationUrl: `${linkOrigin}/invite/${token}`,
      }
    }
    default:
      throw new Error(`unknown pm fixture method ${method}`)
  }
}

function listAssets(input: Record<string, unknown>) {
  const view = (input.view as 'active' | 'trash') ?? 'active'
  const q = typeof input.q === 'string' ? input.q.toLowerCase() : null
  const tag = typeof input.tag === 'string' ? input.tag : null
  const pinned = typeof input.pinned === 'string' ? input.pinned : null
  const limit = typeof input.limit === 'number' ? input.limit : 50
  const cursor = typeof input.cursor === 'string' ? Number.parseInt(Buffer.from(input.cursor, 'base64').toString('utf8'), 10) : 0

  let pool = fixture.assets.filter((asset) => (view === 'trash' ? asset.status === 'trashed' : asset.status === 'active'))
  if (q) pool = pool.filter((asset) => asset.name.toLowerCase().includes(q))
  if (tag === 'confirmed') pool = pool.filter((asset) => asset.current.confirmedAt !== null)
  else if (tag) pool = pool.filter((asset) => asset.tags.some((entry) => entry.id === tag))
  if (pinned === 'true') pool = pool.filter((asset) => asset.pinned)
  else if (pinned === 'false') pool = pool.filter((asset) => !asset.pinned)
  pool = [...pool].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))

  const page = pool.slice(cursor, cursor + limit)
  const nextCursor = cursor + limit < pool.length
    ? Buffer.from(String(cursor + limit)).toString('base64')
    : undefined
  return { assets: clone(page), nextCursor, canManage: fixture.capabilities.canManage }
}

function findAsset(input: Record<string, unknown>): PcAssetDto {
  const asset = fixture.assets.find((candidate) => candidate.id === input.assetId)
  if (!asset) throw codedError('pc_not_found', `asset ${String(input.assetId)} not found`)
  return asset
}

function computePc(method: string, input: Record<string, unknown>): unknown {
  // Contract parity: with the feature disabled the polo-admin control plane
  // still answers the capabilities declaration (featureEnabled=false +
  // disabledReason — that IS the disabled face), while every other pc call is
  // rejected with pc_feature_disabled (the surface is closed). Without this
  // exception the renderer can never observe a specific disabledReason.
  if (!fixture.capabilities.featureEnabled && method !== 'pcListCapabilities') {
    throw codedError('pc_feature_disabled', 'project file feature is disabled')
  }
  switch (method) {
    case 'pcListCapabilities':
      return clone(fixture.capabilities)
    case 'pcGetSummary': {
      const active = fixture.assets.filter((asset) => asset.status === 'active')
      const confirmed = active.filter((asset) => asset.current.confirmedAt !== null)
      const recent = [...active]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 5)
        .map((asset) => ({ assetId: asset.id, name: asset.name, version: asset.current.version, updatedAt: asset.updatedAt, tags: asset.tags }))
      return {
        generatedAt: nowIso(),
        assetCount: active.length,
        confirmedCount: confirmed.length,
        overview: `Apollo 项目空间当前 ${active.length} 份共享文件，其中 ${confirmed.length} 份已确认结论；最近更新集中在迭代对齐材料。`,
        recent: clone(recent),
      }
    }
    case 'pcListAssets':
      return listAssets(input)
    case 'pcGetAsset':
      return { asset: clone(findAsset(input)) }
    case 'pcUpdateAsset': {
      const asset = findAsset(input)
      const body = input.input as { expectedRevision: number; name?: string; tags?: string[] }
      if (body.expectedRevision !== asset.revision) throw codedError('pc_revision_conflict', 'revision moved')
      if (body.name) asset.name = body.name
      if (body.tags) {
        asset.tags = body.tags.map((label) => {
          const preset = asset.tags.find((tag) => tag.id === label)
          return preset ?? { id: label, label, preset: false }
        })
      }
      asset.revision += 1
      asset.updatedAt = nowIso()
      return { asset: clone(asset) }
    }
    case 'pcSetConfirmed': {
      const asset = findAsset(input)
      const body = input.input as { expectedVersion: number; confirmed: boolean }
      if (body.expectedVersion !== asset.current.version) throw codedError('pc_revision_conflict', 'version moved')
      asset.current.confirmedAt = body.confirmed ? nowIso() : null
      asset.current.confirmedByUserId = body.confirmed ? CURRENT_USER_ID : null
      asset.revision += 1
      asset.updatedAt = nowIso()
      return { asset: clone(asset) }
    }
    case 'pcSetPinned': {
      const asset = findAsset(input)
      const body = input.input as { pinned: boolean }
      asset.pinned = body.pinned
      asset.pinnedAt = body.pinned ? nowIso() : null
      asset.revision += 1
      asset.updatedAt = nowIso()
      return { asset: clone(asset) }
    }
    case 'pcTrashAsset': {
      const asset = findAsset(input)
      if (typeof input.expectedRevision === 'number' && input.expectedRevision !== asset.revision) {
        throw codedError('pc_revision_conflict', 'revision moved')
      }
      asset.status = 'trashed'
      asset.trashedAt = nowIso()
      asset.trashExpiresAt = in30d()
      asset.deletedById = CURRENT_USER_ID
      asset.revision += 1
      asset.updatedAt = nowIso()
      return { asset: clone(asset) }
    }
    case 'pcRestoreAsset': {
      const asset = findAsset(input)
      const body = input.input as { expectedRevision: number }
      if (body.expectedRevision !== asset.revision) throw codedError('pc_revision_conflict', 'revision moved')
      asset.status = 'active'
      asset.trashedAt = null
      asset.trashExpiresAt = null
      asset.deletedById = null
      asset.revision += 1
      asset.updatedAt = nowIso()
      return { asset: clone(asset) }
    }
    case 'pcUploadFile': {
      const name = String(input.name)
      const checksum = String(input.checksumSha256)
      const mode = input.mode as 'create' | 'replace'
      if (mode === 'replace') {
        const asset = fixture.assets.find((candidate) => candidate.id === input.assetId)
        if (!asset) throw codedError('pc_not_found', 'asset to replace not found')
        if (asset.uploaderUserId !== CURRENT_USER_ID) throw codedError('pc_replace_not_uploader', 'only the uploader may replace')
        if (input.expectedRevision !== asset.revision) throw codedError('pc_revision_conflict', 'revision moved')
        asset.current = {
          version: asset.current.version + 1,
          sizeBytes: Number(input.sizeBytes),
          mime: String(input.mime ?? 'application/octet-stream'),
          checksumSha256: checksum,
          createdAt: nowIso(),
          createdById: CURRENT_USER_ID,
          processing: fixture.uploadProcessingState,
          confirmedAt: null,
          confirmedByUserId: null,
        }
        asset.currentVersion = asset.current.version
        asset.revision += 1
        asset.updatedAt = nowIso()
        const published = fixture.uploadProcessingState === 'indexed'
        return { published, asset: clone(asset) }
      }
      const asset: PcAssetDto = {
        id: `as-gen-${fixture.nextAssetId++}`,
        name,
        tags: Array.isArray(input.tags)
          ? (input.tags as string[]).map((label) => {
              const preset = fixture.assets.flatMap((a) => a.tags).find((tag) => tag.id === label && tag.preset)
              return preset ?? { id: label, label, preset: false }
            })
          : [],
        uploaderUserId: CURRENT_USER_ID,
        uploaderDisplayName: '林奕',
        source: (input.source as { kind: 'file'; note?: string } | undefined) ?? { kind: 'file', note: null },
        status: 'active',
        currentVersion: 1,
        revision: 1,
        pinned: false,
        pinnedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        trashedAt: null,
        trashExpiresAt: null,
        deletedById: null,
        current: {
          version: 1,
          sizeBytes: Number(input.sizeBytes),
          mime: String(input.mime ?? 'application/octet-stream'),
          checksumSha256: checksum,
          createdAt: nowIso(),
          createdById: CURRENT_USER_ID,
          processing: fixture.uploadProcessingState,
          confirmedAt: null,
          confirmedByUserId: null,
        },
      }
      fixture.assets.unshift(asset)
      const published = fixture.uploadProcessingState === 'indexed'
      return { published, asset: clone(asset) }
    }
    case 'pcDownloadAsset': {
      const asset = findAsset(input)
      mkdirSync(fixture.downloadDir, { recursive: true })
      const safeName = (String(input.targetPath).split('/').pop() ?? 'download.bin').replace(/[/\\:]+/g, '_')
      const savedPath = join(fixture.downloadDir, safeName)
      writeFileSync(savedPath, `POO-196 fixture bytes for ${asset.name} v${asset.current.version}`)
      return { savedPath }
    }
    case 'pcGetPreviewUrl': {
      const asset = findAsset(input)
      if (asset.current.mime !== 'text/markdown' && asset.current.mime !== 'text/html') {
        throw codedError('pc_content_not_indexed', 'no preview for this mime')
      }
      if (asset.id === 'as-hostile-html') {
        fixture.previewContent.set(asset.id, hostilePreviewContent(hostilePreviewBase()))
      } else {
        fixture.previewContent.set(asset.id, `<h1>${asset.name}</h1><p>POO-196 fixture preview of v${asset.current.version}.</p>`)
      }
      return { url: `http://127.0.0.1:${previewPort}/preview/${asset.id}?v=${asset.current.version}`, expiresAt: nowIso(), mime: 'text/html' }
    }
    case 'pcReadAsset': {
      const asset = findAsset(input)
      if (asset.id === 'as-hostile-html') {
        return { kind: 'text', version: asset.current.version, content: hostilePreviewContent(hostilePreviewBase()), truncated: false }
      }
      const content = fixture.searchIndex.get(asset.id) ?? `# ${asset.name}\n\nPOO-196 fixture 正文占位。`
      return { kind: 'text', version: asset.current.version, content, truncated: false }
    }
    case 'pcSearchAssets': {
      const q = String(input.q ?? '')
      return searchAssets(
        fixture.assets,
        fixture.searchIndex,
        q,
        fixture.searchDegraded,
        typeof input.limit === 'number' ? input.limit : 20,
      )
    }
    case 'pcRebuild':
      return { jobId: `job-${Date.now()}` }
    default:
      throw new Error(`fixture: unknown pc method ${method}`)
  }
}

/* ── fixture stub IPC + preview http server ─────────────────────────────── */

let previewPort = 0
let previewServer: ReturnType<typeof createServer> | null = null

function startPreviewServer(): Promise<void> {
  return new Promise((resolve) => {
    previewServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      result.previewHttpRequests.push(`${req.method} ${req.url}`)
      const assetId = req.url?.match(/preview\/([^?]+)/)?.[1] ?? ''
      res.setHeader('Content-Type', 'text/html;charset=utf-8')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.end(fixture.previewContent.get(assetId) ?? '<p>fixture preview missing</p>')
    })
    previewServer.listen(0, '127.0.0.1', () => {
      previewPort = (previewServer!.address() as { port: number }).port
      resolve()
    })
  })
}

function registerFixtureIpc() {
  ipcMain.handle('fixture-pc', (_e, method: string, input: Record<string, unknown>) => handlePc(method, input ?? {}))
  ipcMain.handle('fixture-pm', (_e, method: string, input: Record<string, unknown>) => handlePm(method, input ?? {}))
  ipcMain.handle('fixture-stub', (_e, name: string, args: unknown[]) => {
    switch (name) {
      case 'getSessionMessages':
        return clone(sessionsById[String(args?.[0])]) ?? null
      case 'readPreferences':
        return {}
      case 'writePreferences':
        return { ok: true }
      case 'getAutoCapitalisation':
      case 'getSpellCheck':
        return false
      case 'getSendMessageKey':
        return 'Enter'
      case 'getPendingPlanExecution':
        return null
      case 'getHomeDir':
        return BUILD
      case 'openFileDialog': {
        const answer = fixture.fileDialogQueue.shift()
        return answer ?? []
      }
      case 'readFileBinary': {
        const filePath = String(args?.[0] ?? '')
        const declared = filePath.match(/__size(\d+)/)?.[1]
        const size = declared ? Number(declared) : 4096
        return Buffer.alloc(size, 0x61)
      }
      case 'generateThumbnail':
        return null
      case 'cancelProcessing':
      case 'kbSetSessionCollections':
      case 'setAutoCapitalisation':
      case 'setSpellCheck':
      case 'setSendMessageKey':
      case 'sessionCommand':
        return { success: true }
      case 'kbListCollections':
        return []
      case 'adminPaymentHandoff':
        return { ok: false }
      case 'getTabBrowserApps':
      case 'organizationList':
      case 'getRichToolDescriptions':
      case 'searchFiles':
      case 'getSkills':
      case 'getSkillsUnfiltered':
      case 'getSources':
      case 'getHomeQuickAccess':
      case 'productSpaceListActiveExecutions':
      case 'listLabels':
      case 'listStatuses':
        return []
      case 'getLogoUrl':
        return ''
      case 'readWorkspaceImage':
        // 生产 IPC 对缺失文件答 null（icon-cache.ts 的静默回退依赖这一点）。
        // 落到 default 的 {} 会把非字符串写进 icon 缓存，渲染徽标时以
        // `cachedIconUrl.startsWith is not a function` 打崩 composer。
        return null
      case 'getUnreadSummary':
        return { total: 0 }
      case 'getWorkspaceSettings':
      case 'getProductSpaceContextStorage':
      case 'getTaskOutput':
      case 'creatorSkillGetSafetyStatus':
        return null
      case 'setRichToolDescriptions':
        return {}
      case 'getSystemTheme':
        return 'light'
      case 'getColorTheme':
      case 'getWorkspaceColorTheme':
        return 'default'
      case 'getAllWorkspaceThemes':
        return {}
      case 'loadPresetTheme':
        return null
      case 'loadPresetThemes':
        return []
      case 'getFilePath':
        return null
      case 'changeLanguage':
        return { ok: true }
      case 'showInFolder':
        return { ok: true }
      case 'getSessions':
      case 'getSession':
        return null
      case 'productSpaceList':
        // The create dialog's refresh handover (D-B 7): the space created in
        // this session shows up only after the fixture recorded a success.
        return fixtureSpaceList(fixture.pm.createdSpace)
      default:
        return {}
    }
  })
  ipcMain.handle('fixture-unknown-method', (_e, name: string) => {
    if (!result.unknownApiCalls.includes(name)) result.unknownApiCalls.push(name)
    return null
  })
  ipcMain.handle('fixture-unknown-call', () => ({}))
  ipcMain.handle('fixture-program', (_e, program: { op: string; args?: Record<string, unknown> }) => runProgram(program))
}

async function runProgram(program: { op: string; args?: Record<string, unknown> }): Promise<unknown> {
  const args = program.args ?? {}
  switch (program.op) {
    case 'setFault':
      if (args.fault) fixture.faults.set(String(args.method), args.fault as Fault)
      else fixture.faults.delete(String(args.method))
      return true
    case 'setLatency':
      fixture.latencyMs = Number(args.ms)
      return true
    case 'setDegraded':
      fixture.searchDegraded = Boolean(args.degraded)
      return true
    case 'setCapabilities':
      fixture.capabilities = { ...clone(fixture.capabilities), ...(args.capabilities as object) }
      return true
    case 'setUploadProcessing':
      fixture.uploadProcessingState = args.state as PcAssetDto['current']['processing']
      return true
    case 'queueFileDialog':
      fixture.fileDialogQueue.push(args.paths as string[])
      return true
    case 'indexAsset': {
      const asset = fixture.assets.find((candidate) => candidate.id === args.assetId)
      if (asset) {
        asset.current.processing = 'indexed'
        asset.updatedAt = nowIso()
      }
      return true
    }
    case 'bumpAssetVersion': {
      // Simulates a teammate replacing the file behind the user's back (CAS).
      const asset = fixture.assets.find((candidate) => candidate.id === args.assetId)
      if (asset) {
        asset.revision += 1
        asset.current = { ...asset.current, version: asset.current.version + 1, confirmedAt: null, confirmedByUserId: null, createdAt: nowIso() }
        asset.currentVersion = asset.current.version
        asset.updatedAt = nowIso()
      }
      return true
    }
    case 'add100Assets': {
      for (let i = 0; i < 100; i++) {
        fixture.assets.unshift({
          id: `as-bulk-${i}`,
          name: `迭代周报-第${String(45 - Math.floor(i / 5))}期-0${i % 10}.md`,
          tags: [{ id: 'meeting', label: '会议纪要', preset: true }],
          uploaderUserId: i % 3 === 0 ? 'u-chen-02' : CURRENT_USER_ID,
          uploaderDisplayName: i % 3 === 0 ? '陈晓' : '林奕',
          source: { kind: 'file', note: null },
          status: 'active',
          currentVersion: 1,
          revision: 1,
          pinned: false,
          pinnedAt: null,
          createdAt: nowIso(),
          updatedAt: new Date(Date.parse('2026-10-01T09:00:00+08:00') - i * 86_400_000).toISOString(),
          trashedAt: null,
          trashExpiresAt: null,
          deletedById: null,
          current: {
            version: 1,
            sizeBytes: 12_000 + i * 10,
            mime: 'text/markdown',
            checksumSha256: String(i).padStart(64, '0'),
            createdAt: nowIso(),
            createdById: CURRENT_USER_ID,
            processing: 'indexed',
            confirmedAt: null,
            confirmedByUserId: null,
          },
        })
      }
      return true
    }
    case 'resetAssets':
      resetFixtureAssets()
      return true
    case 'setPmCreateScript':
      fixture.pm.createScript = String(args.script)
      return true
    case 'setPmInviteScript':
      fixture.pm.inviteScript = String(args.script) as typeof fixture.pm.inviteScript
      return true
    case 'setPmEmailDelivery':
      // X2-9: flip the fixture deployment's email capability, mirroring the
      // real admin's configuration-driven read model.
      fixture.pm.emailDeliveryAvailable = args.available !== false
      return true
    case 'setPmFault': {
      if (args.fault) fixture.pm.faults.set(String(args.method), args.fault as Fault)
      else fixture.pm.faults.delete(String(args.method))
      return true
    }
    case 'setPmReceiptState':
      fixture.pm.receiptState = args.state === 'unknown' ? 'unknown' : 'created'
      return true
    case 'resetPm':
      fixture.pm.roster = initialPmRoster()
      fixture.pm.invitations = initialPmInvitations()
      fixture.pm.createScript = 'ok'
      fixture.pm.inviteScript = 'ok'
      fixture.pm.faults.clear()
      fixture.pm.receiptState = 'created'
      fixture.pm.createdSpace = null
      fixture.pm.emailDeliveryAvailable = true
      fixture.pm.invitationKeys.clear()
      fixture.pm.createCalls = []
      fixture.pm.receiptCalls = []
      fixture.pm.inviteCalls = []
      return true
    case 'pmCallStats':
      return {
        createCalls: clone(fixture.pm.createCalls),
        receiptCalls: clone(fixture.pm.receiptCalls),
        inviteCalls: clone(fixture.pm.inviteCalls),
        createdSpace: clone(fixture.pm.createdSpace),
      }
    case 'stageTrashLoadMore': {
      // X25 采集布景：把 25 个活跃资产压入回收站，使回收站列表超过默认页大小，
      // 「加载更多」入口才会出现（before 树没有该入口，驱动侧判 absent）。
      const limit = Number(args.count ?? 25)
      let staged = 0
      for (const asset of fixture.assets) {
        if (staged >= limit) break
        if (asset.status !== 'active') continue
        fixture.assets[fixture.assets.indexOf(asset)] = {
          ...asset,
          status: 'trashed',
          trashedAt: nowIso(),
          trashExpiresAt: in30d(),
        }
        staged += 1
      }
      return staged
    }
    case 'pcCallStats':
      return {
        capabilities: clone(fixture.capabilities),
        total: result.pcCalls.length,
        byMethod: result.pcCalls.reduce<Record<string, number>>((acc, call) => {
          acc[call.method] = (acc[call.method] ?? 0) + 1
          return acc
        }, {}),
        faults: result.pcCalls.filter((call) => call.outcome === 'fault').length,
      }
    case 'previewServerPort':
      return previewPort
    default:
      throw new Error(`unknown program op ${program.op}`)
  }
}

const runProgramDirect = <T,>(program: { op: string; args?: Record<string, unknown> }): Promise<T> => runProgram(program) as Promise<T>

/* ── window / observation / capture ─────────────────────────────────────── */

let host: BrowserWindow

/**
 * R-4 镜像：与生产 window-manager 的子帧导航守卫同一份判定（main frame 放行、
 * 自家 renderer 文件放行、about:* 放行——srcdoc 预览文档的初次 commit 就是
 * about:srcdoc、其余子帧导航一律 preventDefault）。e2e 用自己的 main.ts，
 * 不经过生产 window-manager，不镜像就测不到 R-4 的修复；拦下的落点记进
 * frameNavBlocks 作为断言证据。
 */
function isHarnessAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return false
    const filePath = fileURLToPath(parsed)
    const harnessRoot = resolve(join(BUILD, 'pages'))
    return filePath === join(harnessRoot, 'host.html') || filePath.startsWith(harnessRoot + sep)
  } catch {
    return false
  }
}

function observeWebContents(wc: Electron.WebContents) {
  const tag = () => {
    try {
      const url = wc.getURL()
      return url ? (url.split('/').pop() || url).split('?')[0] : `wc-${wc.id}`
    } catch {
      return `wc-${wc.id}`
    }
  }
  wc.on('console-message', (_e, level: number, message: string, line, sourceId) => {
    // S-10 证据通道：预览守卫的拦截日志与沙箱内的 CSP/沙箱拒绝是「预期发生」
    // 的隔离证明，单独留痕，不算 console 噪音（否则末尾零 error 断言会误报）。
    // Chromium 的措辞不止一种（Refused to… / …violates the following… /
    // Blocked form submission… / Framing 'origin/'），且不一定带 about:srcdoc
    // 前缀（frame 违规只报源），按信标主机或 srcdoc 归属路由。
    const previewOwned = /about:srcdoc|127\.0\.0\.1:\d+/.test(message)
    if (message.includes('[preview-guard]')) {
      result.previewGuardEvents.push(`[${tag()}] ${message} (${sourceId}:${line})`)
      return
    }
    if (previewOwned && /Content Security Policy/i.test(message)) {
      result.previewCspViolations.push(`[${tag()}] ${message} (${sourceId}:${line})`)
      return
    }
    // 沙箱原生拦截（allow-popups/allow-forms 缺失）同属隔离证据。
    if (previewOwned && /Blocked form submission|request was made in a sandboxed frame|Blocked (call to )?(window\.)?open/i.test(message)) {
      result.previewCspViolations.push(`[${tag()}] ${message} (${sourceId}:${line})`)
      return
    }
    const entry = `[${tag()}] ${message} (${sourceId}:${line})`
    if (level >= 3) result.consoleNoise.errors.push(entry)
    else if (level === 2) {
      result.consoleNoise.warnings.push(entry)
      if (/i18next|missingKey|react-i18next/i.test(message)) result.consoleNoise.i18nWarnings.push(entry)
    }
  })
  wc.on('render-process-gone', (_e, d) => result.consoleNoise.errors.push(`[${tag()}] renderer gone: ${JSON.stringify(d)}`))
  // R-4 镜像守卫（判定与生产 window-manager 逐条一致，见 isHarnessAppUrl 上方
  // 的说明）。注意它同样接管了「内嵌外域 iframe」向量：这条子帧加载在导航层
  // 就被拦，CSP 的 Framing 违规可能因此不再出现，S5b 断言按证据二选一。
  wc.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return
    if (isHarnessAppUrl(details.url)) return
    if (details.url.startsWith('about:')) return
    details.preventDefault()
    result.frameNavBlocks.push(`${tag()} ${details.url}`)
  })
}

const js = async <T = unknown,>(expr: string): Promise<T> => {
  try {
    return await Promise.race([
      host.webContents.executeJavaScript(expr) as Promise<T>,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`executeJavaScript hang: ${expr.slice(0, 100)}`)), 15000)),
    ]) as Promise<T>
  } catch (error) {
    throw new Error(`js failed: ${String((error as Error)?.message ?? error).slice(0, 160)} :: expr=${expr.slice(0, 120)}`)
  }
}

/** Non-throwing until: resolves false on timeout (for fallback loops). */
async function probeUntil(probe: () => Promise<unknown> | unknown, ms = 15000, step = 80): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await probe()) return true
    } catch {
      // transient probe failure — keep polling
    }
    await delay(step)
  }
  return false
}

async function until(probe: () => Promise<unknown> | unknown, ms = 15000, step = 80) {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try {
      last = await probe()
      if (last) return last
    } catch (error) {
      last = error
    }
    await delay(step)
  }
  // Failure forensics: dump the observable page state so the orchestrator log
  // names the exact surface state at timeout.
  let forensic = ''
  try {
    forensic = await js<string>(`(() => {
      const tab = document.querySelector('[data-testid="pc-tabs"] [data-state="active"]')?.getAttribute('data-testid') ?? 'none'
      const lib = Boolean(document.querySelector('[data-testid="pc-library"]'))
      const libRoot = document.querySelector('[data-testid="pc-library"], [data-testid="pc-library-blocked"], [data-testid="pc-library-trash"]')
      const libRootName = libRoot ? (libRoot.getAttribute('data-testid') ?? '?').replace('pc-library', '') || 'main' : 'none'
      const notice = document.querySelector('[data-testid="pc-capability-notice"]')?.getAttribute('data-state') ?? ''
      const rows = document.querySelectorAll('[data-testid^="pc-asset-row-"]').length
      const popover = document.querySelector('[data-testid="pc-mention-popover"]')
      const popoverInfo = popover ? \`open(\${popover.querySelectorAll('[data-testid^="pc-mention-option-"]').length} opts, \${(popover.textContent || '').slice(0, 60)})\` : 'closed'
      const dialog = document.querySelector('[data-testid="pc-upload-dialog"], [data-testid="pc-replace-dialog"]') ? 'dialog' : 'none'
      const err = document.querySelector('[data-testid="pc-error"], [data-testid="pc-pin-error"], [data-testid="pc-trash-error"]')?.textContent ?? ''
      const input = (document.querySelector('[data-tutorial="chat-input"]')?.textContent ?? '').slice(0, 40)
      const renderLog = (window.__poo196 && window.__poo196.renderLog) ? JSON.stringify(window.__poo196.renderLog().slice(-8)) : '[]'
      const pinPane = Boolean(document.querySelector('[data-testid="pc-pin-pane"]'))
      const toolbar = Array.from(document.querySelectorAll('[data-testid="pc-library"] button')).slice(0, 6).map(b => (b.getAttribute('data-testid') ?? b.textContent.trim()).slice(0, 12)).join(',')
      const toastRegion = document.querySelector('[data-sonner-toaster]')
      const toast = (toastRegion ? (toastRegion.innerText ?? '') : '').slice(0, 50)
      const pm = document.querySelector('[data-testid="project-members-dialog"]')
      const pmInfo = pm ? \`open(step=\${pm.getAttribute('data-step')} role=\${pm.getAttribute('data-viewer-role')})\` : 'closed'
      const cd = document.querySelector('[data-testid="create-project-dialog"]')
      const cdInfo = cd ? \`open(phase=\${cd.getAttribute('data-phase')})\` : 'closed'
      const overlays = document.querySelectorAll('[data-slot="dialog-overlay"]').length
      const trashEl = document.querySelector('[data-testid="pc-library-trash"]')
      const trashVis = trashEl ? getComputedStyle(trashEl).display : 'none'
      const mainEl = document.querySelector('[data-testid="pc-library"]')
      const mainVis = mainEl ? getComputedStyle(mainEl).display : 'none'
      return \`pm=\${pmInfo} create=\${cdInfo} overlays=\${overlays} trashVis=\${trashVis} mainVis=\${mainVis} tab=\${tab} libRoot=\${libRootName} notice=\${notice} pinPane=\${pinPane} rows=\${rows} popover=\${popoverInfo} \${dialog} err=\${err} input=\${JSON.stringify(input)} toast=\${JSON.stringify(toast)} toolbar=[\${toolbar}] renderLog=\${renderLog}\`
    })()`)
  } catch (e) {
    forensic = `forensic failed: ${String(e).slice(0, 80)}`
  }
  throw new Error(`timeout waiting (last=${String(last).slice(0, 140)}; state: ${forensic})`)
}

async function capture(name: string, extra?: Record<string, unknown>) {
  host.show()
  host.focus()
  await delay(280)
  const viewport = await js<[number, number]>('[window.innerWidth, window.innerHeight]')
  const image = await host.capturePage()
  const raw = image.toPNG()
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, raw)
  const receipt = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    url: host.webContents.getURL(),
    scene: { object: `poo196-project-context ${name}`, source_ref: SOURCE_REF, viewport, ...(extra ?? {}) },
    image: {
      sha256: createHash('sha256').update(raw).digest('hex'),
      width: image.getSize().width,
      height: image.getSize().height,
      device_scale_factor: image.getSize().width / viewport[0],
      full_page: false,
    },
    native_capture: { method: 'BrowserWindow.capturePage' },
  }
  writeFileSync(path.replace(/\.png$/, '.capture.json'), JSON.stringify(receipt, null, 2))
  result.captures.push({ name, path, receipt: path.replace(/\.png$/, '.capture.json') })
}

/* ── helper probes ──────────────────────────────────────────────────────── */

const T = {
  tabs: '[data-testid="pc-tabs"]',
  tabMessages: '[data-testid="pc-tab-messages"]',
  tabFiles: '[data-testid="pc-tab-files"]',
  tabPins: '[data-testid="pc-tab-pins"]',
  library: '[data-testid="pc-library"]',
  trashButton: '[data-testid="pc-trash-button"]',
  trashView: '[data-testid="pc-trash-view"]',
  trashList: '[data-testid="pc-trash-list"]',
  pinPane: '[data-testid="pc-pin-pane"]',
  pinError: '[data-testid="pc-pin-error"]',
  uploadDialog: '[data-testid="pc-upload-dialog"]',
  replaceDialog: '[data-testid="pc-replace-dialog"]',
  uploadButton: '[data-testid="pc-upload-button"]',
  uploadPick: '[data-testid="pc-upload-pick"]',
  uploadName: '[data-testid="pc-upload-name"]',
  uploadTagInput: '[data-testid="pc-upload-tag-input"]',
  uploadSubmit: '[data-testid="pc-upload-submit"]',
  uploadError: '[data-testid="pc-upload-error"]',
  replacePick: '[data-testid="pc-replace-pick"]',
  replaceSubmit: '[data-testid="pc-replace-submit"]',
  replaceError: '[data-testid="pc-replace-error"]',
  search: '[data-testid="pc-search"]',
  error: '[data-testid="pc-error"]',
  errorRetry: '[data-testid="pc-error-retry"]',
  loading: '[data-testid="pc-loading"]',
  empty: '[data-testid="pc-empty"]',
  emptyFiltered: '[data-testid="pc-empty-filtered"]',
  list: '[data-testid="pc-list"]',
  loadMore: '[data-testid="pc-load-more"]',
  mentionPopover: '[data-testid="pc-mention-popover"]',
  mentionDegraded: '[data-testid="pc-mention-degraded"]',
  draftChips: '[data-testid="project-asset-draft-chips"]',
  snapshotChips: '[data-testid="project-asset-reference-chips"]',
  input: '[data-tutorial="chat-input"]',
  deleteConfirm: '[data-testid="pc-delete-confirm"]',
  deleteConfirmAction: '[data-testid="confirm-dialog-action"]',
  previewOverlay: '[data-testid="pc-preview-overlay"]',
  previewFrame: '[data-testid="pc-preview-frame"]',
  previewSourceToggle: '[data-testid="pc-preview-source-toggle"]',
  // POO-196 追加轮: members entry + dialog + create dialog.
  membersButton: '[data-testid="pc-members-button"]',
  membersDialog: '[data-testid="project-members-dialog"]',
  membersManageSurface: '[data-testid="project-members-manage-surface"]',
  membersMemberSurface: '[data-testid="project-members-member-surface"]',
  membersRoster: '[data-testid="project-members-roster"]',
  membersRosterRow: '[data-testid="project-members-roster-row"]',
  membersRosterCount: '[data-testid="project-members-roster-count"]',
  membersInvitations: '[data-testid="project-members-invitations"]',
  membersInvitationRow: '[data-testid="project-members-invitation-row"]',
  membersInviteAction: '[data-testid="project-members-invite-action"]',
  membersCompose: '[data-testid="project-members-compose"]',
  membersInviteTarget: '[data-testid="project-members-invite-target"]',
  membersInviteSubmit: '[data-testid="project-members-invite-submit"]',
  membersComposeBack: '[data-testid="project-members-compose-back"]',
  membersResult: '[data-testid="project-members-invite-result"]',
  membersCopyLink: '[data-testid="project-members-copy-link"]',
  membersResultBack: '[data-testid="project-members-result-back"]',
  membersOpenManagement: '[data-testid="project-members-open-management"]',
  createDialog: '[data-testid="create-project-dialog"]',
  createName: '[data-testid="create-project-name-input"]',
  createOwner: '[data-testid="create-project-owner-input"]',
  createPurpose: '[data-testid="create-project-purpose-input"]',
  createResponsibility: '[data-testid="create-project-responsibility"]',
  createSubmit: '[data-testid="create-project-submit"]',
  createCancel: '[data-testid="create-project-cancel"]',
  createRecovery: '[data-testid="create-project-recovery"]',
  createQueryReceipt: '[data-testid="create-project-query-receipt"]',
  createRetryEnter: '[data-testid="create-project-retry-enter"]',
  createBudgetFact: '[data-testid="create-project-budget-fact"]',
  // R2 共识修复批: recovery real exit + stored banner + members retry/management
  // faces + the phone-only invite placeholder (X2-6/7/9/13, E2-6, S2-ENG-3).
  createStoredRequest: '[data-testid="create-project-stored-request"]',
  createBackToForm: '[data-testid="create-project-back-to-form"]',
  membersRosterRetry: '[data-testid="project-members-roster-retry"]',
  membersInvitationsRetry: '[data-testid="project-members-invitations-retry"]',
  membersResultManagement: '[data-testid="project-members-result-management"]',
  // R2 扩展: members dialog inner faces + create dialog guidance surfaces +
  // the production space-menu rig.
  membersTitle: '[data-testid="project-members-title"]',
  membersYourRole: '[data-testid="project-members-your-role"]',
  membersContactOwner: '[data-testid="project-members-contact-owner"]',
  membersManageError: '[data-testid="project-members-manage-error"]',
  membersClose: '[data-testid="project-members-close"]',
  membersCopyFailed: '[data-testid="project-members-copy-failed"]',
  membersRosterError: '[data-testid="project-members-roster-error"]',
  membersRosterLoading: '[data-testid="project-members-roster-loading"]',
  membersInviteUnrecoverable: '[data-testid="project-members-invite-unrecoverable"]',
  membersInviteStateChanged: '[data-testid="project-members-invite-state-changed"]',
  membersInviteExisting: '[data-testid="project-members-invite-existing"]',
  membersInviteInvalid: '[data-testid="project-members-invite-target"]',
  createEnterFailed: '[data-testid="create-project-enter-failed"]',
  createEnterExisting: '[data-testid="create-project-enter-existing"]',
  createEnterpriseExists: '[data-testid="create-project-enterprise-exists"]',
  createPhoneVerification: '[data-testid="create-project-phone-verification"]',
  createVerifyPhone: '[data-testid="create-project-verify-phone"]',
  createVersionMismatch: '[data-testid="create-project-version-mismatch"]',
  createSubmitError: '[data-testid="create-project-submit-error"]',
  createNameHint: '[id="create-project-name-hint"]',
  spaceMenuTrigger: '[data-testid="poo196-space-menu-trigger"]',
  spaceMenuContent: '[data-testid="poo196-space-menu-content"]',
  spaceMenuItem: '[data-testid="product-space-item"]',
  spaceMenuCreate: '[data-testid="product-space-create-project"]',
  spaceMenuRefresh: '[data-testid="product-space-refresh"]',
}

const clickTab = async (testId: string) => {
  await js<boolean>(`window.__poo196.click('${testId}')`)
  if (testId.includes('pc-tab-')) {
    // Self-verifying tab activation: the Radix trigger activates on
    // mousedown, and on Enter-on-focus as the fallback keyboard path.
    const tabId = testId.replace('[data-testid="', '').replace('"]', '')
    const activeSel = `document.querySelector('[data-testid="pc-tabs"] [data-state="active"]')?.getAttribute('data-testid') === '${tabId}'`
    const active = await probeUntil(() => js<boolean>(activeSel), 1500)
    if (!active) {
      for (const mode of ['key', 'pointer']) {
        if (mode === 'key') await js<boolean>(`window.__poo196.pressEnterOn('${testId}')`)
        else await js<boolean>(`window.__poo196.click('${testId}')`)
        const retried = await probeUntil(() => js<boolean>(activeSel), 1500)
        if (retried) return
      }
      throw new Error(`tab ${tabId} never activated`)
    }
  }
}

const rowMenu = (assetId: string) => `[data-testid="pc-asset-menu-${assetId}"]`

/**
 * Opens a row's action menu. Radix opens its dropdown on Enter-on-focus (the
 * production keyboard path, documented in the menu hint) or on pointerdown;
 * both are driven here, keyboard first because synthetic pointer events are
 * not always trusted-shape enough for the trigger.
 */
const openRowMenu = async (assetId: string, action: string): Promise<boolean> => {
  for (const mode of ['key', 'pointer', 'click', 'key']) {
    if (mode === 'key') {
      await js<boolean>(`window.__poo196.pressEnterOn('${rowMenu(assetId)}')`)
    } else if (mode === 'pointer') {
      await js<boolean>(`window.__poo196.click('${rowMenu(assetId)}')`)
    } else {
      await js<boolean>(`(() => { const el = document.querySelector('${rowMenu(assetId)}'); if (!el) return false; el.click(); return true })()`)
    }
    const opened = await probeUntil(() => js<boolean>(`window.__poo196.q('${rowAction(assetId, action)}')`), 3000)
    if (opened) { mark(`menu-open=${assetId}/${mode}`); return true }
    await pressEscape()
    await delay(150)
  }
  return false
}
const rowAction = (assetId: string, action: string) => `[data-testid="pc-asset-action-${action}-${assetId}"]`

const clickMenuAction = async (assetId: string, action: string) => {
  const opened = await openRowMenu(assetId, action)
  if (!opened) throw new Error(`row menu never opened for ${assetId}/${action}`)
  // Radix MenuItem selection: focus + Enter is the production keyboard path
  // (the menu hint copy documents exactly this: ↑↓ 选择 · Enter 确认).
  const itemFocused = await js<boolean>(`window.__poo196.pressEnterOn('${rowAction(assetId, action)}')`)
  if (!itemFocused) throw new Error(`menu item missing for ${assetId}/${action}`)
  mark(`menu=${assetId}/${action} itemEnter=true`)
  await delay(250)
}

const openUploadDialog = async () => {
  // The upload button mounts only after capabilities report canShare — wait
  // for it (production renders the same progressive toolbar).
  await until(() => js<boolean>(`window.__poo196.q('${T.uploadButton}')`), 8000)
  for (let attempt = 0; attempt < 3; attempt++) {
    const clicked = await js<boolean>(`window.__poo196.click('${T.uploadButton}')`)
    mark(`upload-click#${attempt}=${clicked} ${await js<string>(`String(window.__poo196.buttonInfo('${T.uploadButton}'))`)}`)
    const opened = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.uploadDialog}')`), 3000)
    if (opened) return
  }
  throw new Error('upload dialog never opened')
}

const pressEscape = async () => {
  host.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' } as unknown as Electron.InputInputEvent)
  host.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' } as unknown as Electron.InputInputEvent)
  await delay(350)
}

const toastText = () => js<string>('window.__poo196.toastText()')
// The key rides JSON.stringify, not a quoted literal: the i18n coverage lint
// treats quoted call shapes as static keys, and this stays genuinely dynamic.
const i18nText = (key: string) => js<string>(`String(window.__poo196.t(${JSON.stringify(key)}))`)

const clearInput = async () => {
  await js<boolean>('window.__poo196.focusInput()')
  await js<boolean>(`(() => { const el = document.querySelector('${T.input}'); el.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, ''); return true })()`)
  await delay(150)
  const len = await js<number>('window.__poo196.inputValue().length')
  return len === 0
}

const clearSearch = async () => {
  await js<boolean>(`(() => { const el = document.querySelector('${T.search}'); el.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, ''); return true })()`)
  await delay(500)
}

const typeInto = async (selector: string, text: string) => {
  await js<boolean>(`(() => { const el = document.querySelector('${selector}'); el.focus(); document.execCommand('insertText', false, '${text.replace(/'/g, "\\'")}'); return true })()`)
}

/**
 * Real keyboard typing into the composer via trusted char events (the same
 * channel a human keyboard uses). Used for the @ trigger: execCommand-driven
 * text does not always reproduce the caret/IME path the mention detector
 * reads.
 */
const typeChars = async (text: string) => {
  for (const ch of text) {
    host.webContents.sendInputEvent({ type: 'char', keyCode: ch } as unknown as Electron.InputInputEvent)
    await delay(60)
  }
  await delay(150)
}

/** Clear the composer, then type a fresh @ query with real char events. */
const typeMentionQuery = async (query: string) => {
  await clearInput()
  await typeChars(`@${query}`)
}

/* ── scenarios ──────────────────────────────────────────────────────────── */

const FIXTURE_FILE_SMALL = join(BUILD, 'fixture', '__size2048_迭代纪要-1106.md')
const FIXTURE_FILE_HUGE = join(BUILD, 'fixture', '__size99999999_巨幅设计稿.psd')

async function scenarioSmoke() {
  await until(() => js<boolean>('Boolean(window.__poo196 && window.__poo196.ready)'), 20000)
  const viewport = await js<[number, number]>('[window.innerWidth, window.innerHeight]')
  check('[S0] 宿主页就绪', true, { viewport })
  check('[S0] 窗口视口 1440x900', viewport[0] === 1440 && viewport[1] === 900, viewport)
  check('[S0] electronAPI.pc 桥可达', await js<boolean>('typeof window.electronAPI.pcListCapabilities === "function"'))
  check('[S0] pc 通道全数暴露', await js<boolean>(`['pcGetSummary','pcUpdateAsset','pcRebuild','pcSearchAssets'].every(m => typeof window.electronAPI[m] === 'function')`))
  check('[S0] 挂载面所需 electronAPI 方法齐备', await js<boolean>(`['getSessionMessages','openFileDialog','readFileBinary','getHomeDir','getWindowFocusState','onWindowFocusChange','getSendMessageKey','getPendingPlanExecution'].every(m => typeof window.electronAPI[m] === 'function')`))
  await capture('s0-smoke-project-messages')
}

/** 旅程①: 非项目会话 ⇄ 项目会话切换（含边界真值: 非项目无 tab strip）。 */
async function scenarioSessionSwitch() {
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.personal)`)
  await until(async () => (await js<string>(`document.querySelector('[data-testid="poo196-active-session"]')?.textContent`)) === SESSION_PERSONAL, 8000)
  await delay(300)
  check('[S1] 非项目会话不渲染 tab strip（截图证明）', await js<boolean>(`!window.__poo196.q('${T.tabs}')`))
  check('[S1] 非项目会话无任何 pc- 残留 DOM', (await js<number>(`window.__poo196.count('[data-testid^="pc-"]')`)) === 0)
  check('[S1] 非项目会话 composer 无引用草稿', (await js<number>(`window.__poo196.draftRefs(window.__poo196.sessions.personal).length`)) === 0)
  await capture('s1-nonproject-session-no-tabs')

  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.project)`)
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 8000)
  check('[S1] 项目会话出现三 tab strip', true)
  const tabsText = await js<string>(`Array.from(document.querySelectorAll('${T.tabs} [role="tab"]')).map(el => el.textContent.trim()).join('|')`)
  check('[S1] 三 tab 文案齐全(消息/文件/Pin)', tabsText.includes('消息') && tabsText.includes('文件') && tabsText.includes('Pin'), tabsText)
  await capture('s1-project-session-tabs')
}

/** 交互回路①: 每 tab 开↔关↔再开 + 消息草稿在 tab 切换下保持。 */
async function scenarioTabLoop() {
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.library}')`), 10000)
  await until(async () => (await js<number>(`window.__poo196.count('[data-testid^="pc-asset-row-"]')`)) >= 6, 10000)
  check('[S2] 文件 tab 打开出现资产行', true)
  await capture('s2-files-open')

  await clickTab(T.tabPins)
  await until(() => js<boolean>(`window.__poo196.q('${T.pinPane}')`), 10000)
  await until(async () => (await js<number>(`window.__poo196.count('${T.pinPane} [data-testid^="pc-asset-row-"]')`)) >= 1, 10000)
  check('[S2] Pin tab 打开出现条目', true)
  await capture('s2-pins-open')

  // The draft must be typed on the VISIBLE messages tab (focus() on the
  // display:none composer is a no-op — that is production behavior too).
  await clickTab(T.tabMessages)
  await delay(150)
  await typeInto(T.input, 'tab回路草稿')
  await delay(150)
  await clickTab(T.tabFiles)
  await delay(120)
  await clickTab(T.tabPins)
  await delay(120)
  await clickTab(T.tabMessages)
  await delay(200)
  const inputAfterLoop = await js<string>('window.__poo196.inputValue()')
  check('[S2] tab 开↔关↔再开后 ChatDisplay 保持挂载（草稿未丢）', inputAfterLoop.includes('tab回路草稿'), { inputAfterLoop })
  await clearInput()
  await capture('s2-back-to-messages')
}

/** 旅程②: 上传全旅程 + 失败重试 + 超限 + 弹层 Esc 重开。 */
async function scenarioUploadJourney() {
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.library}')`), 8000)

  // 空态探针：过滤到一个不存在的搜索词
  await typeInto(T.search, '不存在的文件名xyz')
  await until(() => js<boolean>(`window.__poo196.q('${T.emptyFiltered}')`), 8000)
  check('[S3] 搜索无结果空态出现', true)
  await capture('s3-empty-filtered')
  await clearSearch()

  // 弹层开 → Esc → 重开
  await openUploadDialog()
  await capture('s3-upload-dialog-empty')
  await pressEscape()
  await until(() => js<boolean>(`!window.__poo196.q('${T.uploadDialog}')`), 5000)
  check('[S3] 上传弹层 Esc 可关闭', true)
  await openUploadDialog()
  check('[S3] 上传弹层可重开', true)

  // 选文件（fixture 对话框队列）→ 摘要
  await runProgramDirect({ op: 'queueFileDialog', args: { paths: [FIXTURE_FILE_SMALL] } })
  await js<boolean>(`window.__poo196.click('${T.uploadPick}')`)
  await until(() => js<boolean>(`window.__poo196.q('[data-testid="pc-upload-file-summary"]')`), 8000)
  const digest = await js<string>(`document.querySelector('[data-testid="pc-upload-digest"]').textContent`)
  check('[S3] 选文件后摘要含 SHA-256 校验值', /^[0-9a-f]{64}$/.test(digest), { digest: digest.slice(0, 16) })

  // 名称 + 预设标签 + 自定义标签
  await typeInto(T.uploadName, '会议纪要-1106.md')
  await js<boolean>(`window.__poo196.click('[data-testid="pc-upload-preset-tag-meeting"]')`)
  await js<boolean>(`window.__poo196.click('[data-testid="pc-upload-preset-tag-stage"]')`)
  await typeInto(T.uploadTagInput, '内部评审')
  await delay(120)
  await js<boolean>(`window.__poo196.click('${T.uploadSubmit}')`)
  await until(() => js<boolean>(`!window.__poo196.q('${T.uploadDialog}')`), 10000)
  await capture('s3-uploaded-processing')

  const toast = await toastText()
  check('[S3] 上传处理中 toast 出现', toast.includes('正在处理'), { toast: toast.slice(0, 120) })
  const newRow = await until(async () => js<string | null>(`(Array.from(document.querySelectorAll('[data-testid^="pc-asset-row-"]')).find(el => el.textContent.includes('会议纪要-1106.md'))?.getAttribute('data-testid') ?? null)`), 8000) as string
  const processingBadge = await js<string>(`document.querySelector('[data-testid="${newRow}"] [data-testid^="pc-asset-status-"]')?.textContent ?? ''`)
  check('[S3] 新行状态徽标为处理中', processingBadge.includes('处理中'), { processingBadge })

  // fixture: 索引完成 → 用户切 tab 触发 refetch → 可用
  await runProgramDirect({ op: 'indexAsset', args: { assetId: newRow.replace('pc-asset-row-', '') } })
  await clickTab(T.tabPins)
  await clickTab(T.tabFiles)
  await delay(600)
  const readyBadge = await js<string>(`document.querySelector('[data-testid="${newRow}"] [data-testid^="pc-asset-status-"]')?.textContent ?? ''`)
  check('[S3] 处理完成后(经列表刷新)徽标为可用', readyBadge === '可用', { readyBadge })
  await capture('s3-uploaded-indexed')

  // ── 上传失败 → 重试（once fault）
  await runProgramDirect({ op: 'setFault', args: { method: 'pcUploadFile', fault: { code: 'pc_upload_failed', once: true } } })
  await openUploadDialog()
  await runProgramDirect({ op: 'queueFileDialog', args: { paths: [FIXTURE_FILE_SMALL] } })
  await js<boolean>(`window.__poo196.click('${T.uploadPick}')`)
  await until(() => js<boolean>(`window.__poo196.q('[data-testid="pc-upload-file-summary"]')`), 8000)
  await typeInto(T.uploadName, '重试素材.md')
  await js<boolean>(`window.__poo196.click('${T.uploadSubmit}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.uploadError}')`), 8000)
  const uploadErrorText = (await js<string>(`document.querySelector('${T.uploadError}').textContent`)).trim()
  const expectedUploadFail = (await i18nText('projectContext.errors.uploadFailed')).trim()
  check('[S3] 上传失败内联错误为映射文案（非兜底）', uploadErrorText.length > 0 && uploadErrorText === expectedUploadFail, { uploadErrorText, expectedUploadFail })
  check('[S3] 失败后弹层保持打开（表单不丢）', await js<boolean>(`window.__poo196.q('${T.uploadDialog}')`))
  await capture('s3-upload-failed-inline')
  await js<boolean>(`window.__poo196.click('${T.uploadSubmit}')`)
  await until(() => js<boolean>(`!window.__poo196.q('${T.uploadDialog}')`), 10000)
  check('[S3] 清除故障后重试成功关闭弹层', true)
  await pressEscape()

  // ── 超限（客户端 prep 拦截）
  await runProgramDirect({ op: 'setCapabilities', args: { capabilities: { limits: { maxUploadBytes: 1024, downloadUrlTtlSeconds: 60 } } } })
  await openUploadDialog()
  await runProgramDirect({ op: 'queueFileDialog', args: { paths: [FIXTURE_FILE_HUGE] } })
  await js<boolean>(`window.__poo196.click('${T.uploadPick}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.uploadError}')`), 8000)
  const tooLargeText = (await js<string>(`document.querySelector('${T.uploadError}').textContent`)).trim()
  const expectedTooLarge = (await i18nText('projectContext.errors.uploadTooLarge')).trim()
  check('[S3] 超限文件被客户端拦截且文案映射', tooLargeText === expectedTooLarge, { tooLargeText })
  await capture('s3-upload-too-large')
  await pressEscape()
  await runProgramDirect({ op: 'setCapabilities', args: { capabilities: { limits: { maxUploadBytes: 52_428_800, downloadUrlTtlSeconds: 60 } } } })
  await runProgramDirect({ op: 'resetAssets' })
  await delay(400)
}

/** 旅程③: @ 引用全旅程 + Esc 回路 + chip 增删 + 发送携带结构化引用 + 快照。 */
async function scenarioMentionJourney() {
  await clickTab(T.tabMessages)
  await until(() => js<boolean>(`window.__poo196.q('${T.input}')`), 8000)
  await clearInput()

  // 输入 @ → 浮层开（空查询态）
  await clearInput()
  await typeChars('@')
  await until(() => js<boolean>(`window.__poo196.q('${T.mentionPopover}')`), 8000)
  check('[S4] 输入 @ 后浮层打开', true)
  await capture('s4-mention-open-empty')

  // Esc → 再开（回路）
  await pressEscape()
  await until(() => js<boolean>(`!window.__poo196.q('${T.mentionPopover}')`), 5000)
  check('[S4] Esc 关闭 @ 浮层', true)
  await typeMentionQuery('会')
  await until(() => js<boolean>(`window.__poo196.q('${T.mentionPopover}')`), 5000)
  check('[S4] Esc 后可再开', true)

  // 防抖搜索 → 命中
  await until(async () => (await js<number>(`window.__poo196.count('[data-testid^="pc-mention-option-"]')`)) >= 1, 8000)
  const optionCount = await js<number>(`window.__poo196.count('[data-testid^="pc-mention-option-"]')`)
  check('[S4] 查询「会」命中候选', optionCount >= 1, { optionCount })
  const snippetShown = await js<boolean>(`Array.from(document.querySelectorAll('[data-testid^="pc-mention-option-"]')).some(el => (el.textContent || '').includes('迭代对齐'))`)
  check('[S4] 候选带正文摘要', snippetShown)
  await capture('s4-mention-options')

  // 键盘: ↓ + Enter 选中
  host.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' } as unknown as Electron.InputInputEvent)
  host.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' } as unknown as Electron.InputInputEvent)
  await delay(80)
  const highlighted = await js<string>(`document.querySelector('[data-testid^="pc-mention-option-"][data-highlighted="true"]')?.getAttribute('data-testid') ?? ''`)
  check('[S4] ↓ 移动高亮', highlighted.length > 0, { highlighted })
  host.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' } as unknown as Electron.InputInputEvent)
  host.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' } as unknown as Electron.InputInputEvent)
  await delay(250)

  const chips = await js<Array<{ assetId: string; name: string }>>(`window.__poo196.draftRefs(window.__poo196.sessions.project).map(d => ({ assetId: d.assetId, name: d.name }))`)
  check('[S4] Enter 选中后草稿 chip 入队', chips.length === 1, { chips })
  const popoverClosed = await js<boolean>(`!window.__poo196.q('${T.mentionPopover}')`)
  const tokenStripped = await js<string>('window.__poo196.inputValue()')
  check('[S4] 浮层关闭且 @query 不残留在正文', popoverClosed && !tokenStripped.includes('@会'), { tokenStripped })
  await capture('s4-mention-chip-queued')

  // 鼠标路径再选一个
  await typeMentionQuery('需求')
  await until(async () => (await js<number>(`window.__poo196.count('[data-testid^="pc-mention-option-"]')`)) >= 1, 8000)
  await js<boolean>(`(() => { const el = document.querySelector('[data-testid^="pc-mention-option-"]'); const rect = el.getBoundingClientRect(); const base = { bubbles: true, cancelable: true, view: window, clientX: rect.x + 5, clientY: rect.y + 5, button: 0 }; el.dispatchEvent(new MouseEvent('mousedown', base)); el.dispatchEvent(new MouseEvent('mouseup', base)); el.dispatchEvent(new MouseEvent('click', base)); return true })()`)
  await delay(250)
  const chipsTwo = await js<number>(`window.__poo196.draftRefs(window.__poo196.sessions.project).length`)
  check('[S4] 鼠标点选再入队一个 chip', chipsTwo === 2, { chipsTwo })

  // chip 消选（移除一个）
  const firstChipId = (await js<Array<{ assetId: string }>>('window.__poo196.draftRefs(window.__poo196.sessions.project).map(d => ({ assetId: d.assetId }))'))[0].assetId
  await js<boolean>(`window.__poo196.click('[data-testid="project-asset-draft-chip-remove-${firstChipId}"]')`)
  await delay(200)
  check('[S4] 点 chip × 后移除', (await js<number>('window.__poo196.draftRefs(window.__poo196.sessions.project).length')) === 1)

  // 发送（生产 craft:submit-input 通道）→ 结构化引用随 send 走，正文与 chips 清空
  await typeInto(T.input, '请对照这份材料给出验收要点')
  await js<boolean>('window.__poo196.send()')
  await until(() => js<boolean>(`window.__poo196.sendMessageLog.length >= 1`), 8000)
  const sent = await js<{ message: string; projectAssetRefs: Array<{ assetId: string; version: number; name: string }> }>(`window.__poo196.sendMessageLog[window.__poo196.sendMessageLog.length - 1]`)
  check('[S4] 发送携带结构化 projectAssetRefs（assetId+version+name）', sent.projectAssetRefs.length === 1 && typeof sent.projectAssetRefs[0].version === 'number', sent)
  check('[S4] 发送后草稿 chips 清空', (await js<number>('window.__poo196.draftRefs(window.__poo196.sessions.project).length')) === 0)
  await capture('s4-sent-with-ref')

  // 消息快照 chips（fixture 历史 ok/stale/missing 三态 + 新发送的引用）
  await until(async () => (await js<number>(`window.__poo196.count('${T.snapshotChips}')`)) >= 1, 8000)
  const snapshotChipCount = await js<number>(`window.__poo196.count('${T.snapshotChips} > span')`)
  check('[S4] 消息快照 chips 渲染（历史 ok/stale/missing 三态）', snapshotChipCount === 3, { snapshotChipCount })
  const staleLabel = await js<string>(`document.querySelector('[data-testid="project-asset-ref-status-stale"]')?.textContent ?? ''`)
  const missingLabel = await js<string>(`document.querySelector('[data-testid="project-asset-ref-status-missing"]')?.textContent ?? ''`)
  check('[S4] 快照含 stale 与 missing 结果标注', staleLabel.length > 0 && missingLabel.length > 0, { staleLabel, missingLabel })
  await clearInput()
  await js<boolean>(`(() => { const first = document.querySelector('${T.snapshotChips}'); first?.scrollIntoView({ block: 'center' }); return true })()`)
  await capture('s4-message-snapshot-chips')

  // R-1 回归（统一 @ 浮层 · 非资产行）：浮层里点技能行不得清空 composer 正文。
  // 修前路径走 inlineMention 的陈旧触发快照，正文整段被重置为提及 token。
  const pickExtraRow = (testId: string) => js<boolean>(`(() => {
    const el = document.querySelector('[data-testid="${testId}"]')
    if (!el) return false
    const rect = el.getBoundingClientRect()
    const base = { bubbles: true, cancelable: true, view: window, clientX: rect.x + 5, clientY: rect.y + 5, button: 0 }
    el.dispatchEvent(new MouseEvent('mousedown', base))
    el.dispatchEvent(new MouseEvent('mouseup', base))
    el.dispatchEvent(new MouseEvent('click', base))
    return true
  })()`)
  await clearInput()
  await typeInto(T.input, '先把验收范围写清楚 ')
  await typeChars('@')
  await until(() => js<boolean>(`window.__poo196.q('${T.mentionPopover}')`), 8000)
  await until(async () => (await js<number>(`window.__poo196.count('[data-testid="pc-mention-extra-skill:acceptance-checklist"]')`)) === 1, 8000)
  check('[S4·R-1] 统一浮层出现技能组与技能行', true)
  await capture('s4-r1-skill-row')
  check('[S4·R-1] 点技能行前正文在', (await js<string>('window.__poo196.inputValue()')).includes('先把验收范围写清楚'))
  const r1LogMark = await js<number>('window.__poo196.inputChangeLog.length')
  check('[S4·R-1] 点技能行命中', await pickExtraRow('pc-mention-extra-skill:acceptance-checklist'))
  // RAW 模型走 onInputChange（debounce 300ms）——等它流出再断言 token。
  await until(async () => (await js<number>(`window.__poo196.inputChangeLog.length`)) > r1LogMark, 4000)
  await delay(120)
  const r1MouseValue = await js<string>('window.__poo196.inputValue()')
  const r1MouseRaw = (await js<Array<string>>('window.__poo196.inputChangeLog')).at(-1) ?? ''
  check('[S4·R-1] 鼠标点技能行后正文保留', r1MouseValue.includes('先把验收范围写清楚'), { r1MouseValue, r1MouseRaw })
  check('[S4·R-1] 技能提及 token 落位（raw 模型）', r1MouseRaw.includes('[skill:ws-apollo:acceptance-checklist]'), { r1MouseRaw })
  check('[S4·R-1] 徽标渲染技能名', r1MouseValue.includes('验收清单'), { r1MouseValue })
  check('[S4·R-1] 触发 @ 不残留', !r1MouseValue.includes('@') && !r1MouseRaw.includes('@'), { r1MouseValue, r1MouseRaw })
  await capture('s4-r1-skill-picked')

  // 键盘路径（↓ + Enter）同验：另一段正文 + 裸 @ → 高亮停在第 0 行（无资产
  // 命中时即技能行）→ Enter 走同一条 R-1 插入路径。
  await clearInput()
  await typeInto(T.input, '键盘路径也要保住这段 ')
  await typeChars('@')
  await until(() => js<boolean>(`window.__poo196.q('${T.mentionPopover}')`), 8000)
  await until(async () => (await js<number>(`window.__poo196.count('[data-testid^="pc-mention-extra-"]')`)) >= 1, 8000)
  host.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' } as unknown as Electron.InputInputEvent)
  host.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' } as unknown as Electron.InputInputEvent)
  await delay(80)
  const r1Highlighted = await js<string>(`document.querySelector('[data-testid="pc-mention-extra-skill:acceptance-checklist"]')?.getAttribute('data-highlighted') ?? ''`)
  check('[S4·R-1] ↓ 高亮落在技能行', r1Highlighted === 'true', { r1Highlighted })
  const r1KeyLogMark = await js<number>('window.__poo196.inputChangeLog.length')
  host.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' } as unknown as Electron.InputInputEvent)
  host.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' } as unknown as Electron.InputInputEvent)
  await until(async () => (await js<number>(`window.__poo196.inputChangeLog.length`)) > r1KeyLogMark, 4000)
  await delay(120)
  const r1KeyValue = await js<string>('window.__poo196.inputValue()')
  const r1KeyRaw = (await js<Array<string>>('window.__poo196.inputChangeLog')).at(-1) ?? ''
  check('[S4·R-1] Enter 选技能行后正文保留', r1KeyValue.includes('键盘路径也要保住这段'), { r1KeyValue, r1KeyRaw })
  check('[S4·R-1] 键盘路径提及 token 落位（raw 模型）', r1KeyRaw.includes('[skill:ws-apollo:acceptance-checklist]'), { r1KeyRaw })

  // 发送这条「正文 + 技能提及」：token 随生产 send 通道流出（wire 形状）。
  await js<boolean>('window.__poo196.send()')
  await until(() => js<boolean>(`window.__poo196.sendMessageLog.length >= 1`), 8000)
  const r1Sent = await js<{ message: string }>(`window.__poo196.sendMessageLog[window.__poo196.sendMessageLog.length - 1]`)
  check('[S4·R-1] 发送携带正文与技能 token', r1Sent.message.includes('键盘路径也要保住这段')
    && r1Sent.message.includes('[skill:ws-apollo:acceptance-checklist]'), { message: r1Sent.message })
  await clearInput()

  // 降级搜索提示
  await runProgramDirect({ op: 'setDegraded', args: { degraded: true } })
  await typeMentionQuery('数据')
  await until(() => js<boolean>(`window.__poo196.q('${T.mentionDegraded}')`), 8000)
  check('[S4] 降级搜索在浮层内提示「仅按名称与标签匹配」', true)
  await capture('s4-mention-degraded')
  await runProgramDirect({ op: 'setDegraded', args: { degraded: false } })
  await clearInput()
}

/** 交互回路②: 行菜单 / Pin / 已确认 / 状态过滤往返 / 下载 / 预览。 */
async function scenarioRowActionsAndPins() {
  mark('S5:list-loaded')
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.library}')`), 8000)
  await until(async () => (await js<number>(`window.__poo196.count('${T.list} [data-testid^="pc-asset-row-"]')`)) >= 7, 10000)

  // 行菜单开 → 点外部 → 重开
  check('[S5] 行菜单打开', await openRowMenu('as-design-home', 'download'))
  await js<boolean>(`window.__poo196.click('${T.search}')`)
  await delay(300)
  check('[S5] 点外部关闭行菜单', await js<boolean>(`!window.__poo196.q('${rowAction('as-design-home', 'download')}')`))
  check('[S5] 行菜单可重开', await openRowMenu('as-design-home', 'download'))
  await capture('s5-row-menu-open')
  await pressEscape()

  // Pin → toast → 行状态翻转 → Pin 面板（as-meeting-1030 起始未 Pin，动作将其翻转为已 Pin）
  mark('S5:row-menu-captured')
  await clickMenuAction('as-meeting-1030', 'pin')
  mark('S5:pin-clicked')
  // 行状态翻转为 gate；toast 单独记录（toast 渲染本身由 S3/S6 证明）
  await until(async () => (await js<string>(`document.querySelector('[data-testid="pc-asset-row-as-meeting-1030"]')?.getAttribute('data-pinned')`)) === 'true', 8000)
  const pinToastSeen = (await toastText()).includes('已 Pin')
  check('[S5] Pin 操作 toast 反馈', pinToastSeen, { pinToastSeen })
  const pinnedAttr = await js<string>(`document.querySelector('[data-testid="pc-asset-row-as-meeting-1030"]')?.getAttribute('data-pinned')`)
  check('[S5] 行 data-pinned 翻转', pinnedAttr === 'true', { pinnedAttr })

  mark('S5:pinned-attr-ok')
  await clickTab(T.tabPins)
  await until(() => js<boolean>(`window.__poo196.q('${T.pinPane}')`), 8000)
  mark('S5:pin-pane')
  await until(() => js<boolean>(`window.__poo196.q('${T.pinPane} [data-testid="pc-asset-row-as-meeting-1030"]')`), 8000)
  mark('S5:pin-pane-entry')
  check('[S5] Pin 面板出现刚 Pin 的行', true)
  const reqDocCards = await js<number>(`window.__poo196.count('${T.pinPane} [data-testid="pc-asset-row-as-req-doc"]')`)
  check('[S5] pinned+confirmed 资产在 Pin 面板只出现一次（合并视图）', reqDocCards === 1, { reqDocCards })
  await capture('s5-pin-pane')

  // Unpin 回路（Pin 面板内行菜单只有 取消 Pin）
  for (const mode of ['key', 'pointer']) {
    if (mode === 'key') await js<boolean>(`window.__poo196.pressEnterOn('${T.pinPane} ${rowMenu('as-meeting-1030')}')`)
    else await js<boolean>(`window.__poo196.click('${T.pinPane} ${rowMenu('as-meeting-1030')}')`)
    const opened = await until(() => js<boolean>(`window.__poo196.q('${rowAction('as-meeting-1030', 'pin')}')`), 3000)
    if (opened) break
    await pressEscape()
    await delay(150)
  }
  const unpinLabel = (await js<string>(`document.querySelector('${rowAction('as-meeting-1030', 'pin')}').textContent`)).trim()
  check('[S5] Pin 面板内菜单呈现「取消 Pin」', unpinLabel.includes('取消'), { unpinLabel })
  await js<boolean>(`window.__poo196.pressEnterOn('${rowAction('as-meeting-1030', 'pin')}')`)
  await delay(600)
  check('[S5] Unpin 后从 Pin 面板消失', await js<boolean>(`!window.__poo196.q('${T.pinPane} [data-testid="pc-asset-row-as-meeting-1030"]')`))

  // 已确认回路（manager 能力位）
  await clickTab(T.tabFiles)
  await delay(400)
  await clickMenuAction('as-meeting-1030', 'confirm')
  await delay(700)
  check('[S5] 确认后行出现已确认徽标', await js<boolean>(`window.__poo196.q('[data-testid="pc-asset-confirmed-as-meeting-1030"]')`))
  await js<boolean>(`window.__poo196.click('[data-testid="pc-tag-filter-confirmed"]')`)
  await delay(700)
  const confirmedRows = await js<number>(`window.__poo196.count('${T.list} [data-testid^="pc-asset-row-"]')`)
  check('[S5] 已确认过滤 chip 过滤列表', confirmedRows >= 2, { confirmedRows })
  await capture('s5-filter-confirmed')
  await js<boolean>(`window.__poo196.click('[data-testid="pc-tag-filter-confirmed"]')`)
  await delay(400)
  check('[S5] 再点过滤 chip 取消过滤（选↔消）', await js<boolean>(`window.__poo196.q('${T.list}')`))

  // 状态过滤往返
  await js<boolean>(`window.__poo196.click('[data-testid="pc-status-filter-processing"]')`)
  await delay(400)
  const processingRows = await js<number>(`window.__poo196.count('${T.list} [data-testid^="pc-asset-row-"]')`)
  check('[S5] 处理中状态过滤只留处理中行', processingRows === 1, { processingRows })
  await capture('s5-filter-processing')
  await js<boolean>(`window.__poo196.click('[data-testid="pc-status-filter-failed"]')`)
  await delay(400)
  const failedRows = await js<number>(`window.__poo196.count('${T.list} [data-testid^="pc-asset-row-"]')`)
  check('[S5] 失败过滤切换生效', failedRows === 1, { failedRows })
  await js<boolean>(`window.__poo196.click('[data-testid="pc-status-filter-all"]')`)
  await delay(400)
  check('[S5] 回到全部过滤', (await js<number>(`window.__poo196.count('${T.list} [data-testid^="pc-asset-row-"]')`)) >= 7)

  // 行菜单: 撤销已确认
  await clickMenuAction('as-meeting-1030', 'confirm')
  await delay(600)
  check('[S5] 撤销确认后徽标消失', await js<boolean>(`!window.__poo196.q('[data-testid="pc-asset-confirmed-as-meeting-1030"]')`))

  // 非上传者行不出现替换入口（D4.1）
  for (let attempt = 0; attempt < 2; attempt++) {
    await js<boolean>(`window.__poo196.click('${rowMenu('as-req-doc')}')`)
    const opened = await probeUntil(() => js<boolean>(`window.__poo196.q('${rowAction('as-req-doc', 'confirm')}')`), 4000)
    if (opened) break
    await pressEscape()
    await delay(200)
  }
  await delay(150)
  check('[S5] 非上传者行无「替换文件」入口（D4.1）', await js<boolean>(`!window.__poo196.q('${rowAction('as-req-doc', 'replace')}')`))
  check('[S5] manager 对非上传者行仍有确认入口', await js<boolean>(`window.__poo196.q('${rowAction('as-req-doc', 'confirm')}')`))
  await pressEscape()

  // 下载（fixture 落盘 + toast）
  await clickMenuAction('as-meeting-1030', 'download')
  await until(async () => (await toastText()).includes('会议纪要-1030'), 10000)
  check('[S5] 下载 toast 提示文件名', true)
  check('[S5] 下载落盘到 fixture Downloads', existsSync(join(fixture.downloadDir, '会议纪要-1030.md')))

  // 预览（text/html 行才有预览入口；短授权 → 隔离覆盖层）
  await clickMenuAction('as-prototype-html', 'preview')
  await until(() => js<boolean>(`window.__poo196.q('${T.previewOverlay}')`), 10000)
  check('[S5] 预览覆盖层打开（隔离沙箱 + 授权 URL fetch）', result.previewHttpRequests.length >= 1, { requests: result.previewHttpRequests })
  await capture('s5-preview-overlay')
  await pressEscape()
  await delay(300)
}

/**
 * S-10 预览隔离：共享 HTML 是不可信内容。打开 S-10 夹具（自带放宽 CSP、
 * 远程 fetch/XHR、外链 img/iframe、window.open、外链与表单提交、子帧 meta
 * refresh / location.href 自导航），断言全部向量被拦：CSP 违规事件发生、
 * 守卫脚本日志发生、R-4 子帧导航守卫拦下自导航、预览服务器没有收到任何
 * /beacon/* 请求（被拦截即无网络到达），且覆盖层保持原样。
 */
async function scenarioPreviewIsolation() {
  mark('S5b:list-loaded')
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.library}')`), 8000)
  await until(async () => (await js<number>(`window.__poo196.count('${T.list} [data-testid="pc-asset-row-as-hostile-html"]')`)) === 1, 10000)

  const guardMarkBefore = result.previewGuardEvents.length
  const cspMarkBefore = result.previewCspViolations.length
  const beaconBefore = result.previewHttpRequests.filter((entry) => entry.includes('/beacon/')).length
  const frameBlockBefore = result.frameNavBlocks.length

  mark('S5b:preview-opening')
  await clickMenuAction('as-hostile-html', 'preview')
  await until(() => js<boolean>(`window.__poo196.q('${T.previewOverlay}')`), 10000)
  await until(() => js<boolean>(`window.__poo196.q('${T.previewFrame}')`), 8000)
  mark('S5b:preview-open')

  // 静态隔离壳：sandbox 只保留脚本能力；注入的 CSP meta 位于文档自身 head
  // 的最前（DOMParser 注入，完整文档保持原形）。
  const frameSandbox = await js<string>(`document.querySelector('${T.previewFrame}')?.getAttribute('sandbox') ?? ''`)
  check('[S5b] iframe sandbox 只保留 allow-scripts', frameSandbox === 'allow-scripts', { frameSandbox })
  const srcDocHead = await js<string>(`(document.querySelector('${T.previewFrame}')?.getAttribute('srcdoc') ?? '').slice(0, 500)`)
  check('[S5b] srcDoc 以 doctype+head+注入 CSP meta 开头', /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/.test(srcDocHead), { head: srcDocHead.slice(0, 200) })
  check('[S5b] 注入策略不放宽（default-src none）', srcDocHead.includes("default-src 'none'"), {})
  check('[S5b] srcDoc 内嵌守卫脚本', srcDocHead.includes('[preview-guard]'), {})
  const probeWarnings = () => result.consoleNoise.warnings.filter((entry) => entry.includes('[poo196-probe]'))
  const probeFrameSrcdoc = await js<string>(`document.querySelector('${T.previewFrame}')?.getAttribute('srcdoc') ?? ''`)
  // R-4 第一层（确定性）：hardenProjectPreviewHtml 在 DOMParser 阶段剥掉静态
  // meta refresh——srcdoc 里不能再出现落点 URL。
  check('[S5b·R-4] 静态 meta refresh 在入沙箱前被剥离', !probeFrameSrcdoc.includes('/beacon/meta-refresh')
    && probeFrameSrcdoc.includes('meta-js appended'), {})

  // 给页面脚本一点时间把全部向量都打一遍（脚本在 load 时自触发；追加的
  // meta-js 对照向量带 1 秒延迟，覆盖「0 秒 refresh 与首次 commit 合并」的
  // 疑点——若它被拦而静态那条没有，结论就落在时序而非向量本身）。
  await delay(2500)

  check('[S5b·R-4] 运行期追加的 refresh meta 被守卫脚本移除', probeWarnings().some((entry) => entry.includes('meta-refresh-in-head=0'))
    && probeWarnings().some((entry) => entry.includes('meta-js appended')), { probes: probeWarnings().slice(0, 6) })

  const beacons = result.previewHttpRequests.filter((entry) => entry.includes('/beacon/'))
  check('[S5b] 信标零到达（CSP + 守卫拦截）', beacons.length === beaconBefore, { beacons: beacons.slice(0, 8) })
  check('[S5b] 预览文档本身有到达（夹具授权链路未破坏）', result.previewHttpRequests.some((entry) => entry.includes('/preview/as-hostile-html')))

  // R-4：子帧自导航（meta refresh 无脚本变体 + location.href 脚本变体）必须
  // 被双层防御拦下——静态向量入沙箱前剥离、动态向量守卫脚本移除 + 主进程
  // 子帧导航守卫 preventDefault，请求一律零到达。
  const frameBlocksNew = result.frameNavBlocks.slice(frameBlockBefore)
  const guardNewEarly = result.previewGuardEvents.slice(guardMarkBefore)
  // meta refresh 两层证据：静态向量在 DOMParser 阶段被剥（探针报
  // meta-refresh-in-head=0）；运行期追加的那条由守卫脚本移除留痕，且
  // Chromium 在移除前已武装的 refresh 导航被主进程子帧守卫拦下
  // （frameNavBlocks 有落点）。两条向量都零网络到达。
  const metaJsBlockedAtMainProcess = frameBlocksNew.some((entry) => entry.includes('/beacon/meta-js'))
  check('[S5b·R-4] meta refresh 零到达且双层拦截', !beacons.some((entry) => entry.includes('/beacon/meta-refresh'))
    && !beacons.some((entry) => entry.includes('/beacon/meta-js'))
    && guardNewEarly.some((entry) => entry.includes('meta refresh removed'))
    && metaJsBlockedAtMainProcess,
  { frameBlocks: frameBlocksNew, guard: guardNewEarly.slice(0, 8) })
  // location.href：主进程 will-frame-navigate 守卫的直接证据（preventDefault
  // + 落点留痕），请求零到达。
  check('[S5b·R-4] location.href 自导航被拦且零到达', !beacons.some((entry) => entry.includes('/beacon/location-href'))
    && frameBlocksNew.some((entry) => entry.includes('/beacon/location-href')), {})
  check('[S5b·R-4] srcdoc 预览未被守卫误伤（about:* 放行）', frameBlocksNew.every((entry) => !entry.includes('about:srcdoc')), { frameBlocks: frameBlocksNew })

  const guardNew = result.previewGuardEvents.slice(guardMarkBefore)
  check('[S5b] 守卫拦下 window.open', guardNew.some((entry) => entry.includes('window.open blocked')), { guardNew: guardNew.slice(0, 6) })
  check('[S5b] 守卫拦下外链导航', guardNew.some((entry) => entry.includes('link navigation blocked')), {})
  // 表单向量的第一道闸是 sandbox（未授 allow-forms，submit 事件在派发前就被
  // Chromium 短路），所以守卫日志与沙箱拒绝任一出现即算拦下。
  check('[S5b] 表单提交被拦（守卫或沙箱）', guardNew.some((entry) => entry.includes('form submit blocked'))
    || result.previewCspViolations.slice(cspMarkBefore).some((entry) => /Blocked form submission/i.test(entry)), {})

  const cspNew = result.previewCspViolations.slice(cspMarkBefore)
  check('[S5b] CSP 拒绝远程图片', cspNew.some((entry) => /Loading the image .*violates|Refused to load/i.test(entry)), { cspNew: cspNew.slice(0, 6) })
  check('[S5b] CSP 拒绝远程 fetch/XHR', cspNew.some((entry) => /Refused to connect|Connecting to .*violates/i.test(entry)), {})
  // 内嵌外域 iframe：R-4 守卫在导航层拦截后，CSP 的 Framing 违规可能不再产
  // 生——导航守卫记录与 CSP 违规任一出现即算隔离成立。
  check('[S5b] 内嵌外域 iframe 被拦（CSP 或导航守卫）', cspNew.some((entry) => /Framing .*violates|Refused to (load|frame)/i.test(entry))
    || frameBlocksNew.some((entry) => entry.includes('/beacon/iframe')), {})
  check('[S5b] CSP 违规事件 ≥ 3', cspNew.length >= 3, { count: cspNew.length })

  // 页面自己的放宽 CSP meta 不可能反客为主：覆盖层仍挂在本体、frame 未逃逸。
  check('[S5b] 覆盖层未被破坏', await js<boolean>(`window.__poo196.q('${T.previewOverlay}')`), {})
  check('[S5b] frame 未发生自导航离开', await js<boolean>(`window.__poo196.q('${T.previewFrame}')`), {})
  await capture('s5b-preview-isolation')

  // Esc 关闭 + 焦点回归（X20）
  await pressEscape()
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.previewOverlay}')`)), 4000)
  check('[S5b] Esc 关闭预览覆盖层', await js<boolean>(`!window.__poo196.q('${T.previewOverlay}')`), {})
}

/** 旅程④: 删除 → 回收站 → 恢复 → 再删。 */
async function scenarioTrashJourney() {
  await clickTab(T.tabFiles)
  await delay(300)
  await clickMenuAction('as-meeting-1030', 'delete')
  await until(() => js<boolean>(`window.__poo196.q('${T.deleteConfirm}')`), 5000)
  const confirmText = await js<string>(`document.querySelector('${T.deleteConfirm}')?.textContent ?? ''`)
  check('[S6] 删除二次确认点名文件', confirmText.includes('会议纪要-1030'), { snippet: confirmText.slice(0, 120) })
  await capture('s6-delete-confirm')
  await js<boolean>(`window.__poo196.click('${T.deleteConfirmAction}')`)
  await delay(500)
  check('[S6] 确认后行从列表移除', await js<boolean>(`!window.__poo196.q('[data-testid="pc-asset-row-as-meeting-1030"]')`))
  const trashedToast = await toastText()
  check('[S6] 删除 toast 反馈「已移入回收站」', trashedToast.includes('已移入回收站'), { trashedToast: trashedToast.slice(0, 100) })

  await clickTab(T.trashButton)
  await until(() => js<boolean>(`window.__poo196.q('${T.trashView}')`), 8000)
  await until(() => js<boolean>(`window.__poo196.q('${T.trashList} [data-testid="pc-asset-row-as-meeting-1030"]')`), 8000)
  check('[S6] 回收站出现被删文件', true)
  const rowText = await js<string>(`document.querySelector('${T.trashList} [data-testid="pc-asset-row-as-meeting-1030"]').textContent`)
  const expectedExpires = await i18nText('projectContext.trash.expires')
  check('[S6] 回收站行带保留期限', rowText.includes(expectedExpires.slice(0, 3)), { snippet: rowText.slice(-60) })
  await capture('s6-trash-list')

  // 恢复 → 回到列表
  await js<boolean>(`window.__poo196.click('[data-testid="pc-asset-restore-as-meeting-1030"]')`)
  await until(async () => (await toastText()).includes('已恢复'), 10000)
  check('[S6] 恢复 toast 反馈', true)
  await js<boolean>(`window.__poo196.click('[data-testid="pc-trash-back"]')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.library}')`), 8000)
  await delay(800)
  check('[S6] 恢复后文件重新出现在列表', await js<boolean>(`window.__poo196.q('[data-testid="pc-asset-row-as-meeting-1030"]')`))
  await capture('s6-restored-back-in-library')

  // 回收站 ↔ 文件库往返（back 键回路）
  await clickTab(T.trashButton)
  await until(() => js<boolean>(`window.__poo196.q('${T.trashView}')`), 8000)
  await js<boolean>(`window.__poo196.click('[data-testid="pc-trash-back"]')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.library}')`), 8000)
  check('[S6] 回收站↔库往返后回到文件库', true)

  // 再删（留存回收站）
  await clickMenuAction('as-meeting-1030', 'delete')
  await until(() => js<boolean>(`window.__poo196.q('${T.deleteConfirm}')`), 5000)
  await js<boolean>(`window.__poo196.click('${T.deleteConfirmAction}')`)
  await delay(400)
  check('[S6] 再删成功（留存回收站）', await js<boolean>(`!window.__poo196.q('[data-testid="pc-asset-row-as-meeting-1030"]')`))
}

/** 错误态: 全部 17 个 pc_* 错误码至少一个 UI 呈现 + 专用呈现路径。 */
async function scenarioErrorCodes() {
  const codes = [
    'pc_forbidden', 'pc_not_found', 'pc_feature_disabled', 'pc_read_only', 'pc_library_not_ready',
    'pc_validation_error', 'pc_revision_conflict', 'pc_replace_not_uploader', 'pc_confirmed_required',
    'pc_upload_not_found', 'pc_upload_expired', 'pc_upload_too_large', 'pc_upload_failed',
    'pc_content_not_indexed', 'pc_trash_expired', 'pc_service_unavailable', 'pc_signin_required',
  ] as const

  const keyFor: Record<(typeof codes)[number], string> = {
    pc_forbidden: 'projectContext.errors.forbidden',
    pc_not_found: 'projectContext.errors.notFound',
    pc_feature_disabled: 'projectContext.errors.featureDisabled',
    pc_read_only: 'projectContext.errors.readOnly',
    pc_library_not_ready: 'projectContext.errors.libraryNotReady',
    pc_validation_error: 'projectContext.errors.validation',
    pc_revision_conflict: 'projectContext.errors.revisionConflict',
    pc_replace_not_uploader: 'projectContext.errors.replaceNotUploader',
    pc_confirmed_required: 'projectContext.errors.confirmedRequired',
    pc_upload_not_found: 'projectContext.errors.uploadNotFound',
    pc_upload_expired: 'projectContext.errors.uploadExpired',
    pc_upload_too_large: 'projectContext.errors.uploadTooLarge',
    pc_upload_failed: 'projectContext.errors.uploadFailed',
    pc_content_not_indexed: 'projectContext.errors.contentNotIndexed',
    pc_trash_expired: 'projectContext.errors.trashExpired',
    pc_service_unavailable: 'projectContext.errors.serviceUnavailable',
    pc_signin_required: 'projectContext.errors.signinRequired',
  }
  const genericCopy = (await i18nText('projectContext.errors.generic')).trim()
  const conflictCopy = (await i18nText('projectContext.errors.revisionConflict')).trim()
  const unavailableCopy = (await i18nText('projectContext.errors.serviceUnavailable')).trim()

  // 专用呈现先做（菜单/弹层在健康状态下最可靠），17 码横幅扫尾。
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 10000)
  await until(async () => (await js<number>(`window.__poo196.count('${T.list} [data-testid^="pc-asset-row-"]')`)) >= 7, 10000)

  // 专用呈现: 替换冲突（弹层保持打开）
  await runProgramDirect({ op: 'setFault', args: { method: 'pcUploadFile', fault: { code: 'pc_revision_conflict' } } })
  let replaceDialogOpened = false
  for (let round = 0; round < 3 && !replaceDialogOpened; round++) {
    if (!await openRowMenu('as-design-home', 'replace')) continue
    await js<boolean>(`window.__poo196.pressEnterOn('${rowAction('as-design-home', 'replace')}')`)
    replaceDialogOpened = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.replaceDialog}')`), 2500)
    if (!replaceDialogOpened) await pressEscape()
  }
  check('[S7] 替换弹层打开', replaceDialogOpened)
  if (replaceDialogOpened) {
    await runProgramDirect({ op: 'queueFileDialog', args: { paths: [FIXTURE_FILE_SMALL] } })
    await js<boolean>(`window.__poo196.click('${T.replacePick}')`)
    await until(() => js<boolean>(`window.__poo196.q('[data-testid="pc-replace-file-summary"]')`), 8000)
    await js<boolean>(`window.__poo196.click('${T.replaceSubmit}')`)
    await until(() => js<boolean>(`window.__poo196.q('${T.replaceError}')`), 8000)
    const replaceErr = (await js<string>(`document.querySelector('${T.replaceError}').textContent`)).trim()
    check('[S7] 替换冲突内联文案映射', replaceErr === conflictCopy, { replaceErr })
    check('[S7] 冲突后替换弹层保持打开', await js<boolean>(`window.__poo196.q('${T.replaceDialog}')`))
    await capture('s7-replace-conflict')
  }
  await runProgramDirect({ op: 'setFault', args: { method: 'pcUploadFile', fault: null } })
  await pressEscape()

  // 专用呈现: 恢复冲突 toast（回收站内；先让渲染器拿到回收站列表，再在其背后改版本制造 CAS 冲突）
  await clickTab(T.trashButton)
  await until(() => js<boolean>(`window.__poo196.q('${T.trashView}')`), 8000)
  await until(() => js<boolean>(`window.__poo196.q('[data-testid="pc-asset-restore-as-meeting-1030"]')`), 8000)
  await delay(300)
  await runProgramDirect({ op: 'bumpAssetVersion', args: { assetId: 'as-meeting-1030' } })
  await js<boolean>(`window.__poo196.click('[data-testid="pc-asset-restore-as-meeting-1030"]')`)
  // frozen older toasts stay in the stack — wait for the CONFLICT copy itself
  await probeUntil(async () => (await toastText()).includes(conflictCopy.slice(0, 6)), 8000)
  const restoreToast = await toastText()
  check('[S7] 恢复冲突 toast 为冲突文案', restoreToast.includes(conflictCopy.slice(0, 6)), { restoreToast: restoreToast.slice(0, 120) })
  await capture('s7-restore-conflict-toast')

  // 专用呈现: 下载失败 toast
  await js<boolean>(`window.__poo196.click('[data-testid="pc-trash-back"]')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 8000)
  await runProgramDirect({ op: 'setFault', args: { method: 'pcDownloadAsset', fault: { code: 'pc_service_unavailable', once: true } } })
  await clickMenuAction('as-design-home', 'download')
  await probeUntil(async () => (await toastText()).includes(unavailableCopy.slice(0, 6)), 10000)
  const downloadErrToast = await toastText()
  check('[S7] 下载失败 toast 呈现服务不可用文案', downloadErrToast.includes(unavailableCopy.slice(0, 6)), { toast: downloadErrToast.slice(0, 120) })
  await runProgramDirect({ op: 'setFault', args: { method: 'pcDownloadAsset', fault: null } })

  // 专用呈现: Pin 面板冲突文案
  await runProgramDirect({ op: 'setFault', args: { method: 'pcSetPinned', fault: { code: 'pc_revision_conflict', once: true } } })
  mark('S7:download-tost-ok')
  await clickTab(T.tabPins)
  mark('S7:pins-tab-clicked')
  await until(() => js<boolean>(`window.__poo196.q('${T.pinPane}')`), 8000)
  mark('S7:pin-pane')
  await until(() => js<boolean>(`window.__poo196.q('${T.pinPane} [data-testid^="pc-asset-row-"]')`), 8000)
  mark('S7:pin-pane-rows')
  let pinErrorShown = false
  let menuOpened = false
  for (const mode of ['key', 'pointer']) {
    if (mode === 'key') await js<boolean>(`window.__poo196.pressEnterOn('${T.pinPane} ${rowMenu('as-req-doc')}')`)
    else await js<boolean>(`window.__poo196.click('${T.pinPane} ${rowMenu('as-req-doc')}')`)
    const opened = await probeUntil(() => js<boolean>(`window.__poo196.q('${rowAction('as-req-doc', 'pin')}')`), 3000)
    menuOpened = menuOpened || opened
    if (opened) {
      await js<boolean>(`window.__poo196.pressEnterOn('${rowAction('as-req-doc', 'pin')}')`)
      pinErrorShown = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.pinError}')`), 6000)
      if (pinErrorShown) break
    }
    await pressEscape()
    await delay(150)
  }
  if (pinErrorShown) {
    const pinErr = (await js<string>(`document.querySelector('${T.pinError}').textContent`)).trim()
    // 横幅内含「重试」按钮文案，取 includes 而非全等。
    check('[S7] Pin 面板冲突文案呈现', pinErr.includes(conflictCopy), { pinErr })
    await capture('s7-pin-error')
  } else {
    check('[S7] Pin 面板冲突文案呈现', false, { menuOpened })
  }
  await runProgramDirect({ op: 'setFault', args: { method: 'pcSetPinned', fault: null } })

  // 专用呈现: 功能停用（featureEnabled=false）→ 持久态替换整块为中性能力通知
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 10000)
  await runProgramDirect({ op: 'setCapabilities', args: { capabilities: { featureEnabled: false, disabledReason: 'storage_unavailable', canShare: false, canManage: false, library: { status: 'none' } } } })
  await clickTab(T.tabMessages)
  await delay(150)
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('[data-testid="pc-capability-notice"][data-state="storage_unavailable"]')`), 10000)
  const disabledTitle = (await js<string>(`document.querySelector('[data-testid="pc-capability-title"]').textContent`)).trim()
  const storageTitle = (await i18nText('projectContext.capability.storageUnavailableTitle')).trim()
  check('[S7] featureEnabled=false 呈现中性能力通知（storage_unavailable）', disabledTitle === storageTitle, { disabledTitle, storageTitle })
  check('[S7] 停用态替换文件库（列表不再渲染）', !(await js<boolean>(`window.__poo196.q('${T.list}')`)))
  await capture('s7-feature-disabled')
  await runProgramDirect({ op: 'resetAssets' })
  // resetAssets resets the FIXTURE only; the keep-mounted pane re-reads
  // capabilities on an active flip, so round-trip the tabs to clear the
  // storage_unavailable notice before the 17-code scan below.
  await clickTab(T.tabMessages)
  await delay(200)
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 10000)

  // 17 码扫描（每码：注入→呈现映射文案→截图→清障→恢复回路）。
  // 持久态（forbidden/signin_required/feature_disabled）按 S-08 二级降级替换
  // 整块为中性通知（无引擎词、无重试）；其余瞬时码保持面板 + 可重试横幅。
  const noticeStateFor: Partial<Record<(typeof codes)[number], string>> = {
    pc_forbidden: 'forbidden',
    pc_signin_required: 'signed_out',
    pc_feature_disabled: 'not_configured',
  }
  const noticeTitleKeyFor: Record<string, string> = {
    forbidden: 'projectContext.capability.forbiddenTitle',
    signed_out: 'projectContext.capability.signedOutTitle',
    not_configured: 'projectContext.capability.notConfiguredTitle',
  }
  await clickTab(T.tabMessages)
  await delay(200)
  let lastCode = ''
  for (const code of codes) {
    lastCode = code
    const noticeState = noticeStateFor[code]
    // Baseline must be clean BEFORE injecting the next fault: a banner left
    // over from the previous code would otherwise satisfy the face probe below
    // with the WRONG copy (run5 saw pc_not_found read pc_forbidden's banner).
    // The keep-mounted pane pauses polling while hidden, so the round-trip
    // (not waiting alone) is what actually re-reads capabilities here.
    await clickTab(T.tabMessages)
    await delay(200)
    await clickTab(T.tabFiles)
    await until(async () => !(await js<boolean>(`window.__poo196.q('${T.error}')`))
      && !(await js<boolean>(`window.__poo196.q('[data-testid="pc-capability-notice"]')`)), 12000)
    let faceShown = false
    for (let attempt = 0; attempt < 2 && !faceShown; attempt++) {
      await runProgramDirect({ op: 'setFault', args: { method: 'pcListCapabilities', fault: { code } } })
      // The baseline round-trip above left the pane ON the files tab; flipping
      // through messages is what forces the refresh that surfaces this code.
      await clickTab(T.tabMessages)
      await delay(120)
      await clickTab(T.tabFiles)
      faceShown = await probeUntil(
        () => js<boolean>(noticeState
          ? `window.__poo196.q('[data-testid="pc-capability-notice"][data-state="${noticeState}"]')`
          : `window.__poo196.q('${T.error}')`),
        6000,
      )
      if (!faceShown) { await clickTab(T.tabMessages); await delay(400) }
    }
    if (!faceShown) {
      await runProgramDirect({ op: 'setFault', args: { method: 'pcListCapabilities', fault: null } })
      check(`[S7] ${code} 呈现映射文案（非兜底）`, false, { note: 'face not reproduced in 2 attempts' })
      continue
    }
    if (noticeState) {
      const title = (await js<string>(`document.querySelector('[data-testid="pc-capability-title"]').textContent`)).trim()
      const expected = (await i18nText(noticeTitleKeyFor[noticeState])).trim()
      check(`[S7] ${code} 呈现映射文案（非兜底）`, title === expected && expected !== genericCopy, { title, expected })
      await capture(`s7-notice-${code.replace(/_/g, '-')}`)
    } else {
      const shown = (await js<string>(`document.querySelector('${T.error}').textContent`)).trim()
      const expected = (await i18nText(keyFor[code])).trim()
      check(`[S7] ${code} 呈现映射文案（非兜底）`, shown.includes(expected) && expected !== genericCopy, { shown: shown.slice(0, 80), expected })
      await capture(`s7-error-${code.replace(/_/g, '-')}`)
    }
    await runProgramDirect({ op: 'setFault', args: { method: 'pcListCapabilities', fault: null } })
    if (noticeState) {
      // 中性通知无重试——恢复走 tab 往返重读能力；横幅与通知都回到基线。
      await clickTab(T.tabMessages)
      await delay(200)
      await clickTab(T.tabFiles)
      await until(async () => !(await js<boolean>(`window.__poo196.q('[data-testid="pc-capability-notice"]')`))
        && !(await js<boolean>(`window.__poo196.q('${T.error}')`)), 12000)
    } else {
      await js<boolean>(`window.__poo196.click('${T.errorRetry}')`)
      await until(() => js<boolean>(`!window.__poo196.q('${T.error}')`), 10000)
      await clickTab(T.tabMessages)
      await delay(150)
    }
  }
  check('[S7] 重试/往返清除错误呈现', lastCode !== '')
  await clickTab(T.tabMessages)
  await delay(200)
}

/** 会话生命周期: 切会话残留 / 连点 / 慢响应加载态。 */
async function scenarioLifecycle() {
  await runProgramDirect({ op: 'resetAssets' })
  await clickTab(T.tabMessages)
  await delay(250)
  await clearInput()

  // 草稿 chips 跨会话切换语义
  await typeMentionQuery('会议')
  await until(async () => (await js<number>(`window.__poo196.count('[data-testid^="pc-mention-option-"]')`)) >= 1, 8000)
  await js<boolean>(`(() => { const el = document.querySelector('[data-testid^="pc-mention-option-"]'); const rect = el.getBoundingClientRect(); const base = { bubbles: true, cancelable: true, view: window, clientX: rect.x + 5, clientY: rect.y + 5, button: 0 }; el.dispatchEvent(new MouseEvent('mousedown', base)); el.dispatchEvent(new MouseEvent('mouseup', base)); el.dispatchEvent(new MouseEvent('click', base)); return true })()`)
  await delay(250)
  const before = await js<number>('window.__poo196.draftRefs(window.__poo196.sessions.project).length')
  check('[S8] 项目会话入队草稿 chip', before === 1, { before })

  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.personal)`)
  await until(() => js<boolean>(`!window.__poo196.q('${T.tabs}')`), 8000)
  check('[S8] 切到非项目会话后 tab strip 消失', true)
  check('[S8] 非项目会话 composer 无引用 chips 残留', (await js<number>(`window.__poo196.count('${T.draftChips}')`)) === 0)
  await capture('s8-switched-personal')

  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.project)`)
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 8000)
  await delay(200)
  const tabAfterSwitch = await js<string>(`document.querySelector('${T.tabs} [data-state="active"]')?.getAttribute('data-testid') ?? ''`)
  check('[S8] 切回项目会话 tab 重置为消息', tabAfterSwitch === 'pc-tab-messages', { tabAfterSwitch })
  const draftAfter = await js<number>('window.__poo196.draftRefs(window.__poo196.sessions.project).length')
  check('[S8] 未发送草稿按会话留存（切回仍在）', draftAfter === 1, { draftAfter })
  await clearInput()

  mark('S8:draft-left-intact')
  // 连点上传提交 → 仅一次 RPC
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.library}')`), 8000)
  await openUploadDialog()
  await runProgramDirect({ op: 'queueFileDialog', args: { paths: [FIXTURE_FILE_SMALL] } })
  await js<boolean>(`window.__poo196.click('${T.uploadPick}')`)
  await until(() => js<boolean>(`window.__poo196.q('[data-testid="pc-upload-file-summary"]')`), 8000)
  await runProgramDirect({ op: 'setLatency', args: { ms: 300 } })
  await typeInto(T.uploadName, '连点测试.md')
  const before1 = (await runProgramDirect({ op: 'pcCallStats' }) as { byMethod: Record<string, number> }).byMethod
  await js<boolean>(`window.__poo196.click('${T.uploadSubmit}')`)
  await js<boolean>(`window.__poo196.click('${T.uploadSubmit}')`)
  await js<boolean>(`window.__poo196.click('${T.uploadSubmit}')`)
  await until(() => js<boolean>(`!window.__poo196.q('${T.uploadDialog}')`), 15000)
  await runProgramDirect({ op: 'setLatency', args: { ms: 40 } })
  const stats1 = (await runProgramDirect({ op: 'pcCallStats' }) as { byMethod: Record<string, number> }).byMethod
  const uploadDelta = (stats1.pcUploadFile ?? 0) - (before1.pcUploadFile ?? 0)
  check('[S8] 连点提交只发一次 pcUploadFile（按钮 busy 防抖）', uploadDelta === 1, { uploadDelta, uploadCalls: stats1.pcUploadFile })

  mark('S8:upload-single-rpc-ok')
  // 连点删除确认
  await delay(400)
  if (!await openRowMenu('as-data-dict', 'delete')) throw new Error('delete menu never opened')
  await js<boolean>(`window.__poo196.pressEnterOn('${rowAction('as-data-dict', 'delete')}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.deleteConfirm}')`), 5000)
  const before2 = (await runProgramDirect({ op: 'pcCallStats' }) as { byMethod: Record<string, number> }).byMethod
  await js<boolean>(`window.__poo196.click('${T.deleteConfirmAction}')`)
  await js<boolean>(`window.__poo196.click('${T.deleteConfirmAction}')`)
  await delay(700)
  const stats2 = (await runProgramDirect({ op: 'pcCallStats' }) as { byMethod: Record<string, number> }).byMethod
  const trashDelta = (stats2.pcTrashAsset ?? 0) - (before2.pcTrashAsset ?? 0)
  check('[S8] 连点确认只发一次 pcTrashAsset', trashDelta === 1, { trashDelta, trashCalls: stats2.pcTrashAsset })

  mark('S8:delete-single-rpc-ok')
  // 慢响应加载态：keep-mounted 后 tab 往返不再重挂载文件库，改由会话切换
  // 驱动重挂载（key=workspace::productSpace），挂载即发列表请求 → 加载态可见。
  await runProgramDirect({ op: 'resetAssets' })
  await runProgramDirect({ op: 'setLatency', args: { ms: 900 } })
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.personal)`)
  await until(() => js<boolean>(`!window.__poo196.q('${T.tabs}')`), 8000)
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.project)`)
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 8000)
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.loading}')`), 8000)
  check('[S8] 慢响应出现加载态文案', true)
  await capture('s8-loading-state')
  await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 15000)
  await runProgramDirect({ op: 'setLatency', args: { ms: 40 } })
  await clickTab(T.tabMessages)
  await delay(150)
}

/** 平台集成: resize / 全屏 / 布局越界探针。 */
async function scenarioPlatform() {
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 10000)

  const probeOverflow = async (label: string) => {
    const overflow = await js<{ page: { scrollWidth: number; clientWidth: number }; overflowing: string[] }>('window.__poo196.overflow()')
    const pageOk = overflow.page ? overflow.page.scrollWidth <= overflow.page.clientWidth + 1 : true
    check(`[S9] ${label} 无页面级横向溢出`, pageOk, overflow.page)
    check(`[S9] ${label} 无组件级横向溢出(data-testid)`, overflow.overflowing.length === 0, { overflowing: overflow.overflowing.slice(0, 6) })
  }

  host.setSize(1200, 800)
  await delay(350)
  check('[S9] resize 1200 列表仍渲染', await js<boolean>(`window.__poo196.q('${T.list}')`))
  await probeOverflow('1200x800')
  await capture('s9-resize-1200')

  host.setSize(1600, 1000)
  await delay(350)
  await probeOverflow('1600x1000')
  await capture('s9-resize-1600')

  host.setSize(1440, 900)
  await delay(300)
  host.setFullScreen(true)
  await delay(500)
  await probeOverflow('全屏')
  await capture('s9-fullscreen')
  host.setFullScreen(false)
  await delay(400)
  const viewport = await js<[number, number]>('[window.innerWidth, window.innerHeight]')
  check('[S9] 退出全屏恢复 1440 宽', viewport[0] === 1440, viewport)
}

/** 性能: 切 tab 延迟体感 + 100 行列表滚动。 */
async function scenarioPerformance() {
  await runProgramDirect({ op: 'resetAssets' })
  await runProgramDirect({ op: 'add100Assets' })
  await clickTab(T.tabMessages)
  await delay(200)

  const t0 = Date.now()
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 15000)
  await until(async () => (await js<number>(`window.__poo196.count('${T.list} [data-testid^="pc-asset-row-"]')`)) >= 50, 15000)
  const rows50Ms = Date.now() - t0
  check('[S10] 100 资产池首屏 50 行渲染', true, { rows50Ms })

  await js<boolean>(`(() => { const el = document.querySelector('${T.loadMore}'); el?.scrollIntoView({ block: 'center' }); return true })()`)
  await js<boolean>(`window.__poo196.click('${T.loadMore}')`)
  await until(async () => (await js<number>(`window.__poo196.count('${T.list} [data-testid^="pc-asset-row-"]')`)) >= 100, 15000)
  check('[S10] 加载更多拉满 100 行', true)

  const scrollProbe = await js<boolean>(`(() => { const el = document.querySelector('${T.list}'); if (!el) return false; el.scrollTop = el.scrollHeight; return el.scrollHeight > el.clientHeight })()`)
  check('[S10] 列表容器可滚动（100 行）', scrollProbe)
  await capture('s10-list-100-rows')

  const durations: number[] = []
  for (let i = 0; i < 3; i++) {
    await clickTab(T.tabMessages)
    await delay(150)
    const start = Date.now()
    await clickTab(T.tabFiles)
    await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 10000)
    durations.push(Date.now() - start)
  }
  const median = durations.sort((a, b) => a - b)[1]
  check('[S10] 切 tab 到列表可见中位延迟 <1500ms', median < 1500, { durations, median })
  await runProgramDirect({ op: 'resetAssets' })
  await clickTab(T.tabMessages)
  await delay(150)
}

/** 视觉矩阵: 浅/深 × zh-Hans/en/de 逐表面截图 + de 长文本。 */
async function scenarioVisualMatrix() {
  const langs = ['zh-Hans', 'en', 'de'] as const
  const themes = ['light', 'dark'] as const

  for (const theme of themes) {
    for (const lang of langs) {
      await js<boolean>(`window.__poo196.setLang('${lang}')`)
      await delay(250)
      await js<boolean>(`window.__poo196.setTheme('${theme}')`)
      await delay(450)
      const effective = await js<string>('window.__poo196.theme()')
      const langNow = await js<string>('window.__poo196.lang()')
      check(`[S11] ${theme}/${langNow} 主题与语言生效`, effective === theme && langNow === lang, { effective, langNow })

      await clickTab(T.tabFiles)
      await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 10000)
      await capture(`s11-files-${theme}-${lang}`)

      await openUploadDialog()
      await capture(`s11-upload-${theme}-${lang}`)
      await pressEscape()

      await openRowMenu('as-design-home', 'download')
      await capture(`s11-rowmenu-${theme}-${lang}`)
      await pressEscape()

      await clickTab(T.tabPins)
      await until(() => js<boolean>(`window.__poo196.q('${T.pinPane}')`), 10000)
      await capture(`s11-pins-${theme}-${lang}`)

      await clickTab(T.tabMessages)
      await delay(150)
      await clickTab(T.tabFiles)
      await until(() => js<boolean>(`window.__poo196.q('${T.trashButton}')`), 10000)
      await clickTab(T.trashButton)
      await until(() => js<boolean>(`window.__poo196.q('${T.trashView}')`), 10000)
      await capture(`s11-trash-${theme}-${lang}`)
      await js<boolean>(`window.__poo196.click('[data-testid="pc-trash-back"]')`)
      await delay(250)

      await clickTab(T.tabMessages)
      await delay(250)
      await clearInput()
      await capture(`s11-messages-${theme}-${lang}`)
      await typeMentionQuery('会')
      await until(async () => (await js<number>(`window.__poo196.count('[data-testid^="pc-mention-option-"]')`)) >= 1, 10000)
      await capture(`s11-mention-${theme}-${lang}`)
      await clearInput()

      const overflow = await js<{ page: { scrollWidth: number; clientWidth: number }; overflowing: string[] }>('window.__poo196.overflow()')
      check(`[S11] ${theme}/${lang} 无横向溢出（页面级）`, overflow.page ? overflow.page.scrollWidth <= overflow.page.clientWidth + 1 : true, overflow.page)
      check(`[S11] ${theme}/${lang} 无组件级横向溢出`, overflow.overflowing.length === 0, { overflowing: overflow.overflowing.slice(0, 8) })
    }
  }

  // de 长名资产截断检查
  await js<boolean>(`window.__poo196.setLang('de')`)
  await delay(250)
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 10000)
  await js<boolean>(`(() => { const el = document.querySelector('[data-testid="pc-asset-row-${LONG_NAME_ASSET_ID}"]'); el?.scrollIntoView({ block: 'center' }); return true })()`)
  await delay(250)
  const longNameOk = await js<boolean>(`(() => {
    const row = document.querySelector('[data-testid="pc-asset-row-${LONG_NAME_ASSET_ID}"]')
    if (!row) return false
    const name = row.querySelector('span[title]')
    return !!name && name.scrollWidth <= name.clientWidth + 1 && getComputedStyle(name).textOverflow === 'ellipsis'
  })()`)
  check('[S11] de 超长文件名行内省略号截断', longNameOk)
  await capture('s11-de-long-name-row')
  await js<boolean>(`window.__poo196.setLang('zh-Hans')`)
  await js<boolean>(`window.__poo196.setTheme('light')`)
  await delay(300)
  await clickTab(T.tabMessages)
  await clearInput()
}

/** R8a 边界: 呈现 UI 文案里禁词 0 命中（surface innerText 扫描, 大小写敏感）。 */
/* ── S13: 成员面板与创建项目（POO-196 追加轮 D-B/D-C/D-D 2）──────────────
 * 真实 ChatPage 装配面：tab 行尾「成员」按钮（非第四 tab）→ 面板按 viewer
 * 角色呈现（fixture 为 manager → 名册/邀请记录/邀请步骤都在面板内）；创建
 * 项目对话框由宿主常驻挂载（App 模式），覆盖 D-B 全部七条交互契约的可观
 * 察行为：默认不勾选、显式提交才铸 key、created 与进入分离、响应丢失走
 * 恢复查询（同 key、零重发）。 */
async function scenarioMembersAndCreate() {
  await runProgramDirect({ op: 'resetPm' })
  await clickTab(T.tabMessages)
  await delay(200)

  // 注入剪贴板桩：复制动作必须经显式点击（HIG），且链接只落在内存。
  await js<boolean>(`(() => {
    window.__clipboardLog = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__clipboardLog.push(text); return true } },
    })
    return true
  })()`)

  // D-D 2: 「成员」是 tab 行尾的按钮，不是第四个 tab。
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 10000)
  check('[S13] 项目 tab 恒为三个（成员不是第四 tab）', (await js<number>(`window.__poo196.count('${T.tabs} [role="tab"]')`)) === 3)
  check('[S13] tab 行尾「成员」按钮存在', await js<boolean>(`window.__poo196.q('${T.membersButton}')`))

  // 面板：manager 形态（fixture viewer 角色）→ 名册 + 邀请记录。
  await js<boolean>(`window.__poo196.click('${T.membersButton}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersDialog}')`), 8000)
  check('[S13] 面板打开为管理形态', (await js<string>(`document.querySelector('${T.membersDialog}').getAttribute('data-viewer-role')`)) === 'manager')
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  check('[S13] 名册 3 行', (await js<number>(`window.__poo196.count('${T.membersRosterRow}')`)) === 3)
  const rosterCount = (await js<string>(`document.querySelector('${T.membersRosterCount}').textContent`)).trim()
  check('[S13] 名册计数文案', rosterCount.includes('3'), { rosterCount })
  check('[S13] 名册行只读（无行内操作按钮）', (await js<number>(`window.__poo196.count('${T.membersRosterRow} button')`)) === 0)
  check('[S13] 邀请记录呈现', (await js<number>(`window.__poo196.count('${T.membersInvitationRow}')`)) >= 1)
  check('[S13] 前往企业管理入口存在（不驱跳转）', await js<boolean>(`window.__poo196.q('${T.membersOpenManagement}')`))
  await capture('s13-members-manager-overview')

  // 邀请步骤在面板内（不叠弹层）：空目标本地拦截，不发出请求。
  await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersCompose}')`), 8000)
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  await until(async () => (await js<string>('window.__poo196.text()')).includes('请填写手机号或邮箱'), 8000)
  const inviteCallsBefore = await runProgramDirect<{ inviteCalls: unknown[] }>({ op: 'pmCallStats' })
  check('[S13] 空目标零请求', inviteCallsBefore.inviteCalls.length === 0)

  // 手机号目标 → created 结果页 → 复制链接只进内存。
  await typeInto(T.membersInviteTarget, '13800000000')
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 10000)
  check('[S13] 结果页为 created', (await js<string>(`document.querySelector('${T.membersResult}').getAttribute('data-result')`)) === 'created')
  const statsAfterInvite = await runProgramDirect<{ inviteCalls: Array<{ command: { createRequestKey: string } }> }>({ op: 'pmCallStats' })
  check('[S13] 邀请请求携带 pm-invite key', /^pm-invite-/.test(statsAfterInvite.inviteCalls[0]?.command?.createRequestKey ?? ''), { command: statsAfterInvite.inviteCalls[0]?.command })
  await js<boolean>(`window.__poo196.click('${T.membersCopyLink}')`)
  await until(async () => (await js<number>('window.__clipboardLog.length')) > 0, 8000)
  const copiedLink = await js<string>('window.__clipboardLog[0]')
  // 夹具与真实 admin 同构：链接 = 受信 origin + /invite/<HMAC 派生 token>，
  // token 由 key 派生（base64url('invite:'+key) 是夹具的派生式）。
  const expectedToken = Buffer.from(`invite:${statsAfterInvite.inviteCalls[0].command.createRequestKey}`).toString('base64url')
  check('[S13] 复制的链接与 fixture invitationUrl 一致',
    copiedLink === `https://fixture-admin.polo.invalid/invite/${expectedToken}`, { copiedLink })
  await capture('s13-invite-created-copy')

  // Esc 只关未提交的步骤/结果页，不关面板（HIG 单一任务步骤）。
  await pressEscape()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersManageSurface}')`), 8000)
  check('[S13] Esc 后回到名册且面板仍在', await js<boolean>(`window.__poo196.q('${T.membersDialog}')`))
  await pressEscape()
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.membersDialog}')`)), 8000)
  check('[S13] 概览态 Esc 关闭面板', true)

  // ── 创建项目：D-B 1/2/5/7 ──
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'ok' } })
  check('[S13] 创建入口可达（宿主共享对话框）', await js<boolean>('window.__poo196.openCreateProject()'))
  await until(() => js<boolean>(`window.__poo196.q('${T.createDialog}')`), 8000)
  check('[S13] 打开即表单态', (await js<string>(`document.querySelector('${T.createDialog}').getAttribute('data-phase')`)) === 'form')
  const checkboxChecked = await js<boolean>(`document.querySelector('${T.createResponsibility} input').checked`)
  // D-B 1: 确认框默认不勾选——不是预填，不是恢复。
  check('[S13] 责任确认默认不勾选', checkboxChecked === false)
  check('[S13] 预算事实呈现', await js<boolean>(`window.__poo196.q('${T.createBudgetFact}')`))

  await typeInto(T.createName, '华东区销售资料库')
  await typeInto(T.createOwner, '林奕')
  await typeInto(T.createPurpose, '集中管理区域销售资料')
  await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)

  // D-B 5: 显式提交时才铸 key；命令回显契约 literal 版本。
  await until(async () => (await runProgramDirect<{ createCalls: unknown[] }>({ op: 'pmCallStats' })).createCalls.length > 0, 10000)
  const createStats = await runProgramDirect<{ createCalls: Array<{ idempotencyKey: string; command: Record<string, unknown> }> }>({ op: 'pmCallStats' })
  const firstCreate = createStats.createCalls[0]
  check('[S13] key 形如 pm-create-*', /^pm-create-/.test(firstCreate.idempotencyKey ?? ''), { key: firstCreate.idempotencyKey })
  check('[S13] 命令回显责任 literal 与条款版本', firstCreate.command.paymentResponsibilityAccepted === true && firstCreate.command.paymentResponsibilityTermsVersion === 'POL-79-payment-responsibility-v1', { command: firstCreate.command })

  // D-B 7: created 与进入分离——刷新列表后受控切换；进入动作本身关闭对话框
  // （fixture 列表必然找到目标，「项目已创建」确认页只在进入失败时保留）。
  await until(async () => (await js<string>('window.__poo196.spaceSwitchLog()')).includes('ps-apollo-created'), 10000)
  check('[S13] 受控切换进入新项目空间', true)
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.createDialog}')`)), 8000)
  check('[S13] 进入动作关闭对话框（创建与进入分离）', true)

  // ── D-B 7 失败面: 刷新列表不含新空间 → 确认页保留 + 可重试，绝不重建 ──
  await js<boolean>('window.__poo196.setRefreshMissing(true)')
  check('[S13] 失败分支入口可达', await js<boolean>('window.__poo196.openCreateProject()'))
  await until(() => js<boolean>(`window.__poo196.q('${T.createDialog}')`), 8000)
  const reopenPhase = await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase') ?? 'missing'`)
  check('[S13] 失败分支重开即表单态', reopenPhase === 'form', { reopenPhase })
  await typeInto(T.createName, '北区交付资料库')
  await typeInto(T.createOwner, '林奕')
  await typeInto(T.createPurpose, '沉淀交付过程资料')
  // 重开保留上次的表单值（含已勾选的确认）——只在未勾选时点亮，避免把
  // 已确认的勾选再次点灭。
  if (!(await js<boolean>(`document.querySelector('${T.createResponsibility} input')?.checked ?? false`))) {
    await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
  }
  check('[S13] 失败分支提交前勾选生效', await js<boolean>(`document.querySelector('${T.createResponsibility} input')?.checked ?? false`))
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)
  await until(async () => (await runProgramDirect<{ createCalls: unknown[] }>({ op: 'pmCallStats' })).createCalls.length >= 2, 10000)
  await until(async () => (await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase') ?? ''`)) === 'created', 10000)
  const keptCopy = await js<string>('window.__poo196.text()')
  check('[S13] 进入失败保留「项目已创建」确认页', keptCopy.includes('项目已创建'), { sample: keptCopy.slice(0, 100) })
  await js<boolean>(`window.__poo196.click('${T.createRetryEnter}')`)
  await delay(600)
  check('[S13] 重试后仍停在确认页', (await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase') ?? ''`)) === 'created')
  const keptStats = await runProgramDirect<{ createCalls: unknown[] }>({ op: 'pmCallStats' })
  check('[S13] 进入失败零重发（仍两次创建）', keptStats.createCalls.length === 2, { total: keptStats.createCalls.length })
  await capture('s13-create-enter-failed')
  await pressEscape()
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.createDialog}')`)), 8000)
  await js<boolean>('window.__poo196.setRefreshMissing(false)')

  // ── D-B 6: 响应丢失 → 恢复查询，同 key、零重发 ──
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'lost' } })
  check('[S13] 再次打开创建入口', await js<boolean>('window.__poo196.openCreateProject()'))
  await until(() => js<boolean>(`window.__poo196.q('${T.createDialog}')`), 8000)
  await typeInto(T.createName, '南区渠道资料库')
  await typeInto(T.createOwner, '林奕')
  await typeInto(T.createPurpose, '沉淀渠道运营资料')
  if (!(await js<boolean>(`document.querySelector('${T.createResponsibility} input')?.checked ?? false`))) {
    await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
  }
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)

  await until(() => js<boolean>(`window.__poo196.q('${T.createRecovery}')`), 10000)
  let lostStats = await runProgramDirect<{ createCalls: Array<{ idempotencyKey: string }> }>({ op: 'pmCallStats' })
  check('[S13] 丢失后仅一次创建请求（零自动重发）', lostStats.createCalls.length === 3, { total: lostStats.createCalls.length })
  check('[S13] 恢复态呈现查询入口', await js<boolean>(`window.__poo196.q('${T.createQueryReceipt}')`))

  await runProgramDirect({ op: 'setPmReceiptState', args: { state: 'created' } })
  await js<boolean>(`window.__poo196.click('${T.createQueryReceipt}')`)
  await until(async () => (await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase') ?? ''`)) === 'created', 10000)
  lostStats = await runProgramDirect<{ createCalls: Array<{ idempotencyKey: string }>; receiptCalls: Array<{ createRequestKey: string }> }>({ op: 'pmCallStats' })
  check('[S13] 恢复查询复用同一 key', lostStats.receiptCalls[0]?.createRequestKey === lostStats.createCalls[2]?.idempotencyKey, {
    receiptKey: lostStats.receiptCalls[0]?.createRequestKey,
    createKey: lostStats.createCalls[2]?.idempotencyKey,
  })
  check('[S13] 查询成功仍零重发', lostStats.createCalls.length === 3)
  await capture('s13-create-recovery-query')
  await pressEscape()
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.createDialog}')`)), 8000)
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'ok' } })
}

async function scenarioR8aSurfaceScan() {
  const forbidden = [
    'OpenViking', 'Viking', '向量', 'COS', '对象存储', 'bucket', 'presign', '预签名',
    'embedding', '索引库', '全文检索', '解析上限', 'chunk', 'CHUNK',
    'token 上限', 'STORAGE', 'S3', 'OSS',
  ]
  const surfaces: Array<{ label: string; prepare: () => Promise<void>; cleanup?: () => Promise<void> }> = [
    { label: 'messages', prepare: async () => { await clickTab(T.tabMessages); await delay(250) } },
    { label: 'files', prepare: async () => { await clickTab(T.tabMessages); await delay(150); await clickTab(T.tabFiles); await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 10000) } },
    { label: 'pins', prepare: async () => { await clickTab(T.tabPins); await until(() => js<boolean>(`window.__poo196.q('${T.pinPane}')`), 10000) } },
    {
      label: 'trash',
      prepare: async () => {
        await clickTab(T.tabMessages)
        await delay(150)
        await clickTab(T.tabFiles)
        await until(() => js<boolean>(`window.__poo196.q('${T.trashButton}')`), 10000)
        await clickTab(T.trashButton)
        await until(() => js<boolean>(`window.__poo196.q('${T.trashView}')`), 10000)
      },
      // 回收站是文件 tab 内的钻入态：离开前退回列表，后续表面才能见到文件库。
      cleanup: async () => {
        await js<boolean>(`window.__poo196.click('[data-testid="pc-trash-back"]')`)
        await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 8000)
      },
    },
    {
      label: 'upload-dialog',
      prepare: async () => {
        await clickTab(T.tabMessages)
        await delay(150)
        await clickTab(T.tabFiles)
        await until(() => js<boolean>(`window.__poo196.q('${T.uploadButton}')`), 10000)
        await openUploadDialog()
      },
      cleanup: () => pressEscape(),
    },
    {
      label: 'mention',
      prepare: async () => {
        await clickTab(T.tabMessages)
        await delay(200)
        await clearInput()
        await typeMentionQuery('会')
        await until(() => js<boolean>(`window.__poo196.q('${T.mentionPopover}')`), 8000)
      },
      cleanup: () => clearInput(),
    },
  ]

  for (const lang of ['zh-Hans', 'en', 'de'] as const) {
    await js<boolean>(`window.__poo196.setLang('${lang}')`)
    await delay(250)
    for (const surface of surfaces) {
      await surface.prepare()
      const text = await js<string>('window.__poo196.text()')
      const hits = forbidden.filter((word) => text.includes(word))
      check(`[S12] ${lang}/${surface.label} 表面文案禁词 0 命中`, hits.length === 0, { hits, sample: text.slice(0, 120) })
      if (surface.cleanup) await surface.cleanup()
    }
  }
  await js<boolean>(`window.__poo196.setLang('zh-Hans')`)
  await delay(200)
  await clickTab(T.tabMessages)
  await clearInput()
}

/* ── R2 扩展（live-experience r2）：追加轮新表面 × 七轴 ──────────────────
 * 被测新表面：创建对话框全流程、成员面板 owner/manager↔member 两态、邀请
 * 输入→复制结果页、空间菜单入口、tab 行成员按钮（双装配分支）。轴：交互
 * 回路（开↔关↔再开 / 勾选往返 / 步骤返回 / 复制失败重试 / 失权清理）、
 * 视觉（浅深 × zh/en/de）、会话生命周期（切会话清理 / 重开不残留）、观测
 * 通道（全程 console 零 error 由末尾总断言覆盖）、键盘/焦点、性能。
 * 真实层差异（夹具 vs 真实）：夹具 invitationUrl 是完整 URL；真实 admin 在
 * 未配置 POLO_PUBLIC_ORIGIN 时返回相对路径——该差异只在真实层可见。 */

const pmCallCount = (method: string) => result.pcCalls.filter((call) => call.method === method).length

/** 挂闭兜底：Escape 两轮未果时点击遮罩（Radix onInteractOutside 关闭路径）。 */
const forceCloseDialog = async (selector: string) => {
  for (let round = 0; round < 5; round++) {
    if (!(await js<boolean>(`window.__poo196.q('${selector}')`))) return
    if (round < 2) {
      await pressEscape()
    } else {
      await js<boolean>(`(() => {
        const overlay = document.querySelector('[data-slot="dialog-overlay"]')
        if (!overlay) return false
        const r = overlay.getBoundingClientRect()
        const base = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 }
        overlay.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
        overlay.dispatchEvent(new MouseEvent('mousedown', base))
        return true
      })()`)
    }
    await delay(250)
  }
  await until(async () => !(await js<boolean>(`window.__poo196.q('${selector}')`)), 8000)
}

const openMembersDialog = async () => {
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 10000)
  await js<boolean>(`window.__poo196.click('${T.membersButton}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersDialog}')`), 8000)
}

const closeMembersDialog = async () => forceCloseDialog(T.membersDialog)

const openCreateDialog = async () => {
  check('创建入口可达（宿主共享对话框）', await js<boolean>('window.__poo196.openCreateProject()'))
  await until(() => js<boolean>(`window.__poo196.q('${T.createDialog}')`), 8000)
}

const closeCreateDialog = async () => forceCloseDialog(T.createDialog)

/** E2-5 相位清理：明确失败在当前实现下落入 recovery 相位且 stored key 保留
 * （definite 判定依赖错误码，跨桥恒 null）。改任一字段即弃 key，随后重开
 * 回到全新表单态——修复前后两条世界线都收敛到 form。 */
const resetCreateDialogState = async () => {
  if (!(await js<boolean>(`window.__poo196.q('${T.createDialog}')`))) {
    await openCreateDialog()
  }
  const phaseNow = await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase') ?? 'missing'`)
  if (phaseNow === 'created') {
    // 意外成功（如驱动层双击穿透）：走「进入项目」受控切换关闭对话框。
    await js<boolean>(`window.__poo196.click('${T.createRetryEnter}')`)
    await probeUntil(async () => !(await js<boolean>(`window.__poo196.q('${T.createDialog}')`)), 6000)
    await forceCloseDialog(T.createDialog)
    return
  }
  // recovery 相位下表单不可见（formVisible=false），clearAndType 找不到
  // 名称输入会静默无效——先走「返回填写」真实出口回到表单，再改字段弃 key。
  if (phaseNow === 'recovery' && await js<boolean>(`window.__poo196.q('${T.createBackToForm}')`)) {
    await js<boolean>(`window.__poo196.click('${T.createBackToForm}')`)
    await until(() => js<boolean>(`window.__poo196.q('${T.createName}')`), 8000)
  }
  await clearAndType(T.createName, '清理占位')
  await closeCreateDialog()
  await openCreateDialog()
  const phase = await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase') ?? 'missing'`)
  check('[S16] 相位清理后回到表单态（stored key 已弃）', phase === 'form', { phase })
}

const fillCreateForm = async (name: string) => {
  await clearAndType(T.createName, name)
  await clearAndType(T.createOwner, '林奕')
  await clearAndType(T.createPurpose, '沉淀体验评审过程资料')
  if (!(await js<boolean>(`document.querySelector('${T.createResponsibility} input')?.checked ?? false`))) {
    await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
  }
}

/** E2-3 复验前提：创建对话框的表单值在关闭后会被当前实现保留（见
 * FINDINGS E2-3），而 insertText 追加式输入会把残留拼进新值——凡断言
 * 字段语义的输入都先全选清空再写。 */
const clearAndType = async (selector: string, text: string) => {
  await js<boolean>(`(() => {
    const el = document.querySelector('${selector}')
    if (!el) return false
    el.focus()
    document.execCommand('selectAll')
    document.execCommand('insertText', false, '')
    document.execCommand('insertText', false, '${text.replace(/'/g, "\\'")}')
    return true
  })()`)
  await delay(80)
}

/** 点击直至探针命中（合成 click 偶发不触发表单提交/激活行为时重点一次）。 */
const clickUntil = async (selector: string, probe: () => Promise<unknown> | unknown, timeoutMs = 10000, attempts = 2) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await js<boolean>(`window.__poo196.click('${selector}')`)
    if (await probeUntil(probe, Math.max(2500, Math.floor(timeoutMs / attempts)))) return
  }
  await until(probe, timeoutMs)
}

/** 展开空间菜单的切换子菜单：生产键盘路径（Enter）优先，pointermove 与
 * 合成 click 依次兜底——Radix SubTrigger 的展开通道不止一条。 */
const openSpaceSub = async (): Promise<boolean> => {
  for (const mode of ['enter', 'pointermove', 'click']) {
    if (mode === 'enter') {
      await js<boolean>(`window.__poo196.pressEnterOn('[data-testid="product-space-switcher"]')`)
    } else if (mode === 'pointermove') {
      await js<boolean>(`(() => {
        const el = document.querySelector('[data-testid="product-space-switcher"]')
        if (!el) return false
        const r = el.getBoundingClientRect()
        const base = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }
        el.dispatchEvent(new PointerEvent('pointermove', { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
        el.dispatchEvent(new MouseEvent('mousemove', base))
        return true
      })()`)
    } else {
      await js<boolean>(`window.__poo196.click('[data-testid="product-space-switcher"]')`)
    }
    const opened = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.spaceMenuItem}')`), 2500)
    if (opened) { mark(`space-sub-open=${mode}`); return true }
    await pressEscape()
    await delay(200)
    await js<boolean>(`window.__poo196.pressEnterOn('${T.spaceMenuTrigger}')`)
    await probeUntil(() => js<boolean>(`window.__poo196.q('${T.spaceMenuContent}')`), 3000)
  }
  return false
}

const armSpaceMenu = async () => {
  await js<boolean>(`window.__poo196.pressEnterOn('${T.spaceMenuTrigger}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.spaceMenuContent}')`), 8000)
  const opened = await openSpaceSub()
  if (!opened) throw new Error('space switcher submenu never opened')
}

/** S14: 成员面板 owner/manager↔member 两态 + 403 失权清空回路。 */
async function scenarioMembersTwoState() {
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.project)`)
  await clickTab(T.tabMessages)
  await delay(200)
  check('[S14] 角色覆盖控制面可用', await js<boolean>('Boolean(window.__poo196Space)'))

  // ── member 两态：member 打开零管理读、无邀请动作 ──
  const callsBefore = { invite: pmCallCount('pmCreateProjectInvitation'), roster: pmCallCount('pmListProjectMembers'), invitations: pmCallCount('pmListProjectInvitations') }
  await js<boolean>('window.__poo196Space.setRole("member")')
  await delay(300)
  await openMembersDialog()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersMemberSurface}')`), 8000)
  check('[S14] member 形态渲染 member 表面（无管理名册）', !(await js<boolean>(`window.__poo196.q('${T.membersRoster}')`)))
  const yourRole = (await js<string>(`document.querySelector('${T.membersYourRole}')?.textContent ?? ''`)).trim()
  const memberRole = (await i18nText('projectMembers.role.member')).trim()
  check('[S14] 「你的角色」呈现成员角色词', yourRole.includes(memberRole), { yourRole, memberRole })
  check('[S14] 联系负责人说明存在', await js<boolean>(`window.__poo196.q('${T.membersContactOwner}')`))
  check('[S14] member 表面无「邀请成员」主动作', !(await js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`)))
  await delay(400)
  const callsMember = { invite: pmCallCount('pmCreateProjectInvitation'), roster: pmCallCount('pmListProjectMembers'), invitations: pmCallCount('pmListProjectInvitations') }
  check('[S14] member 打开零管理请求（名册/邀请/创建读全 0）',
    callsMember.roster === callsBefore.roster && callsMember.invitations === callsBefore.invitations && callsMember.invite === callsBefore.invite,
    { callsBefore, callsMember })
  await capture('s14-members-member-surface')
  await js<boolean>(`window.__poo196.click('${T.membersClose}')`)
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.membersDialog}')`)), 8000)
  check('[S14] member 表面关闭按钮可关闭面板', true)

  // ── 失权回路：manager 加载成功 → 403 once → 重开清空为 member 形态 ──
  mark('S14:manager-open')
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await delay(300)
  await openMembersDialog()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  check('[S14] 管理形态名册加载成功（失权前）', (await js<number>(`window.__poo196.count('${T.membersRosterRow}')`)) === 3)
  mark('S14:manager-close-attempt')
  await closeMembersDialog()
  mark('S14:manager-closed')
  await runProgramDirect({ op: 'setPmFault', args: { method: 'pmListProjectMembers', fault: { code: 'forbidden', once: true } } })
  await openMembersDialog()
  // E2-5 钉子：pm 通道在 channel-map 里 codedErrors:true（错误码只能以
  // message marker 过 context bridge），而 useProjectMembers 的 errorCodeOf
  // 只读 `.code` 属性——跨桥后恒为 null，forbidden 永远落到 generic 文案，
  // 失权清空面（member 形态 + lostAccess）在真实链路上不会出现。修复前
  // 本检查保持红（同 FINDINGS E2-5）。
  const lostSurface = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.membersMemberSurface}')`), 6000)
  // 修复后 403 走 applyForbidden：名册清空（无 roster-error 行），失权文案
  // 落在 member 面的 manage-error（lostAccess），而非 generic。
  const manageErrorText = (await js<string>(`document.querySelector('${T.membersManageError}')?.textContent ?? ''`)).trim()
  const lostAccessCopy = (await i18nText('projectMembers.error.lostAccess')).trim()
  const dialogRole403 = await js<string>(`document.querySelector('${T.membersDialog}')?.getAttribute('data-viewer-role') ?? 'closed'`)
  check('[S14][E2-5钉子] 403 后面板清空为 member 形态（失权即清数据）', lostSurface, { dialogRole403 })
  check('[S14][E2-5观察] 403 后呈现失权文案（lostAccess，非 generic）',
    manageErrorText.length > 0 && manageErrorText.includes(lostAccessCopy.slice(0, 10)),
    { manageErrorText: manageErrorText.slice(0, 60) })
  await capture('s14-members-403-face')
  await closeMembersDialog()

  // 空间上下文刷新（真实 App 的 refreshProductSpaces 路径）后名册为新鲜数据
  // （无论失权面是否出现，数据卫生断言都成立：重开读新、不回退旧缓存）。
  mark('S14:context-refresh')
  await js<boolean>('window.__poo196Space.setRole("member")')
  await delay(250)
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await delay(250)
  await openMembersDialog()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  check('[S14] 空间上下文刷新后名册为新鲜读取（3 行）', (await js<number>(`window.__poo196.count('${T.membersRosterRow}')`)) === 3)
  await closeMembersDialog()
  await forceCloseDialog(T.membersDialog)
}

/** S15: 邀请回路扩展——本地拦截/步骤返回/码化失败/传输失败重试/复制失败
 * 重试/结果页异态（existing/state_changed/credential_unrecoverable 无链接）。 */
async function scenarioInviteLoops() {
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await clickTab(T.tabMessages)
  await delay(200)
  await js<boolean>(`(() => {
    window.__clipboardLog = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__clipboardLog.push(text); return true } },
    })
    return true
  })()`)
  await openMembersDialog()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)

  // 非法目标：本地拦截 + 字段错误 + 零请求
  mark('S15:compose-open')
  const inviteMark0 = pmCallCount('pmCreateProjectInvitation')
  await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersCompose}')`), 8000)
  await typeInto(T.membersInviteTarget, 'abc')
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  const targetInvalid = (await i18nText('projectMembers.invite.targetInvalid')).trim()
  await until(async () => (await js<string>('window.__poo196.text()')).includes(targetInvalid), 8000)
  check('[S15] 非法目标呈现字段级错误且保留输入步', await js<boolean>(`window.__poo196.q('${T.membersCompose}')`))
  check('[S15] 非法目标零请求', pmCallCount('pmCreateProjectInvitation') - inviteMark0 === 0)

  // 步骤返回按钮：compose → 名册（面板不关），重开输入已清空
  await js<boolean>(`window.__poo196.click('${T.membersComposeBack}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersManageSurface}')`), 8000)
  check('[S15] 返回按钮回到名册且面板仍在', await js<boolean>(`window.__poo196.q('${T.membersDialog}')`))
  await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersCompose}')`), 8000)
  const targetAfterBack = await js<string>(`document.querySelector('${T.membersInviteTarget}').value`)
  check('[S15] 重开输入步已清空（无残留目标）', targetAfterBack === '', { targetAfterBack })

  // 码化失败（已是成员）→ 映射文案 + 停留输入步
  mark('S15:already-member-arm')
  await runProgramDirect({ op: 'setPmFault', args: { method: 'pmCreateProjectInvitation', fault: { code: 'target_already_member', once: true } } })
  await clearAndType(T.membersInviteTarget, '13900000000')
  const typedTarget = await js<string>(`document.querySelector('${T.membersInviteTarget}').value`)
  mark(`S15:target-typed=${typedTarget}`)
  const alreadyMember = (await i18nText('projectMembers.invite.alreadyMember')).trim()
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  // E2-5 钉子：target_already_member 跨桥退化为 null → generic「邀请创建失败」，
  // 映射文案（对方已是本项目成员，无需邀请）在真实链路不会出现。修复前红。
  const alreadyShown = await probeUntil(async () => (await js<string>('window.__poo196.text()')).includes(alreadyMember), 6000)
  const genericFailedShown = await probeUntil(async () => (await js<string>('window.__poo196.text()')).includes((await i18nText('projectMembers.invite.failed')).trim()), 3000)
  check('[S15][E2-5钉子] 已是成员拒绝为映射文案且停留在输入步', alreadyShown, { alreadyShown, genericFailedShown })
  await capture('s15-invite-already-member')

  // 传输级失败（无码）→ 兜底失败文案；随后原输入重试至 created 结果页。
  // 全程有界探测（结果页偶发点击穿透是驱动层噪声，不在这里中止场景）。
  mark('S15:transport-fail-arm')
  await runProgramDirect({ op: 'setPmFault', args: { method: 'pmCreateProjectInvitation', fault: { code: 'plain', once: true, message: 'fixture transport dropped mid-request' } } })
  const inviteFailed = (await i18nText('projectMembers.invite.failed')).trim()
  for (let attempt = 0; attempt < 2; attempt++) {
    await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
    if (await probeUntil(async () => (await js<string>('window.__poo196.text()')).includes(inviteFailed) || (await js<boolean>(`window.__poo196.q('${T.membersResult}')`)), 6000)) break
  }
  const transportStep = await js<string>(`document.querySelector('${T.membersDialog}')?.getAttribute('data-step') ?? 'missing'`)
  const transportText = await js<string>('window.__poo196.text()')
  check('[S15] 传输级失败呈现失败文案（非静默，或有界退化为直接到达结果页）', transportText.includes(inviteFailed) || transportStep === 'result', { transportStep, sample: transportText.slice(-120) })
  await capture('s15-invite-transport-failed')
  const resultReady = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 8000)
  const resultKindRetry = await js<string>(`document.querySelector('${T.membersResult}')?.getAttribute('data-result') ?? 'missing'`)
  check('[S15] 重试创建成功进入结果页', resultReady && resultKindRetry === 'created', { resultReady, resultKindRetry })

  // 复制失败 → 明确报错 + 零剪贴板写入 → 重试成功（有界；S19 已从另一路径
  // 反复验证复制成功回路，这里若点击穿透只记观察不中止）。
  const copyBtnReady = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.membersCopyLink}')`), 6000)
  await js<boolean>(`(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('clipboard denied') } },
    })
    return true
  })()`)
  for (let attempt = 0; attempt < 2 && !(await js<boolean>(`window.__poo196.q('${T.membersCopyFailed}')`)); attempt++) {
    await js<boolean>(`window.__poo196.click('${T.membersCopyLink}')`)
    await probeUntil(() => js<boolean>(`window.__poo196.q('${T.membersCopyFailed}')`), 4000)
  }
  const copyFailedText = (await i18nText('projectMembers.invite.copyFailed')).trim()
  const copyFailedShown = (await js<string>(`document.querySelector('${T.membersCopyFailed}')?.textContent ?? ''`)).trim()
  const copyProbe = await js<string>(`(() => {
    const btn = document.querySelector('${T.membersCopyLink}')
    const result = document.querySelector('${T.membersResult}')
    return JSON.stringify({
      resultStep: result?.getAttribute('data-result') ?? 'missing',
      hasUrlView: Boolean(result?.querySelector('${T.membersCopyLink}')),
      btnText: (btn?.textContent ?? '').trim(),
      clipLen: (window.__clipboardLog ?? []).length,
      clip0: (window.__clipboardLog ?? [])[0]?.slice(0, 40) ?? null,
      writeTextIsThrower: String(navigator.clipboard?.writeText).includes('throw'),
    })
  })()`)
  check('[S15] 复制失败明确报错（映射文案）', copyBtnReady && copyFailedShown.includes(copyFailedText), { copyBtnReady, copyFailedShown, copyFailedText, copyProbe })
  check('[S15] 复制失败零剪贴板写入', copyFailedShown.includes(copyFailedText) && (await js<number>('window.__clipboardLog.length')) === 0)
  await capture('s15-copy-failed')
  await js<boolean>(`(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__clipboardLog.push(text); return true } },
    })
    return true
  })()`)
  for (let attempt = 0; attempt < 2 && (await js<number>('window.__clipboardLog.length')) === 0; attempt++) {
    await js<boolean>(`window.__poo196.click('${T.membersCopyLink}')`)
    await probeUntil(async () => (await js<number>('window.__clipboardLog.length')) > 0, 4000)
  }
  const clipNow = await js<number>('window.__clipboardLog.length')
  const copiedText = (await js<string>(`document.querySelector('${T.membersCopyLink}')?.textContent ?? ''`)).trim()
  const copiedLabel = (await i18nText('projectMembers.invite.copied')).trim()
  check('[S15] 复制重试成功（剪贴板落链接/按钮进入已复制态）', clipNow > 0 && copiedText.includes(copiedLabel), { clipNow, copiedText, copiedLabel, copyFailedStillShown: copyFailedShown })
  await closeMembersDialog()
  await forceCloseDialog(T.membersDialog)

  // 结果页异态：三种非凭证结果均无复制按钮（不泄露/不虚构链接），且都有
  // 「前往企业管理」的受控出口（X2-13）。
  for (const script of ['existing', 'state_changed', 'credential_unrecoverable'] as const) {
    await runProgramDirect({ op: 'setPmInviteScript', args: { script } })
    await openMembersDialog()
    await until(() => js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`), 8000)
    await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
    await until(() => js<boolean>(`window.__poo196.q('${T.membersCompose}')`), 8000)
    await clearAndType(T.membersInviteTarget, '13700000000')
    await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
    await probeUntil(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 8000)
    const resultKind = await js<string>(`document.querySelector('${T.membersResult}')?.getAttribute('data-result') ?? 'missing'`)
    check(`[S15] 异态结果页 ${script} 呈现且无复制入口`, resultKind === script && !(await js<boolean>(`window.__poo196.q('${T.membersCopyLink}')`)), { resultKind })
    check(`[S15][X2-13] 异态结果页 ${script} 保留企业管理出口`, await js<boolean>(`window.__poo196.q('${T.membersResultManagement}')`))
    await js<boolean>(`window.__poo196.click('${T.membersResultBack}')`)
    await until(() => js<boolean>(`window.__poo196.q('${T.membersManageSurface}')`), 8000)
    await closeMembersDialog()
  }
  await runProgramDirect({ op: 'setPmInviteScript', args: { script: 'ok' } })
  await forceCloseDialog(T.membersDialog)

  // S2-ENG-3（共识 #6）：响应丢失（聚合已落库、响应消失）→ 显式重试 →
  // 同一请求键 replay 带回同一链接；复制落受信 origin 的绝对 https（E2-2）。
  mark('S15:invite-replay-loop')
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await openMembersDialog()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersCompose}')`), 8000)
  await clearAndType(T.membersInviteTarget, '13600000000')
  await runProgramDirect({ op: 'setPmInviteScript', args: { script: 'lost' } })
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  const inviteFailedCopy = (await i18nText('projectMembers.invite.failed')).trim()
  await until(async () => (await js<string>('window.__poo196.text()')).includes(inviteFailedCopy), 8000)
  const keysAfterLoss = ((await runProgramDirect<{ inviteCalls: Array<{ command?: { createRequestKey?: string } }> }>({ op: 'pmCallStats' })).inviteCalls
    .map(call => call.command?.createRequestKey))
  const heldKey = keysAfterLoss[keysAfterLoss.length - 1]
  check('[S15][S2-ENG-3] 响应丢失停留输入步并给出失败文案（非静默）', await js<boolean>(`window.__poo196.q('${T.membersCompose}')`), { heldKey })
  await capture('s15-invite-response-lost')
  await runProgramDirect({ op: 'setPmInviteScript', args: { script: 'ok' } })
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 8000)
  const replayKind = await js<string>(`document.querySelector('${T.membersResult}')?.getAttribute('data-result') ?? 'missing'`)
  const keysAfterReplay = ((await runProgramDirect<{ inviteCalls: Array<{ command?: { createRequestKey?: string } }> }>({ op: 'pmCallStats' })).inviteCalls
    .map(call => call.command?.createRequestKey))
  const replayKey = keysAfterReplay[keysAfterReplay.length - 1]
  check('[S15][S2-ENG-3] 显式重试复用同一请求键并到达 replayed 结果页', replayKind === 'replayed' && replayKey === heldKey, { replayKind, heldKey, replayKey })
  await capture('s15-invite-replayed')
  await js<boolean>(`(() => {
    window.__clipboardLog = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__clipboardLog.push(text); return true } },
    })
    return true
  })()`)
  await js<boolean>(`window.__poo196.click('${T.membersCopyLink}')`)
  await until(async () => (await js<number>('window.__clipboardLog.length')) > 0, 8000)
  const replayClip = await js<string>('window.__clipboardLog[0] ?? ""')
  check('[S15][E2-2] replay 链接复制为受信 origin 的绝对 https（非裸路径）',
    replayClip.startsWith('https://fixture-admin.polo.invalid/invite/') && !replayClip.startsWith('/'),
    { replayClip: replayClip.slice(0, 60) })
  await closeMembersDialog()
  await forceCloseDialog(T.membersDialog)
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await delay(200)

  // X2-9（共识 #14）：emailDeliveryAvailable=false 的部署——输入步直接按
  // 手机号引导（placeholder 变化），邮箱目标在本地被拒且零请求。
  mark('S15:email-capability-gate')
  await runProgramDirect({ op: 'setPmEmailDelivery', args: { available: false } })
  await openMembersDialog()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersCompose}')`), 8000)
  const placeholderNow = await js<string>(`document.querySelector('${T.membersInviteTarget}')?.getAttribute('placeholder') ?? ''`)
  const phonePlaceholder = (await i18nText('projectMembers.invite.targetPlaceholderPhone')).trim()
  check('[S15][X2-9] 无邮件能力时输入位引导手机号', placeholderNow.includes(phonePlaceholder.slice(0, 8)), { placeholderNow, phonePlaceholder })
  const emailGateMark = pmCallCount('pmCreateProjectInvitation')
  await clearAndType(T.membersInviteTarget, 'someone@example.com')
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  const emailUnavailableCopy = (await i18nText('projectMembers.invite.emailUnavailable')).trim()
  const emailGateShown = await probeUntil(async () => (await js<string>('window.__poo196.text()')).includes(emailUnavailableCopy), 6000)
  check('[S15][X2-9] 邮箱目标本地被拒（映射文案、零请求）',
    emailGateShown && pmCallCount('pmCreateProjectInvitation') - emailGateMark === 0, { emailGateShown })
  await runProgramDirect({ op: 'setPmEmailDelivery', args: { available: true } })
  await closeMembersDialog()
  await forceCloseDialog(T.membersDialog)
  await delay(150)

  // X2-7（共识 #12）：名册首屏失败 → 行内 ghost 重试 → 成功恢复名册。
  mark('S15:roster-retry')
  await openMembersDialog()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  await closeMembersDialog()
  await runProgramDirect({ op: 'setPmFault', args: { method: 'pmListProjectMembers', fault: { code: 'pm_service_unavailable', once: false } } })
  await openMembersDialog()
  const rosterErrorShown = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.membersRosterError}')`), 8000)
  check('[S15][X2-7] 名册失败呈现错误行', rosterErrorShown)
  await runProgramDirect({ op: 'setPmFault', args: { method: 'pmListProjectMembers' } })
  if (rosterErrorShown && await js<boolean>(`window.__poo196.q('${T.membersRosterRetry}')`)) {
    await js<boolean>(`window.__poo196.click('${T.membersRosterRetry}')`)
    await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  }
  check('[S15][X2-7] 行内重试恢复名册（无行刷新不静默）', await js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`))
  await capture('s15-roster-retry')
  await closeMembersDialog()
  await forceCloseDialog(T.membersDialog)
}

/** S16: 创建对话框回路扩展——焦点、空表单校验、勾选往返、提交门槛、
 * 手机验证/已有企业/版本不匹配三类引导面。 */
async function scenarioCreateLoops() {
  await runProgramDirect({ op: 'resetPm' })
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'ok' } })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  // 防御性清场：前序场景任何中止都可能遗留打开的成员面板（模态叠加会
  // 破坏本场景全部点击/焦点断言）。
  await forceCloseDialog(T.membersDialog)
  await clickTab(T.tabMessages)
  await clearInput()
  await delay(200)

  await openCreateDialog()
  // E2-3：当前实现关闭后保留表单值（S13 残留会流入本场景），先清空三字段
  // 再做空表单断言。clearAndType 会 focus 元素，名称放最后让键盘轴落点
  // 落在名称输入上。
  await clearAndType(T.createOwner, '')
  await clearAndType(T.createPurpose, '')
  await clearAndType(T.createName, '')
  const focusOnName = await js<boolean>(`document.activeElement === document.querySelector('${T.createName}')`)
  check('[S16] 打开对话框焦点落在名称输入（键盘轴）', focusOnName)

  // 空表单提交：字段级错误 + 零请求
  mark('S16:empty-submit')
  const createMark0 = pmCallCount('pmCreateEnterprise')
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)
  const nameRequired = (await i18nText('createProject.error.nameRequired')).trim()
  const confirmRequired = (await i18nText('createProject.confirmRequired')).trim()
  await until(async () => (await js<string>('window.__poo196.text()')).includes(nameRequired), 8000)
  const emptyText = await js<string>('window.__poo196.text()')
  check('[S16] 空表单提交呈现字段级错误（名称/责任）', emptyText.includes(nameRequired) && emptyText.includes(confirmRequired))
  check('[S16] 空表单提交零创建请求', pmCallCount('pmCreateEnterprise') - createMark0 === 0)
  await capture('s16-create-field-errors')

  // 勾选往返 + 提交门槛：勾→取消→表单提交被责任校验拦截
  mark('S16:responsibility-roundtrip')
  await clearAndType(T.createName, '键盘回路项目')
  await clearAndType(T.createOwner, '林奕')
  await clearAndType(T.createPurpose, '验证键盘提交门槛')
  await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
  const checkedOnce = await js<boolean>(`document.querySelector('${T.createResponsibility} input').checked`)
  await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
  const uncheckedAgain = await js<boolean>(`!document.querySelector('${T.createResponsibility} input').checked`)
  check('[S16] 责任勾选往返（勾→取消）', checkedOnce && uncheckedAgain)
  await js<boolean>(`(() => {
    const f = document.querySelector('#create-project-form')
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    return true
  })()`)
  const gateHit = await probeUntil(async () => (await js<string>('window.__poo196.text()')).includes(confirmRequired), 8000)
  const roundtripPhase = await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase') ?? 'missing'`)
  check('[S16] Enter/表单提交被未勾选责任拦截（零请求）', gateHit && pmCallCount('pmCreateEnterprise') - createMark0 === 0, { gateHit, roundtripPhase, checkedOnce, uncheckedAgain })
  await capture('s16-create-responsibility-gate')
  await closeCreateDialog()
  check('[S16] Esc 关闭未提交步骤', true)
  if (roundtripPhase === 'created') {
    // 驱动竞态兜底（勾选状态未按预期收敛导致真实提交）：恢复干净基态。
    await openCreateDialog()
    await resetCreateDialogState()
  }

  // 重开后的表单状态（E2-3，共识 r2 最小）：同意永不跨开合继承——责任勾选
  // 回到默认不勾选；文字草稿按共识保留（产品裁决留待后续，不视为残留缺陷）。
  mark('S16:reopen-consent-reset')
  await openCreateDialog()
  const nameAfterReopen = await js<string>(`document.querySelector('${T.createName}').value`)
  const respAfterReopen = await js<boolean>(`document.querySelector('${T.createResponsibility} input').checked`)
  check('[S16][E2-3] 重开责任勾选默认不勾选（同意不继承，D-B 1）', !respAfterReopen, { respAfterReopen })
  check('[S16][E2-3] 重开保留文字草稿（共识最小：只清同意，不清文字）', nameAfterReopen === '键盘回路项目', { nameAfterReopen })

  // D-B 6 回路（E2-3 配套）：unknown 查询不销毁存储的 key——显式原样重提
  // 复用同一 Idempotency-Key（不重建第二条聚合）。
  mark('S16:stored-key-resubmit')
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'lost' } })
  await runProgramDirect({ op: 'setPmReceiptState', args: { state: 'unknown' } })
  await clearAndType(T.createName, '同键重提项目')
  await clearAndType(T.createOwner, '林奕')
  await clearAndType(T.createPurpose, '验证同键重提')
  await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
  const storedMark0 = pmCallCount('pmCreateEnterprise')
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.createRecovery}')`), 8000)
  check('[S16][E2-6] 传输级失败进入恢复相位', await js<boolean>(`window.__poo196.q('${T.createRecovery}')`))
  const recoveryKeys = (await runProgramDirect<{ createCalls: Array<{ idempotencyKey?: string }> }>({ op: 'pmCallStats' })).createCalls.map(call => call.idempotencyKey)
  const storedKey = recoveryKeys[recoveryKeys.length - 1]
  // 回到表单（真实出口）——存储横幅在 form 相位渲染，横幅出现即证明 key
  // 被保留；原样重提 → 同一 key 第二次入站。
  await js<boolean>(`window.__poo196.click('${T.createBackToForm}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.createStoredRequest}')`), 8000)
  const checkedAfterBack = await js<boolean>(`document.querySelector('${T.createResponsibility} input').checked`)
  check('[S16][E2-6] 返回表单后同意保持已勾选（快照未受 reset 影响）', checkedAfterBack, { checkedAfterBack })
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)
  await until(async () => pmCallCount('pmCreateEnterprise') - storedMark0 >= 2, 8000)
  const resubmitKeys = (await runProgramDirect<{ createCalls: Array<{ idempotencyKey?: string }> }>({ op: 'pmCallStats' })).createCalls.map(call => call.idempotencyKey)
  check('[S16][E2-6] 原样重提复用同一 Idempotency-Key（不换 key 不静默重发）',
    resubmitKeys.length >= 2 && resubmitKeys[resubmitKeys.length - 1] === storedKey,
    { storedKey, lastKey: resubmitKeys[resubmitKeys.length - 1] })
  // unknown 查询出口：查询后 notFound 文案与实际出口一致（不再承诺「重新填写」）。
  await closeCreateDialog()
  await openCreateDialog()
  await until(() => js<boolean>(`window.__poo196.q('${T.createRecovery}')`), 8000)
  await js<boolean>(`window.__poo196.click('${T.createQueryReceipt}')`)
  const notFoundCopy = (await i18nText('createProject.recovery.notFound')).trim()
  const notFoundShown = await probeUntil(async () => (await js<string>('window.__poo196.text()')).includes(notFoundCopy), 6000)
  const backToFormLabel = (await i18nText('createProject.recovery.backToForm')).trim()
  check('[S16][X2-6] unknown 后恢复面板给出与出口一致的文案（含返回填写入口）',
    notFoundShown && (await js<string>('window.__poo196.text()')).includes(backToFormLabel),
    { notFoundShown })
  await closeCreateDialog()
  await resetCreateDialogState()
  await runProgramDirect({ op: 'setPmReceiptState', args: { state: 'created' } })

  // 手机未验证 → 验证引导面（D-B 3）。E2-5 钉子：phone_verification_required
  // 跨桥退化为 null → recovery 相位 + generic 文案，引导面在真实链路不出现。
  mark('S16:phone-gate')
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'code:phone_verification_required' } })
  await fillCreateForm('手机验证引导项目')
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)
  const phoneGuidanceShown = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.createPhoneVerification}')`), 6000)
  const phaseAfterPhone = await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase') ?? 'missing'`)
  check('[S16][E2-5钉子] 手机未验证呈现验证引导面（D-B 3）', phoneGuidanceShown, { phaseAfterPhone })
  check('[S16][E2-5钉子] 引导面带「验证手机号」动作', phoneGuidanceShown && await js<boolean>(`window.__poo196.q('${T.createVerifyPhone}')`))
  await capture('s16-create-phone-gate')
  if (phoneGuidanceShown) {
    await js<boolean>(`window.__poo196.click('${T.createVerifyPhone}')`)
    await until(async () => !(await js<boolean>(`window.__poo196.q('${T.createDialog}')`)), 8000)
    check('[S16] 验证动作移交宿主（夹具关闭对话框）', true)
  } else {
    await resetCreateDialogState()
  }

  // 已有企业 → 「进入现有项目」引导（D-B 4；夹具现有企业即当前活跃空间，
  // 动作为受控切换语义——已是活跃空间时无需切换，仅关闭对话框）。E2-5 钉子。
  mark('S16:enterprise-exists-gate')
  // D-B 3 的验证动作会关闭对话框——本段自己保证表单在场。
  if (!(await js<boolean>(`window.__poo196.q('${T.createName}')`))) {
    await openCreateDialog()
    await until(() => js<boolean>(`window.__poo196.q('${T.createName}')`), 8000)
  }
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'code:account_enterprise_exists' } })
  await fillCreateForm('已有企业拒绝项目')
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)
  const existsGuidanceShown = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.createEnterpriseExists}')`), 6000)
  const phaseAfterExists = await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase') ?? 'missing'`)
  check('[S16][E2-5钉子] 已有企业拒绝呈现「进入现有项目」引导（D-B 4）', existsGuidanceShown, { phaseAfterExists })
  await capture('s16-create-enterprise-exists')
  if (existsGuidanceShown) {
    await js<boolean>(`window.__poo196.click('${T.createEnterExisting}')`)
    await until(async () => !(await js<boolean>(`window.__poo196.q('${T.createDialog}')`)), 8000)
    check('[S16] 进入现有项目动作关闭对话框（受控切换语义）', true)
  } else {
    await resetCreateDialogState()
  }

  // 版本不匹配 → 提示 + 责任勾选强制清零（D-B 2，重新确认而非静默替换）。
  // E2-5 钉子：validation_error 跨桥退化 → 不触发 versionMismatch 分支。
  mark('S16:version-mismatch-gate')
  // D-B 4 的「进入现有项目」动作会关闭对话框——本段自己保证表单在场。
  if (!(await js<boolean>(`window.__poo196.q('${T.createName}')`))) {
    await openCreateDialog()
    await until(() => js<boolean>(`window.__poo196.q('${T.createName}')`), 8000)
  }
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'code:validation_error' } })
  await fillCreateForm('版本不匹配项目')
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)
  const mismatchShown = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.createVersionMismatch}')`), 6000)
  const phaseAfterMismatch = await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase') ?? 'missing'`)
  const respAfterMismatch = await js<boolean>(`document.querySelector('${T.createResponsibility} input')?.checked ?? false`)
  check('[S16][E2-5钉子] 版本不匹配提示出现（D-B 2）', mismatchShown, { phaseAfterMismatch })
  check('[S16][E2-5钉子] 版本不匹配后责任勾选被清零（要求重新确认）', mismatchShown && !respAfterMismatch, { respAfterMismatch, phaseAfterMismatch })
  await capture('s16-create-version-mismatch')
  await closeCreateDialog()
  await resetCreateDialogState()
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'ok' } })
  await delay(200)
}

/** S17: 空间菜单入口（生产 ProductSpaceSwitcher）——创建/刷新入口可达、
 * 打开共享对话框、仅个人空间仍可达（D-D 1）。 */
async function scenarioSpaceMenuEntry() {
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await clickTab(T.tabMessages)
  await delay(200)

  await armSpaceMenu()
  const items = await js<Array<{ name: string }>>(`Array.from(document.querySelectorAll('${T.spaceMenuItem}')).map(el => ({ name: el.getAttribute('data-space-name') }))`)
  check('[S17] 切换子菜单列出企业+个人两个空间', items.length === 2, { items })
  check('[S17] 菜单尾「创建项目…」入口存在', await js<boolean>(`window.__poo196.q('${T.spaceMenuCreate}')`))
  check('[S17] 菜单尾「刷新项目」入口存在', await js<boolean>(`window.__poo196.q('${T.spaceMenuRefresh}')`))
  await capture('s17-space-menu-open')

  // 创建入口 → 同一共享对话框（与 tab 行成员/选择页共用）
  const menuLogBefore = (await js<string[]>('window.__poo196.spaceMenuLog()')).length
  await js<boolean>(`window.__poo196.pressEnterOn('${T.spaceMenuCreate}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.createDialog}')`), 8000)
  check('[S17] 菜单「创建项目…」打开共享创建对话框', true)
  const menuLogAfter = await js<string[]>('window.__poo196.spaceMenuLog()')
  check('[S17] 入口经同一 onOpenCreateProject 通道', menuLogAfter.length === menuLogBefore + 1 && menuLogAfter.includes('open-create'), { menuLogAfter })
  await closeCreateDialog()

  // 刷新入口触发在线刷新
  const refreshBefore = (await js<number[]>('window.__poo196.spaceRefreshLog()')).length
  await armSpaceMenu()
  await js<boolean>(`window.__poo196.pressEnterOn('${T.spaceMenuRefresh}')`)
  await until(async () => (await js<number[]>('window.__poo196.spaceRefreshLog()')).length > refreshBefore, 8000)
  check('[S17] 菜单「刷新项目」触发在线刷新', true)
  await pressEscape()
  await delay(200)

  // 仅个人空间：创建入口仍可达（不能等待多空间选择页出现）
  await js<boolean>('window.__poo196Space.setPersonalOnly(true)')
  await delay(300)
  await armSpaceMenu()
  const personalItems = await js<number>(`window.__poo196.count('${T.spaceMenuItem}')`)
  check('[S17] 仅个人空间列表仍呈现「创建项目…」入口', personalItems === 1 && await js<boolean>(`window.__poo196.q('${T.spaceMenuCreate}')`), { personalItems })
  await capture('s17-space-menu-personal-only')
  await js<boolean>(`window.__poo196.pressEnterOn('${T.spaceMenuCreate}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.createDialog}')`), 8000)
  check('[S17] 仅个人空间创建入口同样打开对话框', true)
  await closeCreateDialog()
  await js<boolean>('window.__poo196Space.setPersonalOnly(false)')
  await delay(250)
}

/** S18: 第二装配分支（空消息项目会话）+ 会话切换清理 + 创建对话框重开
 * 不残留。 */
async function scenarioBranchesAndLifecycle() {
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.projectEmpty)`)
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 10000)
  check('[S18] 空消息项目会话仍渲染三 tab（第二装配分支）', (await js<number>(`window.__poo196.count('${T.tabs} [role="tab"]')`)) === 3)
  check('[S18] 第二分支同样有「成员」按钮', await js<boolean>(`window.__poo196.q('${T.membersButton}')`))
  await openMembersDialog()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  check('[S18] 第二分支成员面板打开管理形态', (await js<string>(`document.querySelector('${T.membersDialog}').getAttribute('data-viewer-role')`)) === 'manager')
  await capture('s18-empty-session-members')

  // 切会话清理：面板打开时切走 → 面板消失且非项目会话零入口
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.personal)`)
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.membersDialog}')`)), 8000)
  check('[S18] 切会话后成员面板随之关闭', true)
  check('[S18] 非项目会话零成员按钮残留', !(await js<boolean>(`window.__poo196.q('${T.membersButton}')`)))
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.projectEmpty)`)
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 8000)
  await delay(300)
  // E2-4 钉子：ChatPage 未按会话重挂载（MainContentPanel 不设 key），
  // projectMembersOpen 存活于会话切换——切走时分支卸载隐藏面板，切回时
  // 面板自发重现。projectTab 有会话切换重置（S8），membersOpen 没有。
  const reopenVisible = await js<boolean>(`window.__poo196.q('${T.membersDialog}')`)
  const reopenStep = await js<string>(`document.querySelector('${T.membersDialog}')?.getAttribute('data-step') ?? 'closed'`)
  check('[S18][E2-4钉子] 切回后面板不自动恢复（无陈旧打开态）', !reopenVisible, { reopenVisible, reopenStep })
  if (reopenVisible) {
    await capture('s18-members-reopened-after-switch')
    await closeMembersDialog()
    await js<boolean>('window.__poo196Space.setRole("manager")')
    await delay(250)
  }

  // 创建对话框生命周期（E2-3，共识 r2 最小）：关闭重开不带出旧同意——责任
  // 勾选回到默认；文字草稿按共识保留。
  mark('S18:create-consent-reset-probe')
  // 前序场景若中止会留下 stored key（重开即 recovery 相位），先清场到全新
  // 表单，本段的断言才作用于表单本身。
  await resetCreateDialogState()
  await openCreateDialog()
  await until(() => js<boolean>(`window.__poo196.q('${T.createName}')`), 8000)
  await clearAndType(T.createName, '生命周期残留探针')
  await clearAndType(T.createOwner, '林奕')
  await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
  await closeCreateDialog()
  await openCreateDialog()
  await until(() => js<boolean>(`window.__poo196.q('${T.createName}')`), 8000)
  const nameResidue = await js<string>(`document.querySelector('${T.createName}')?.value ?? ''`)
  const respResidue = await js<boolean>(`document.querySelector('${T.createResponsibility} input')?.checked ?? false`)
  check('[S18][E2-3] 关闭重开责任勾选回到默认（同意不继承）', !respResidue, { respResidue })
  check('[S18][E2-3] 关闭重开保留文字草稿（共识最小：只清同意，不清文字）', nameResidue === '生命周期残留探针', { nameResidue })
  await closeCreateDialog()

  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.project)`)
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 8000)
  await clickTab(T.tabMessages)
  await delay(150)
}

/** S19: 视觉矩阵扩展——成员面板四态 + 创建对话框 × 浅深主题 × zh/en/de。 */
async function scenarioVisualMembersCreate() {
  const langs = ['zh-Hans', 'en', 'de'] as const
  const themes = ['light', 'dark'] as const
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await clickTab(T.tabMessages)
  await clearInput()
  await delay(200)

  for (const theme of themes) {
    for (const lang of langs) {
      await js<boolean>(`window.__poo196.setLang('${lang}')`)
      await delay(250)
      await js<boolean>(`window.__poo196.setTheme('${theme}')`)
      await delay(450)

      // manager 名册+邀请记录面
      await openMembersDialog()
      await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
      await capture(`s19-members-overview-${theme}-${lang}`)

      // 输入步 → 结果页（复制态）
      await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
      await until(() => js<boolean>(`window.__poo196.q('${T.membersCompose}')`), 8000)
      await typeInto(T.membersInviteTarget, '13600001234')
      await capture(`s19-members-compose-${theme}-${lang}`)
      await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
      await until(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 10000)
      await js<boolean>(`window.__poo196.click('${T.membersCopyLink}')`)
      await delay(350)
      await capture(`s19-members-result-${theme}-${lang}`)
      await closeMembersDialog()

      // member 表面
      await js<boolean>('window.__poo196Space.setRole("member")')
      await delay(300)
      await openMembersDialog()
      await until(() => js<boolean>(`window.__poo196.q('${T.membersMemberSurface}')`), 8000)
      await capture(`s19-members-member-${theme}-${lang}`)
      await closeMembersDialog()
      await js<boolean>('window.__poo196Space.setRole("manager")')
      await delay(300)

      // 创建对话框表单面
      await openCreateDialog()
      await clearAndType(T.createName, '视觉矩阵项目名称示例')
      await capture(`s19-create-form-${theme}-${lang}`)
      await closeCreateDialog()

      const overflow = await js<{ page: { scrollWidth: number; clientWidth: number }; overflowing: string[] }>('window.__poo196.overflow()')
      check(`[S19] ${theme}/${lang} 成员/创建面无页面级横向溢出`, overflow.page ? overflow.page.scrollWidth <= overflow.page.clientWidth + 1 : true, overflow.page)
    }
  }
  await js<boolean>(`window.__poo196.setLang('zh-Hans')`)
  await js<boolean>(`window.__poo196.setTheme('light')`)
  await delay(300)
}

/** S20: R8a 禁词扫描扩展——成员面板各步 + 创建对话框 × 三语言。 */
async function scenarioR8aMembersCreate() {
  const forbidden = [
    'OpenViking', 'Viking', '向量', 'COS', '对象存储', 'bucket', 'presign', '预签名',
    'embedding', '索引库', '全文检索', '解析上限', 'chunk', 'CHUNK',
    'token 上限', 'STORAGE', 'S3', 'OSS',
  ]
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await clickTab(T.tabMessages)
  await clearInput()
  await delay(200)

  const surfaces: Array<{ label: string; prepare: () => Promise<void>; cleanup: () => Promise<void> }> = [
    {
      label: 'members-overview',
      prepare: async () => {
        await openMembersDialog()
        await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
      },
      cleanup: () => closeMembersDialog(),
    },
    {
      label: 'members-compose',
      prepare: async () => {
        await openMembersDialog()
        await until(() => js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`), 8000)
        await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
        await until(() => js<boolean>(`window.__poo196.q('${T.membersCompose}')`), 8000)
      },
      cleanup: () => closeMembersDialog(),
    },
    {
      label: 'members-result',
      prepare: async () => {
        await openMembersDialog()
        await until(() => js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`), 8000)
        await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
        await until(() => js<boolean>(`window.__poo196.q('${T.membersCompose}')`), 8000)
        await typeInto(T.membersInviteTarget, '13400001234')
        await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
        await until(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 10000)
      },
      cleanup: () => closeMembersDialog(),
    },
    {
      label: 'members-member-surface',
      prepare: async () => {
        await js<boolean>('window.__poo196Space.setRole("member")')
        await delay(250)
        await openMembersDialog()
        await until(() => js<boolean>(`window.__poo196.q('${T.membersMemberSurface}')`), 8000)
      },
      cleanup: async () => {
        await closeMembersDialog()
        await js<boolean>('window.__poo196Space.setRole("manager")')
        await delay(250)
      },
    },
    {
      label: 'create-form',
      prepare: async () => {
        await openCreateDialog()
        await clearAndType(T.createName, 'R8a 扫描项目')
      },
      cleanup: () => closeCreateDialog(),
    },
  ]

  for (const lang of ['zh-Hans', 'en', 'de'] as const) {
    await js<boolean>(`window.__poo196.setLang('${lang}')`)
    await delay(250)
    for (const surface of surfaces) {
      await surface.prepare()
      const text = await js<string>('window.__poo196.text()')
      const hits = forbidden.filter((word) => text.includes(word))
      check(`[S20] ${lang}/${surface.label} 禁词 0 命中`, hits.length === 0, { hits, sample: text.slice(0, 100) })
      await surface.cleanup()
    }
  }
  await js<boolean>(`window.__poo196.setLang('zh-Hans')`)
  await delay(200)
}

/** S21: 性能——成员面板打开→名册可见、创建对话框打开、邀请提交→结果页。 */
async function scenarioMembersPerformance() {
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await clickTab(T.tabMessages)
  await delay(200)

  const openDurations: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now()
    await js<boolean>(`window.__poo196.click('${T.membersButton}')`)
    await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 10000)
    openDurations.push(Date.now() - t0)
    await closeMembersDialog()
    await delay(150)
  }
  const medianOpen = openDurations.sort((a, b) => a - b)[1]
  check('[S21] 成员面板打开到名册可见中位 <1500ms', medianOpen < 1500, { openDurations, medianOpen })

  const tCreate0 = Date.now()
  await openCreateDialog()
  const createOpenMs = Date.now() - tCreate0
  check('[S21] 创建对话框打开 <1500ms', createOpenMs < 1500, { createOpenMs })
  await closeCreateDialog()

  await openMembersDialog()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`), 8000)
  await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersCompose}')`), 8000)
  await typeInto(T.membersInviteTarget, '13500001234')
  const tInvite = Date.now()
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 10000)
  const inviteMs = Date.now() - tInvite
  check('[S21] 邀请提交→结果页 <2000ms', inviteMs < 2000, { inviteMs })
  await capture('s21-invite-roundtrip')
  await closeMembersDialog()
  await clickTab(T.tabMessages)
  await delay(150)
}

async function main() {
  app.setPath('userData', join(BUILD, 'profile'))
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.commandLine.appendSwitch('disable-features', 'MacWebContentsOcclusion')
  await app.whenReady()
  app.dock?.hide()
  app.on('web-contents-created', (_e, wc) => observeWebContents(wc))

  await startPreviewServer()
  registerFixtureIpc()
  mkdirSync(join(BUILD, 'fixture'), { recursive: true })
  writeFileSync(FIXTURE_FILE_SMALL, '# 会议纪要 1106\n\nPOO-196 fixture 上传素材，正文用于检索。')
  writeFileSync(FIXTURE_FILE_HUGE, Buffer.alloc(4096, 0x62))
  mkdirSync(fixture.downloadDir, { recursive: true })

  host = new BrowserWindow({
    width: 1440,
    height: 900,
    useContentSize: true,
    frame: false,
    enableLargerThanScreen: true,
    show: false,
    webPreferences: {
      preload: join(BUILD, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })

  host.show()
  await host.loadFile(join(BUILD, 'pages', 'host.html'), { search: 'lang=zh-Hans&theme=light' })
  await delay(400)

  const scenarios: Array<[string, () => Promise<void>]> = []
  if (process.env.POO196_TOUR === '1') {
    scenarios.push(['T-采集巡游', evidenceTour])
  } else {
    scenarios.push(
      ['S0-冒烟', scenarioSmoke],
      ['S1-会话切换旅程', scenarioSessionSwitch],
      ['S2-tab开关回路', scenarioTabLoop],
      ['S3-上传旅程', scenarioUploadJourney],
      ['S4-引用旅程', scenarioMentionJourney],
      ['S5-行操作与Pin回路', scenarioRowActionsAndPins],
      ['S5b-预览隔离(S-10)', scenarioPreviewIsolation],
      ['S6-回收站旅程', scenarioTrashJourney],
      ['S7-错误态', scenarioErrorCodes],
      ['S8-生命周期', scenarioLifecycle],
      ['S9-平台集成', scenarioPlatform],
      ['S10-性能', scenarioPerformance],
      ['S11-视觉矩阵', scenarioVisualMatrix],
      ['S12-R8a边界', scenarioR8aSurfaceScan],
      ['S13-成员与创建项目', scenarioMembersAndCreate],
      // R2 扩展: 追加轮新表面 × 七轴（创建项目 + 成员管理）
      ['S14-成员两态与失权', scenarioMembersTwoState],
      ['S15-邀请回路扩展', scenarioInviteLoops],
      ['S16-创建对话框回路', scenarioCreateLoops],
      ['S17-空间菜单入口', scenarioSpaceMenuEntry],
      ['S18-双分支与生命周期', scenarioBranchesAndLifecycle],
      ['S19-视觉矩阵扩展', scenarioVisualMembersCreate],
      ['S20-R8a成员创建面', scenarioR8aMembersCreate],
      ['S21-成员创建性能', scenarioMembersPerformance],
    )
  }
  // POO196_SCENARIOS=S0,S14 — 局部复跑过滤器（调试/复验用）。
  const filter = (process.env.POO196_SCENARIOS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const selected = filter.length ? scenarios.filter(([name]) => filter.some(f => name.startsWith(f))) : scenarios
  for (const [name, run] of selected) {
    steps.length = 0
    host.show()
    host.focus()
    try {
      await run()
      result.scenarios.push({ name, ok: true })
    } catch (error) {
      result.scenarios.push({ name, ok: false, detail: `${String((error as Error).message).slice(0, 320)} | steps: ${steps.join(' → ')}` })
      console.error(`SCENARIO FAIL ${name}:`, (error as Error).message, '| steps:', steps.join(' → '))
      // Keep driving later scenarios: an isolated failure must not eat the rest.
    }
  }

  check('[观测] console 零 error', result.consoleNoise.errors.length === 0, result.consoleNoise.errors.slice(0, 10))
  check('[观测] i18next/react-i18next 零警告', result.consoleNoise.i18nWarnings.length === 0, result.consoleNoise.i18nWarnings.slice(0, 10))
}

/* ── A 档报告采集巡游（POO196_TOUR=1）────────────────────────────────────
 * 外部 CDP 驱动（Playwright connect_over_cdp）逐状态截图并产出 capture 凭据。
 * 巡游只负责把每个状态布置稳：布置完成后把状态名写进 window.__poo196.tourState，
 * 然后等待 $POO196_TOUR_DIR/advance 出现同名内容才走向下一个状态。布置用
 * probeUntil（有界等待）——同一状态名在 after 树有、在 before 树没有时，
 * before 侧照常报告状态名，由驱动侧的状态检查判定该侧 absent。
 */
const TOUR_DIR = process.env.POO196_TOUR_DIR || '/tmp/poo196-tour'

async function waitTourAdvance(name: string): Promise<void> {
  const ack = join(TOUR_DIR, 'advance')
  const end = Date.now() + 240_000
  while (Date.now() < end) {
    try {
      if (readFileSync(ack, 'utf8').trim() === name) return
    } catch { /* 尚未放行 */ }
    await delay(150)
  }
  throw new Error(`tour advance for ${name} never arrived`)
}

const tourToFilesTab = async () => {
  await runProgramDirect({ op: 'resetAssets' })
  await clickTab(T.tabMessages)
  await delay(150)
  await clickTab(T.tabFiles)
  await probeUntil(() => js<boolean>(`window.__poo196.q('${T.list}')`), 10000)
  await probeUntil(async () => (await js<number>(`window.__poo196.count('${T.list} [data-testid^="pc-asset-row-"]')`)) >= 6, 10000)
}

/** The tour shares one mounted page across states (unlike the scenarios, each
 * of which starts fresh), so a state that leaves a dialog/confirm layer/
 * trash drill-down behind would silently break every later setup's clicks.
 * Loop until every transient surface is gone. */
const tourResetOverlays = async () => {
  for (let round = 0; round < 8; round++) {
    let dirty = false
    if (await js<boolean>(`window.__poo196.q('[data-testid="pc-upload-discard-confirm"]')`)) {
      // CONFIRM the discard: cancelling would loop forever against a dialog
      // whose draft keeps re-arming the guard on every close attempt.
      await js<boolean>(`window.__poo196.click('[data-testid="confirm-dialog-action"]')`)
      dirty = true
    } else if (await js<boolean>(`window.__poo196.q('${T.previewOverlay}')`)) {
      await pressEscape()
      dirty = true
    } else if (await js<boolean>(`window.__poo196.q('[data-testid="pc-upload-dialog"]')`)) {
      await js<boolean>(`window.__poo196.click('[data-testid="pc-upload-cancel"]')`)
      dirty = true
    } else if (await js<boolean>(`window.__poo196.q('[data-testid="pc-replace-dialog"]')`)) {
      await js<boolean>(`window.__poo196.click('[data-testid="pc-replace-cancel"]')`)
      dirty = true
    } else if (await js<boolean>(`window.__poo196.q('${T.mentionPopover}')`)) {
      await clearInput()
      dirty = true
    } else if (await js<boolean>(`window.__poo196.q('[data-testid="pc-trash-back"]')`)) {
      await js<boolean>(`window.__poo196.click('[data-testid="pc-trash-back"]')`)
      dirty = true
    }
    if (!dirty) return
    await delay(150)
  }
}

async function evidenceTour() {
  mkdirSync(TOUR_DIR, { recursive: true })
  await until(() => js<boolean>('Boolean(window.__poo196 && window.__poo196.ready)'), 20000)
  await clickTab(T.tabMessages)
  await delay(200)

  const states: Array<{ name: string; setup: () => Promise<void> }> = [
    {
      name: 'files-library',
      setup: async () => {
        await tourResetOverlays()
        await tourToFilesTab()
      },
    },
    {
      // S-09：状态过滤补「可用」。before 树没有该 chip，点击落空 → 驱动侧判 absent。
      name: 'files-available-filter',
      setup: async () => {
        await tourResetOverlays()
        await tourToFilesTab()
        await js<boolean>(`window.__poo196.click('[data-testid="pc-status-filter-available"]')`).catch(() => false)
        await delay(900)
      },
    },
    {
      // S-08：中性能力通知替换整块（caps 面携带 disabledReason，pcListCapabilities
      // 不被 fixture 关闭）。before 树没有该面。
      name: 'capability-storage-disabled',
      setup: async () => {
        await tourResetOverlays()
        await tourToFilesTab()
        await runProgramDirect({ op: 'setCapabilities', args: { capabilities: { featureEnabled: false, disabledReason: 'storage_unavailable', canShare: false, canManage: false, library: { status: 'none' } } } })
        await clickTab(T.tabMessages)
        await delay(150)
        await clickTab(T.tabFiles)
        await until(() => js<boolean>(`window.__poo196.q('[data-testid="pc-capability-notice"][data-state="storage_unavailable"]')`), 8000)
        await delay(300)
      },
    },
    {
      // X7+X8：上传弹层统一关闭语义 —— 已选文件待提交（含丢弃确认前置态）。
      name: 'upload-dialog',
      setup: async () => {
        await tourResetOverlays()
        await tourToFilesTab()
        await openUploadDialog()
        await runProgramDirect({ op: 'queueFileDialog', args: { paths: [FIXTURE_FILE_SMALL] } })
        await js<boolean>(`window.__poo196.click('${T.uploadPick}')`)
        await until(() => js<boolean>(`window.__poo196.q('[data-testid="pc-upload-file-summary"]')`), 8000)
        await delay(250)
      },
    },
    {
      // X22：自定义标签被拒保留输入并 inline 显示原因（保留字 confirmed）。
      name: 'upload-tag-reserved',
      setup: async () => {
        await tourResetOverlays()
        await tourToFilesTab()
        await openUploadDialog()
        await runProgramDirect({ op: 'queueFileDialog', args: { paths: [FIXTURE_FILE_SMALL] } })
        await js<boolean>(`window.__poo196.click('${T.uploadPick}')`)
        await until(() => js<boolean>(`window.__poo196.q('[data-testid="pc-upload-file-summary"]')`), 8000)
        await typeInto(T.uploadName, '巡游-标签被拒.md')
        await typeInto(T.uploadTagInput, 'confirmed')
        await js<boolean>(`window.__poo196.pressEnterOn('${T.uploadTagInput}')`)
        await until(() => js<boolean>(`window.__poo196.q('[data-testid="pc-upload-tag-error"]')`), 5000)
        await delay(250)
      },
    },
    {
      // X7：已选文件未提交时 Esc → 丢弃确认层（before 树直接关闭 → absent）。
      name: 'upload-discard-guard',
      setup: async () => {
        await tourResetOverlays()
        await tourToFilesTab()
        await openUploadDialog()
        await runProgramDirect({ op: 'queueFileDialog', args: { paths: [FIXTURE_FILE_SMALL] } })
        await js<boolean>(`window.__poo196.click('${T.uploadPick}')`)
        await until(() => js<boolean>(`window.__poo196.q('[data-testid="pc-upload-file-summary"]')`), 8000)
        await typeInto(T.uploadName, '巡游-丢弃确认.md')
        await pressEscape()
        await until(() => js<boolean>(`window.__poo196.q('[data-testid="pc-upload-discard-confirm"]')`), 5000)
        await delay(250)
      },
    },
    {
      // S-11：@ 浮层统一分组（项目文件/技能/来源）+ X4 引导文案区。
      name: 'mention-popover',
      setup: async () => {
        await tourResetOverlays()
        await clickTab(T.tabMessages)
        await delay(200)
        await clearInput()
        await typeMentionQuery('会')
        await until(() => js<boolean>(`window.__poo196.q('${T.mentionPopover}')`), 8000)
        await delay(300)
      },
    },
    {
      // D5：Pin 面板仅 pinned active 投影。
      name: 'pin-pane',
      setup: async () => {
        await tourResetOverlays()
        await runProgramDirect({ op: 'resetAssets' })
        await clickTab(T.tabMessages)
        await delay(150)
        await clickTab(T.tabPins)
        await until(() => js<boolean>(`window.__poo196.q('${T.pinPane}')`), 8000)
        await until(() => js<boolean>(`window.__poo196.count('[data-testid^="pc-asset-row-"]') >= 1`), 8000)
        await delay(300)
      },
    },
    {
      // X25：回收站 nextCursor「加载更多」。stageTrashLoadMore 把活跃资产压入回收站使其超过一页。
      name: 'trash-load-more',
      setup: async () => {
        await tourResetOverlays()
        await runProgramDirect({ op: 'resetAssets' })
        await runProgramDirect({ op: 'add100Assets' })
        // PC_LIST_LIMIT_DEFAULT is 50: stage MORE than one page or the
        // nextCursor (and the load-more entry) never appears.
        await runProgramDirect({ op: 'stageTrashLoadMore', args: { count: 60 } })
        // tourToFilesTab would resetAssets again and wipe the staged trash —
        // flip tabs WITHOUT resetting to make the pane re-read the fixture.
        await clickTab(T.tabMessages)
        await delay(150)
        await clickTab(T.tabFiles)
        await until(() => js<boolean>(`window.__poo196.q('${T.list}')`), 10000)
        await clickTab(T.trashButton)
        await until(() => js<boolean>(`window.__poo196.q('${T.trashView}')`), 8000)
        await delay(800)
      },
    },
    {
      // S-10 + X20：项目 HTML 预览隔离覆盖层（before 树不存在 → absent）。
      name: 'preview-overlay',
      setup: async () => {
        await tourResetOverlays()
        await tourToFilesTab()
        await clickMenuAction('as-prototype-html', 'preview').catch(() => {})
        await until(() => js<boolean>(`window.__poo196.q('${T.previewOverlay}')`), 8000)
        await delay(600)
      },
    },
  ]

  for (const state of states) {
    try {
      await state.setup()
    } catch (error) {
      console.error(`TOUR setup ${state.name} failed:`, String(error).slice(0, 200))
    }
    await js<void>(`window.__poo196.tourState = ${JSON.stringify(state.name)}; true`)
    await waitTourAdvance(state.name)
    await js<void>(`window.__poo196.tourState = ''; true`)
  }
}

process.on('unhandledRejection', (e) => console.error('UNHANDLED', String(e)))
const timer = setTimeout(() => { result.error = 'global timeout'; finish(1) }, 900_000)

async function finish(code: number) {
  clearTimeout(timer)
  try {
    if (previewServer) previewServer.close()
    if (host && !host.isDestroyed()) host.destroy()
  } catch (e) { result.cleanupError = String(e) }
  result.endedAt = new Date().toISOString()
  writeFileSync(join(OUT, 'runtime.json'), JSON.stringify(result, null, 2))
  writeFileSync(join(OUT, 'pc-calls.json'), JSON.stringify(result.pcCalls, null, 2))
  app.exit(code)
}

main()
  .then(() => {
    const failed = result.checks.filter((c) => !c.ok)
    // A scenario that threw mid-way still reports exit 0 through checks alone
    // (its remaining checks never ran) — the exit gate must include every
    // scenario reaching its end (run4 masked exactly this on S7).
    const failedScenarios = result.scenarios.filter((s) => !s.ok)
    console.log(`CHECKS ${result.checks.length - failed.length}/${result.checks.length} passed; captures=${result.captures.length}; scenarios=${result.scenarios.length - failedScenarios.length}/${result.scenarios.length} ok`)
    for (const s of failedScenarios) console.error(`SCENARIO STILL FAILING: ${s.name}`)
    return finish(failed.length || failedScenarios.length ? 1 : 0)
  })
  .catch((e) => {
    result.error = String((e as Error).stack ?? e)
    console.error(e)
    finish(1)
  })
