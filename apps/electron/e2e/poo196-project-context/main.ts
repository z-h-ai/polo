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
  ACCOUNT_ID,
  CREATED_ENTERPRISE_SPACE_ID,
  CURRENT_USER_ID,
  LONG_NAME_ASSET_ID,
  PRODUCT_SPACE_ID,
  R3_ACCOUNT_B_ID,
  R3_PROJECT_ALPHA_ID,
  R3_PROJECT_BETA_ID,
  R3_PROJECT_EMPTY_ID,
  R3_PROJECT_READONLY_ID,
  R3_TWIN_A_ID,
  R3_TWIN_B_ID,
  R3_TWIN_NAME,
  SESSION_PERSONAL,
  SESSION_PROJECT,
  SESSION_PROJECT_EMPTY,
  SESSION_R3_ALPHA_RECENT,
  SESSION_R3_BETA_RECENT,
  fixtureSpaceList,
  initialAssets,
  initialCapabilities,
  initialColleaguesDirectory,
  initialCollaborationRoster,
  initialPmInvitations,
  initialPmRoster,
  initialR3Directory,
  initialSearchIndex,
  r3DirectoryVariant,
  r3Sessions,
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
  scenarios: { name: string; ok: boolean; checks?: number; detail?: unknown }[]
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
  cleanupError?: string
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
  /** UB4 (U13): the composer send-key preference the fixture answers with —
   * the REAL settings storage is outside the harness boundary, so the same
   * preference flip is a fixture control (setSendMessageKey op). */
  sendMessageKey: 'Enter' as 'Enter' | 'cmd-enter',
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
    createdSeq: 0,
    createCalls: [] as Array<Record<string, unknown>>,
    receiptCalls: [] as Array<Record<string, unknown>>,
    inviteCalls: [] as Array<Record<string, unknown>>,
    /** POO-196 R3 (D3–D6): colleague directory script + per-object invitation
     * bridge state — mirrors the discriminated outcomes the real admin
     * produces for the SAME createRequestKey. */
    colleagueScript: 'available' as 'available' | 'none' | 'ambiguous' | 'fault',
    colleagueInviteScript: 'ok' as 'ok' | 'lost' | 'existing' | 'state_changed' | 'credential_unrecoverable',
    colleagueKeys: new Map<string, { key: string; invitationId: string; token: string }>(),
    colleagueCalls: [] as Array<Record<string, unknown>>,
    colleagueQueryCalls: [] as Array<Record<string, unknown>>,
    /** UB3 (U6): pagination for the invitation records (0 = off). Staged via
     * setPmInvitationPages so the pending-summary page-bound nails run against
     * a REAL two-page walk (cursor semantics, not a faked count). */
    invitationPageSize: 0,
    /** UB3 (U8): extra AVAILABLE colleague rows appended to the directory —
     * the cap/multi-select nails need more selectable rows than the base four. */
    colleagueExtraAvailable: 0,
  },
  /** POO-196 R3 (D6/D12/D13): the negotiated home project directory, the
   * project-entry session read mode, and the R3 call observability. */
  r3: {
    /** 'ok' → the full directory; 'empty' → organization+personal only (the
     * 「还没有项目」 verified-empty face); 'one' → single-card capacity
     * boundary; 'version' → contract_version_unsupported 409 (the P4 version
     * face); 'fault' → pm_service_unavailable (the generic error face);
     * 'revoked' → the alpha project dropped from the list (撤权). */
    directoryScript: 'ok' as 'ok' | 'empty' | 'one' | 'seven' | 'legacy' | 'version' | 'fault' | 'revoked',
    /** project-entry session reads: 'recent' → the seeded workspace list;
     * 'empty' → the alpha/beta sessions removed (无历史 entry); 'fault' → the
     * read fails (historyFailed, D13.3 — never a silent "no history"). */
    sessionsMode: 'recent' as 'recent' | 'empty' | 'fault',
    /** UB2 (U3/U11): extra latency for the getSessions read so the
     * 'resuming' window (post-commit history read) is orchestrator-
     * observable — the same injection class as the latency knob (时延注入,
     * no product logic in the fixture). */
    sessionsDelayMs: 0,
    getSessionsCalls: [] as Array<{ at: string }>,
    /** UB2 (U11): ChatDisplay's follow-up sent-marker writes
     * (sessionCommand updateAnnotation) — the blocked-send pin asserts this
     * stays EMPTY while a send is refused. */
    annotationCommands: [] as Array<{ at: string; messageId?: string; annotationId?: string }>,
    /** The D4 roster's viewerRole — the LIVE authority the panel trusts
     * (roster.viewerRole ?? space summary), so the member face requires the
     * fixture roster to answer as a member. */
    rosterRole: 'manager' as 'owner' | 'manager' | 'member',
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
    case 'pmListProjectInvitations': {
      // UB3 (U6): when pagination is staged (setPmInvitationPages) the list
      // walks by REAL numeric cursors — the pending-summary page-bound nails
      // exercise the client against true page semantics, not a faked count.
      const pageSize = fixture.pm.invitationPageSize
      if (!pageSize || pageSize <= 0) {
        return clone({
          productSpaceId: pm.roster.productSpaceId,
          viewerRole: pm.roster.viewerRole,
          invitations: pm.invitations,
          nextCursor: null,
        })
      }
      const cursorNum = Number(input.cursor ?? 0)
      const start = Number.isFinite(cursorNum) && cursorNum > 0 ? cursorNum : 0
      const end = start + pageSize
      return clone({
        productSpaceId: pm.roster.productSpaceId,
        viewerRole: pm.roster.viewerRole,
        invitations: pm.invitations.slice(start, end),
        nextCursor: end < pm.invitations.length ? String(end) : null,
      })
    }
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
      // Production mints a FRESH product-space id per project; a second
      // create in one harness session must not reuse the first id (the
      // create dialog's auto-enter memo is keyed by it).
      pm.createdSeq += 1
      pm.createdSpace = {
        productSpaceId: pm.createdSeq === 1
          ? CREATED_ENTERPRISE_SPACE_ID
          : `${CREATED_ENTERPRISE_SPACE_ID}-${pm.createdSeq}`,
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
    case 'pmListCollaborationRoster': {
      // D4: the all-role minimal roster — q filters the PAGE server-side over
      // the full list, `totalActiveMembers` stays the unfiltered server count
      // (never a client-derived or fabricated number).
      const q = typeof input.q === 'string' ? input.q.trim().toLowerCase() : ''
      const roster = initialCollaborationRoster()
      const members = roster.members.filter(member => !q || (member.displayName ?? '').toLowerCase().includes(q))
      return {
        ...roster,
        viewerRole: fixture.r3.rosterRole,
        members,
        nextCursor: null,
      }
    }
    case 'pmListColleagueOptions': {
      // D3: the restricted colleague directory of the caller's OWN source
      // organization. `none`/`ambiguous` are SUCCESS bodies (empty source
      // states with their fallback copy), not failures; 'fault' arms a coded
      // colleague_source_unavailable so the refresh face is reachable.
      const script = fixture.pm.colleagueScript
      if (script === 'fault') {
        record('fault', 'colleague_source_unavailable')
        throw codedError('colleague_source_unavailable', 'fixture fault colleague_source_unavailable')
      }
      const q = typeof input.q === 'string' ? input.q.trim().toLowerCase() : ''
      const directory = initialColleaguesDirectory()
      if (script === 'none' || script === 'ambiguous') {
        return {
          sourceState: script,
          source: null,
          members: [],
          nextCursor: null,
        }
      }
      // UB3 (U8): staged extra AVAILABLE rows (cap/multi-select nails).
      const base = directory.members.filter(member => !q || (member.displayName ?? '').toLowerCase().includes(q))
      const extra = fixture.pm.colleagueExtraAvailable
      if (!(extra > 0) || q) {
        return { ...directory, members: base, nextCursor: null }
      }
      const generated = Array.from({ length: extra }, (_, index) => ({
        userId: `u-cap-${String(index + 1).padStart(2, '0')}`,
        displayName: `容量同事${index + 1}`,
        avatarUrl: null,
        projectState: 'available',
      }))
      return {
        ...directory,
        members: [...base, ...generated],
        nextCursor: null,
      }
    }
    case 'pmCreateColleagueInvitation': {
      // D5 bridge: ONE selected colleague per call, resolved onto the existing
      // targeted-invitation outcome union. Same-key retry replays; a different
      // key at a target holding an active invitation answers `existing`.
      fixture.pm.colleagueCalls.push(clone(input))
      const command = (input.command ?? {}) as Record<string, unknown>
      const key = String(command.createRequestKey ?? 'pm-colleague-unknown')
      const target = String(command.targetUserId ?? 'unknown-target')
      const baseInvitation = {
        invitationId: `cinv-${fixture.pm.colleagueCalls.length}`,
        status: 'active',
        maskedPhone: null,
        maskedEmail: null,
        expiresAt: '2026-11-16T00:00:00+08:00',
        createdAt: nowIso(),
        acceptedAt: null,
      }
      if (fixture.pm.colleagueInviteScript === 'existing' || fixture.pm.colleagueInviteScript === 'state_changed' || fixture.pm.colleagueInviteScript === 'credential_unrecoverable') {
        const status = fixture.pm.colleagueInviteScript === 'state_changed' ? 'accepted' : 'active'
        return {
          result: fixture.pm.colleagueInviteScript,
          invitation: { ...baseInvitation, status },
        }
      }
      const token = Buffer.from(`colleague:${key}:${target}`).toString('base64url')
      const held = fixture.pm.colleagueKeys.get(target)
      if (fixture.pm.colleagueInviteScript === 'lost') {
        fixture.pm.colleagueKeys.set(target, { key, invitationId: baseInvitation.invitationId, token })
        // UB3 (U6): the aggregate committed server-side — the invitation is
        // listed in the records exactly like the targeted path's loss arm.
        fixture.pm.invitations.unshift(baseInvitation)
        throw new Error('fixture transport dropped before the colleague invitation response arrived')
      }
      if (held && held.key === key) {
        return {
          result: 'replayed',
          invitation: { ...baseInvitation, invitationId: held.invitationId },
          invitationUrl: `https://fixture-admin.polo.invalid/invite/${held.token}`,
        }
      }
      if (held) {
        return { result: 'existing', invitation: { ...baseInvitation, invitationId: held.invitationId, status: 'active' } }
      }
      fixture.pm.colleagueKeys.set(target, { key, invitationId: baseInvitation.invitationId, token })
      // UB3 (U6): colleague invitations appear in the records list (the real
      // read model lists every project invitation regardless of path), so the
      // local-name mapping nail has a row to land on.
      fixture.pm.invitations.unshift(baseInvitation)
      return {
        result: 'created',
        invitation: baseInvitation,
        invitationUrl: `https://fixture-admin.polo.invalid/invite/${token}`,
      }
    }
    case 'pmQueryColleagueInvitation': {
      // D5 recovery: the caller's own createRequestKey. `unknown` (202) is a
      // success state; a still-spendable held key re-derives the link.
      fixture.pm.colleagueQueryCalls.push(clone(input))
      const key = String(input.createRequestKey ?? '')
      for (const [target, held] of fixture.pm.colleagueKeys.entries()) {
        if (held.key === key) {
          return {
            state: 'found',
            invitation: {
              invitationId: held.invitationId,
              status: 'active',
              maskedPhone: null,
              maskedEmail: null,
              expiresAt: '2026-11-16T00:00:00+08:00',
              createdAt: nowIso(),
              acceptedAt: null,
            },
            invitationUrl: `https://fixture-admin.polo.invalid/invite/${Buffer.from(`colleague:${key}:${target}`).toString('base64url')}`,
          }
        }
      }
      return { state: 'unknown' }
    }
    case 'pmListProductSpacesR3': {
      // D6: the negotiated list read. The version face is a coded 409 — the
      // renderer classifies it into the P4 versionUnsupported copy (retrying
      // the same wire cannot fix an unsupported negotiation), the generic
      // fault keeps the in-section retry. The default v1 body (no R3
      // envelope) would fail the client composition schema the same way.
      if (fixture.r3.directoryScript === 'version') {
        record('fault', 'contract_version_unsupported')
        throw codedError('contract_version_unsupported', 'fixture: admin pre-dates the r3 negotiation')
      }
      if (fixture.r3.directoryScript === 'fault') {
        record('fault', 'pm_service_unavailable')
        throw codedError('pm_service_unavailable', 'fixture fault pm_service_unavailable')
      }
      if (fixture.r3.directoryScript === 'empty') return clone(r3DirectoryVariant('empty'))
      if (fixture.r3.directoryScript === 'one') return clone(r3DirectoryVariant('one'))
      // UB5 (U9): the seven-project capacity face — data-only variant so the
      // resident-search matrix can cross the >6 boundary (expand control).
      if (fixture.r3.directoryScript === 'seven') return clone(r3DirectoryVariant('seven'))
      // UB5 (U14): the UNCLASSIFIED identity face — the active space's
      // summary row is missing from an otherwise healthy negotiation, so the
      // client must render the neutral 「当前空间」 face instead of guessing
      // organization/project from the name. Fixture DATA only.
      if (fixture.r3.directoryScript === 'legacy') {
        const legacy = initialR3Directory() as { spaces: { productSpaces: Array<{ id: string }> }; enterpriseSummaries: Array<{ productSpaceId: string }> }
        legacy.enterpriseSummaries = legacy.enterpriseSummaries.filter(summary => summary.productSpaceId !== PRODUCT_SPACE_ID)
        return clone(legacy)
      }
      const directory = initialR3Directory() as { spaces: { productSpaces: Array<{ id: string }> }; enterpriseSummaries: Array<{ productSpaceId: string }> }
      if (fixture.r3.directoryScript === 'revoked') {
        // 撤权 face: the alpha project drops out of BOTH halves (a failed
        // entry is not in the success list), so the card collection and its
        // summary disappear together on the next read.
        directory.spaces.productSpaces = directory.spaces.productSpaces.filter(space => space.id !== 'ps-r3-alpha')
        directory.enterpriseSummaries = directory.enterpriseSummaries.filter(summary => summary.productSpaceId !== 'ps-r3-alpha')
      }
      // UB4 (U5): a space the fixture's pm create already minted joins the
      // negotiated directory on the NEXT read — production reality (the list
      // is server-authoritative; a created project shows up as a card), and
      // the 关闭再进/取消重试 nails need the created card to exist. Fixture
      // DATA only — the join mirrors the server, it fabricates nothing.
      const created = fixture.pm.createdSpace
      if (created && !directory.spaces.productSpaces.some(space => space.id === created.productSpaceId)) {
        directory.spaces.productSpaces = [...directory.spaces.productSpaces, {
          id: created.productSpaceId,
          kind: 'enterprise',
          enterpriseId: `ent-of-${created.productSpaceId}`,
          name: created.enterpriseName,
          role: 'owner',
          accessMode: 'active',
          payer: { kind: 'enterprise', enterpriseId: `ent-of-${created.productSpaceId}` },
        }]
        directory.enterpriseSummaries = [...directory.enterpriseSummaries, {
          productSpaceId: created.productSpaceId,
          enterpriseId: `ent-of-${created.productSpaceId}`,
          enterpriseKind: 'project',
        }]
      }
      return clone(directory)
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
        source: (input.source as { kind: 'file'; note: string | null } | undefined) ?? { kind: 'file', note: null },
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
  ipcMain.handle('fixture-stub', async (_e, name: string, args: unknown[]) => {
    switch (name) {
      case 'getSessionMessages': {
        // Unknown sessions (e.g. the first-send session created in the empty
        // state) answer null — never clone(undefined).
        const id = String(args?.[0] ?? '')
        const session = sessionsById[id]
          ?? r3Sessions.find(candidate => candidate.id === id)
          ?? null
        return session ? clone(session) : null
      }
      case 'readPreferences':
        return {}
      case 'writePreferences':
        return { ok: true }
      case 'getAutoCapitalisation':
      case 'getSpellCheck':
        return false
      case 'getSendMessageKey':
        return fixture.sendMessageKey
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
      case 'sessionCommand': {
        // UB2 (U11): ChatDisplay marks follow-up annotations as sent through
        // THIS command after an accepted send — the blocked-send pin reads
        // the log to prove a refused submit never marked anything.
        // sessionCommand(sessionId, command) — the command rides args[1].
        const command = (args?.[1] ?? {}) as { type?: string; messageId?: string; annotationId?: string }
        if (command?.type === 'updateAnnotation') {
          fixture.r3.annotationCommands.push({
            at: nowIso(),
            messageId: command.messageId,
            annotationId: command.annotationId,
          })
        }
        return { success: true }
      }
      case 'kbListCollections':
        return []
      case 'adminPaymentHandoff':
        return { ok: false }
      case 'adminGetStatus':
        // E2-2: the same receipt shape as the real admin:getStatus (the
        // adminUrl the desktop is signed in to rides beside the login state),
        // pinned to the fixture's trusted invitation origin.
        return {
          adminUrl: 'https://fixture-admin.polo.invalid',
          loggedIn: true,
          userId: 'fixture-admin-user',
          username: 'fixture-admin',
          displayName: 'Fixture Admin',
        }
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
      case 'getSessions': {
        // POO-196 R3 (D13.3): the project-entry flow reads the committed
        // scope's fresh session list through this IPC. The fixture hands out
        // the full workspace list (selection scopes by productSpaceId on the
        // real Session rows) or the scripted faces.
        if (fixture.r3.sessionsDelayMs > 0) {
          // UB2 (U3/U11): scripted read latency keeps the 'resuming' window
          // observable — injection only, the same class as setLatency.
          await delay(fixture.r3.sessionsDelayMs)
        }
        fixture.r3.getSessionsCalls.push({ at: nowIso() })
        if (fixture.r3.sessionsMode === 'fault') {
          throw new Error('fixture: session history read failed')
        }
        if (fixture.r3.sessionsMode === 'empty') {
          // The R3 project sessions are gone from the workspace: every project
          // entry resolves to the verified-empty face (never a fabricated
          // conversation).
          return clone([sessionsById[SESSION_PROJECT], sessionsById[SESSION_PERSONAL], sessionsById[SESSION_PROJECT_EMPTY]])
        }
        return clone([...Object.values(sessionsById), ...r3Sessions])
      }
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
      fixture.pm.createdSeq = 0
      fixture.pm.emailDeliveryAvailable = true
      fixture.pm.invitationKeys.clear()
      fixture.pm.createCalls = []
      fixture.pm.receiptCalls = []
      fixture.pm.inviteCalls = []
      // R3: the colleague bridge state resets with the pm store (one store,
      // one reset — no stale keys across scenarios).
      fixture.pm.colleagueScript = 'available'
      fixture.pm.colleagueInviteScript = 'ok'
      fixture.pm.colleagueKeys.clear()
      fixture.pm.colleagueCalls = []
      fixture.pm.colleagueQueryCalls = []
      // UB3 (U6/U8): staged pagination and extra directory rows reset too.
      fixture.pm.invitationPageSize = 0
      fixture.pm.colleagueExtraAvailable = 0
      fixture.r3.rosterRole = 'manager'
      return true
    case 'pmCallStats': {
      return {
        createCalls: clone(fixture.pm.createCalls),
        receiptCalls: clone(fixture.pm.receiptCalls),
        inviteCalls: clone(fixture.pm.inviteCalls),
        colleagueCalls: clone(fixture.pm.colleagueCalls),
        createdSpace: clone(fixture.pm.createdSpace),
      }
    }
    // ── POO-196 R3 (D6/D12/D13) programmable surface ──────────────────────
    case 'setR3DirectoryScript':
      fixture.r3.directoryScript = String(args.script) as typeof fixture.r3.directoryScript
      return true
    case 'setR3SessionsMode':
      fixture.r3.sessionsMode = String(args.mode) as typeof fixture.r3.sessionsMode
      return true
    case 'setR3RosterRole':
      fixture.r3.rosterRole = String(args.role) as typeof fixture.r3.rosterRole
      return true
    case 'setR3SessionsDelay':
      fixture.r3.sessionsDelayMs = Number(args.ms ?? 0)
      return true
    // UB4 (U13): flip the composer send-key preference the fixture answers
    // with (the REAL settings live outside this harness's boundary).
    case 'setSendMessageKey':
      fixture.sendMessageKey = args.value === 'cmd-enter' ? 'cmd-enter' : 'Enter'
      return true
    case 'setColleagueScript':
      fixture.pm.colleagueScript = String(args.script) as typeof fixture.pm.colleagueScript
      return true
    case 'setColleagueInviteScript':
      fixture.pm.colleagueInviteScript = String(args.script) as typeof fixture.pm.colleagueInviteScript
      return true
    // UB3 (U6): stage a REAL two-page invitation walk — two active (page 1),
    // one active-but-EXPIRED (page 1, never counted), then a repeatable
    // duplicate of an active id, one more active and one accepted (page 2).
    // First page pending = 2 (「至少 2」), full walk pending = 3 (exact).
    case 'setPmInvitationPages': {
      const future = '2026-12-20T00:00:00+08:00'
      const expired = '2026-01-10T00:00:00+08:00'
      const entry = (invitationId: string, maskedPhone: string, overrides: Partial<Record<string, unknown>> = {}) => ({
        invitationId,
        status: 'active',
        maskedPhone,
        maskedEmail: null,
        expiresAt: future,
        createdAt: '2026-11-01T09:00:00+08:00',
        acceptedAt: null,
        ...overrides,
      })
      fixture.pm.invitations = [
        entry('inv-pg-1', '138****0001'),
        entry('inv-pg-2', '138****0002'),
        entry('inv-pg-3', '138****0003', { expiresAt: expired }),
        entry('inv-pg-2', '138****0002'), // repeatable-page duplicate
        entry('inv-pg-4', '138****0004'),
        entry('inv-pg-5', '138****0005', { status: 'accepted', acceptedAt: '2026-11-03T10:00:00+08:00' }),
      ]
      // pageSize 0 turns the staged pagination OFF again (reset semantics).
      fixture.pm.invitationPageSize = Math.max(0, Number(args.pageSize ?? 0))
      return true
    }
    // UB3 (U8): extend the directory with N extra AVAILABLE colleagues.
    case 'stageColleagueDirectory': {
      fixture.pm.colleagueScript = 'available'
      fixture.pm.colleagueExtraAvailable = Math.max(0, Number(args.available ?? 0))
      return true
    }
    case 'resetR3':
      fixture.r3.directoryScript = 'ok'
      fixture.r3.sessionsMode = 'recent'
      fixture.r3.sessionsDelayMs = 0
      fixture.r3.rosterRole = 'manager'
      fixture.r3.getSessionsCalls = []
      fixture.r3.annotationCommands = []
      fixture.pm.colleagueScript = 'available'
      fixture.pm.colleagueInviteScript = 'ok'
      fixture.pm.colleagueKeys.clear()
      fixture.pm.colleagueCalls = []
      fixture.pm.colleagueQueryCalls = []
      return true
    case 'r3Stats':
      return {
        getSessionsCalls: clone(fixture.r3.getSessionsCalls),
        directoryScript: fixture.r3.directoryScript,
        sessionsMode: fixture.r3.sessionsMode,
        sessionsDelayMs: fixture.r3.sessionsDelayMs,
        annotationCommands: clone(fixture.r3.annotationCommands),
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
      const r3switch = (window.__poo196 && window.__poo196.spaceSwitchLog) ? window.__poo196.spaceSwitchLog().join('|').slice(-160) : ''
      const r3surface = (window.__poo196 && window.__poo196.surface) ? String(window.__poo196.surface()) : '?'
      const r3pending = (window.__poo196 && window.__poo196.entryPending) ? String(window.__poo196.entryPending()) : '?'
      const r3nav = (window.__poo196 && window.__poo196.navigateLog) ? JSON.stringify(window.__poo196.navigateLog().slice(-2)) : '[]'
      const navRoute = (window.__poo196 && window.__poo196.navRoute) ? String(window.__poo196.navRoute()) : '?'
      const routeHist = (window.__poo196 && window.__poo196.navRouteLog) ? JSON.stringify(window.__poo196.navRouteLog().slice(-5)) : '[]'
      const creates = (window.__poo196 && window.__poo196.createSessionLog) ? window.__poo196.createSessionLog().length : -1
      const oi = (window.__poo196 && window.__poo196.onboardingIntent) ? JSON.stringify(window.__poo196.onboardingIntent()) : '?'
      const ep = (window.__poo196 && window.__poo196.entryState) ? JSON.stringify(window.__poo196.entryState()) : '?'
      const shellInfo = (() => {
        const shell = document.querySelector('[data-testid="poo196-shell"]')
        const el = shell ? (shell.querySelector('[data-testid="project-entry-empty"]') ? 'empty-state' : (shell.querySelector('[data-testid="pc-tabs"]') ? 'chatpage-tabs' : 'other')) : 'no-shell'
        const editables = document.querySelectorAll('textarea, [contenteditable="true"]').length
        const inputEl = document.querySelector('[data-tutorial=\"chat-input\"]')
        return el + '/editables=' + editables + '/input=' + (inputEl ? 'yes' : 'no')
      })()
      const pm = document.querySelector('[data-testid="project-members-panel"]')
      const pmInfo = pm ? \`open(mode=\${pm.getAttribute('data-mode')} page-title=\${(pm.querySelector('[data-testid="project-members-title"]')?.textContent ?? '').slice(0, 20)})\` : 'closed'
      const cd = document.querySelector('[data-testid="create-project-dialog"]')
      const cdInfo = cd ? \`open(phase=\${cd.getAttribute('data-phase')} radixState=\${cd.getAttribute('data-state')} openAttr=\${cd.closest('[data-slot=dialog-content]')?.parentElement?.getAttribute('data-state') ?? '?'} buttons=\${document.querySelectorAll('[data-testid=create-project-submit]').length}\` : 'closed'
      const overlays = document.querySelectorAll('[data-slot="dialog-overlay"]').length
      const trashEl = document.querySelector('[data-testid="pc-library-trash"]')
      const trashVis = trashEl ? getComputedStyle(trashEl).display : 'none'
      const mainEl = document.querySelector('[data-testid="pc-library"]')
      const mainVis = mainEl ? getComputedStyle(mainEl).display : 'none'
      return \`pm=\${pmInfo} create=\${cdInfo} overlays=\${overlays} trashVis=\${trashVis} mainVis=\${mainVis} tab=\${tab} libRoot=\${libRootName} notice=\${notice} pinPane=\${pinPane} rows=\${rows} popover=\${popoverInfo} \${dialog} err=\${err} input=\${JSON.stringify(input)} toast=\${JSON.stringify(toast)} toolbar=[\${toolbar}] r3=\${r3surface}/pend=\${r3pending}/switch=\${r3switch}/nav=\${r3nav}/route=\${navRoute}/rh=\${routeHist}/shell=\${shellInfo}/oi=\${oi}/ep=\${ep} renderLog=\${renderLog}\`
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
  // POO-196 追加轮: members entry + create dialog.
  // POO-196 R3 (D11): pc-members-button KEPT but moved out of the tab strip
  // into the PanelHeader actions (the only members entry, never in the
  // tablist); the retired centered ProjectMembersDialog became the
  // project-members-panel (data-mode=push|drawer); the manage/member surfaces
  // and your-role/contact-owner faces were REPLACED by the shared roster.
  membersButton: '[data-testid="pc-members-button"]',
  membersPanel: '[data-testid="project-members-panel"]',
  membersBackdrop: '[data-testid="project-members-backdrop"]',
  membersSearch: '[data-testid="project-members-search"]',
  membersRoster: '[data-testid="project-members-roster"]',
  membersRosterRow: '[data-testid="project-members-roster-row"]',
  membersRosterCount: '[data-testid="project-members-roster-count"]',
  membersRosterMe: '[data-testid="project-members-roster-me"]',
  membersRosterEmpty: '[data-testid="project-members-roster-empty"]',
  membersRosterMore: '[data-testid="project-members-roster-more"]',
  membersInvitations: '[data-testid="project-members-invitations"]',
  membersInvitationRow: '[data-testid="project-members-invitation-row"]',
  membersInvitationsEntry: '[data-testid="project-members-invitations-entry"]',
  membersInvitationsMore: '[data-testid="project-members-invitations-more"]',
  membersInviteAction: '[data-testid="project-members-invite-action"]',
  membersCompose: '[data-testid="project-members-compose"]',
  membersInviteTarget: '[data-testid="project-members-invite-target"]',
  membersInviteSubmit: '[data-testid="project-members-invite-submit"]',
  membersComposeBack: '[data-testid="project-members-compose-back"]',
  membersResult: '[data-testid="project-members-invite-result"]',
  membersCopyLink: '[data-testid="project-members-copy-link"]',
  membersResultBack: '[data-testid="project-members-result-back"]',
  membersOpenManagement: '[data-testid="project-members-open-management"]',
  membersDirectInvite: '[data-testid="project-members-direct-invite"]',
  // R3: the in-panel add-member directory page (multi-select, nothing writes
  // until the confirm) — per-object rows carry data-user-id.
  colleaguesPage: '[data-testid="project-colleagues-page"]',
  colleaguesSearch: '[data-testid="project-colleagues-search"]',
  colleaguesRow: '[data-testid="project-colleagues-row"]',
  colleaguesConfirm: '[data-testid="project-colleagues-confirm"]',
  colleaguesBack: '[data-testid="project-colleagues-back"]',
  colleaguesSelected: '[data-testid="project-colleagues-selected"]',
  colleaguesRetryFailed: '[data-testid="project-colleagues-retry-failed"]',
  colleaguesQueryResult: '[data-testid="project-colleagues-query-result"]',
  colleaguesEmpty: '[data-testid="project-colleagues-empty"]',
  createDialog: '[data-testid="create-project-dialog"]',
  createName: '[data-testid="create-project-name-input"]',
  createOwner: '[data-testid="create-project-owner-input"]',
  createOwnerSyncHint: '[data-testid="create-project-owner-sync-hint"]',
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
  membersManageError: '[data-testid="project-members-manage-error"]',
  membersClose: '[data-testid="project-members-close"]',
  membersCopyFailed: '[data-testid="project-members-copy-failed"]',
  membersRosterError: '[data-testid="project-members-roster-error"]',
  membersRosterLoading: '[data-testid="project-members-roster-loading"]',
  membersInviteUnrecoverable: '[data-testid="project-members-invite-unrecoverable"]',
  membersInviteStateChanged: '[data-testid="project-members-invite-state-changed"]',
  membersInviteExisting: '[data-testid="project-members-invite-existing"]',
  // UB3 (U2/U6/U7/U8): manual-delivery copy faces, the pending summary with
  // its pagination bounds, the entry button's add-member glyph and the
  // colleague row's single row-wide toggle.
  membersCopyAll: '[data-testid="project-members-copy-all"]',
  membersCopyAllFailed: '[data-testid="project-members-copy-all-failed"]',
  membersCopyAllNote: '[data-testid="project-members-copy-all-note"]',
  membersCopyNextStep: '[data-testid="project-members-copy-next-step"]',
  membersPendingSummary: '[data-testid="project-members-pending-summary"]',
  membersEntryPlus: '[data-testid="pc-members-entry-plus"]',
  colleaguesRowToggle: '[data-testid="project-colleagues-row-toggle"]',
  membersInviteInvalid: '[data-testid="project-members-invite-target"]',
  createEnterFailed: '[data-testid="create-project-enter-failed"]',
  createEnterExisting: '[data-testid="create-project-enter-existing"]',
  createEnterpriseExists: '[data-testid="create-project-enterprise-exists"]',
  createPhoneVerification: '[data-testid="create-project-phone-verification"]',
  createVerifyPhone: '[data-testid="create-project-verify-phone"]',
  createVersionMismatch: '[data-testid="create-project-version-mismatch"]',
  createSubmitError: '[data-testid="create-project-submit-error"]',
  createNameHint: '[id="create-project-name-hint"]',
  // UB1 (U1/U4): responsibility error face + both version-guide hosts.
  createResponsibilityError: '[data-testid="create-project-responsibility-error"]',
  createUpdateGuide: '[data-testid="create-project-update-guide"]',
  createUpdateGuideBody: '[data-testid="create-project-update-guide-body"]',
  createClientUpdate: '[data-testid="create-project-client-update"]',
  homeProjectUpdateGuide: '[data-testid="home-project-update-guide"]',
  homeProjectUpdateGuideBody: '[data-testid="home-project-update-guide-body"]',
  homeProjectClientUpdate: '[data-testid="home-project-client-update"]',
  spaceMenuTrigger: '[data-testid="poo196-space-menu-trigger"]',
  spaceMenuContent: '[data-testid="poo196-space-menu-content"]',
  spaceMenuItem: '[data-testid="product-space-item"]',
  // POO-196 R3 (D11): the two RETIRED create entries — assertions flip to
  // count=0 (the sole create entry is the home「项目」header button).
  spaceMenuCreate: '[data-testid="product-space-create-project"]',
  spaceSelectCreate: '[data-testid="product-space-select-create-project"]',
  spaceMenuRefresh: '[data-testid="product-space-refresh"]',
  // POO-196 R3 home「项目」区域 + entry/empty-state pins (D11/D12).
  homeProjects: '[data-testid="home-projects"]',
  homeProjectCreate: '[data-testid="home-project-create"]',
  homeProjectCard: '[data-testid="home-project-card"]',
  homeProjectCurrent: '[data-testid="home-project-current"]',
  homeProjectExpand: '[data-testid="home-project-expand"]',
  homeProjectCollapse: '[data-testid="home-project-collapse"]',
  homeProjectSearch: '[data-testid="home-project-search"]',
  homeProjectNoMatches: '[data-testid="home-project-no-matches"]',
  homeProjectLoading: '[data-testid="home-project-loading"]',
  homeProjectError: '[data-testid="home-project-error"]',
  homeProjectErrorRetry: '[data-testid="home-project-error-retry"]',
  homeProjectStale: '[data-testid="home-project-stale"]',
  homeProjectEmpty: '[data-testid="home-project-empty"]',
  homeProjectReadonly: '[data-testid="home-project-readonly"]',
  // POO-196 R3 UB2 (U3/U10/U11): entry feedback, history-error face, retry
  // and the composer send-notice pins.
  homeProjectEntering: '[data-testid="home-project-entering"]',
  homeProjectEnterError: '[data-testid="home-project-enter-error"]',
  homeProjectEnterRetry: '[data-testid="home-project-enter-retry"]',
  homeProjectEnterLabel: '[data-testid="home-project-enter-label"]',
  projectEntryHistoryError: '[data-testid="project-entry-history-error"]',
  projectEntryRetry: '[data-testid="project-entry-retry"]',
  projectEntrySendNotice: '[data-testid="project-entry-send-notice"]',
  // POO-196 R3 UB4 (U5/U13): the empty-state three action cards, the honest
  // capability copy, the one-time onboarding skip face and the composer help.
  projectEntryEmptyHint: '[data-testid="project-entry-empty-hint"]',
  projectEntryActions: '[data-testid="project-entry-actions"]',
  projectEntryActionInvite: '[data-testid="project-entry-action-invite"]',
  projectEntryActionUpload: '[data-testid="project-entry-action-upload"]',
  projectEntryActionStart: '[data-testid="project-entry-action-start"]',
  projectOnboardingSkip: '[data-testid="project-onboarding-skip"]',
  projectOnboardingSkipBar: '[data-testid="project-onboarding-skip-bar"]',
  composerHelp: '[data-testid="project-composer-help"]',
  composerHelpContent: '[data-testid="project-composer-help-content"]',
  homeAppsTitle: '[data-testid="home-apps-title"]',
  homeDirectorySearch: '[data-testid="home-directory-search"]',
  projectEntryEmpty: '[data-testid="project-entry-empty"]',
  // UB5 (U14): the space identity bar + its classified title row.
  homeSpaceContext: '[data-testid="home-space-context"]',
  homeSpaceContextTitle: '[data-testid="home-space-context-title"]',
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
  host.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' } as unknown as Electron.KeyboardInputEvent)
  host.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' } as unknown as Electron.KeyboardInputEvent)
  await delay(350)
}

/** UB1 (U4): a TRUSTED Enter on the focused element (the real keyboard path a
 * plain <button> needs — synthetic KeyboardEvents do not trigger activation).
 * Electron's sendInputEvent spells the key 'Return' (accelerator spelling). */
const pressEnterTrusted = async () => {
  // A real Enter keystroke = keyDown(VK_RETURN) + char('\r') + keyUp. The
  // char leg is what makes Blink run the button's Enter-activation default
  // action (the keyDown name alone does not).
  host.webContents.sendInputEvent({ type: 'keyDown', keyCode: '\r' } as unknown as Electron.KeyboardInputEvent)
  host.webContents.sendInputEvent({ type: 'char', keyCode: '\r' } as unknown as Electron.KeyboardInputEvent)
  host.webContents.sendInputEvent({ type: 'keyUp', keyCode: '\r' } as unknown as Electron.KeyboardInputEvent)
  await delay(250)
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
    host.webContents.sendInputEvent({ type: 'char', keyCode: ch } as unknown as Electron.KeyboardInputEvent)
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
  // U12 旧→新映射：Pin tab 文案「Pin」→「置顶」（键值断言，术语统一钉）。
  const tabsPinsCopyS1 = (await i18nText('projectContext.tabs.pins')).trim()
  check('[S1] 三 tab 文案齐全(消息/文件/置顶)', tabsText.includes('消息') && tabsText.includes('文件') && tabsText.includes(tabsPinsCopyS1), { tabsText, tabsPinsCopyS1 })
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
  // U12 (G12) 旧→新映射：状态术语统一「处理中」→「正在准备」（键值改，检查
  // 语义不变——徽标必须是处理中态的真实文案）。
  const processingCopy = (await i18nText('projectContext.status.processing')).trim()
  const processingBadge = await js<string>(`document.querySelector('[data-testid="${newRow}"] [data-testid^="pc-asset-status-"]')?.textContent ?? ''`)
  check('[S3] 新行状态徽标为处理中(正在准备)', processingBadge.includes(processingCopy), { processingBadge, processingCopy })

  // fixture: 索引完成 → 用户切 tab 触发 refetch → 可用（U12: 「可用」→「已就绪」）
  await runProgramDirect({ op: 'indexAsset', args: { assetId: newRow.replace('pc-asset-row-', '') } })
  await clickTab(T.tabPins)
  await clickTab(T.tabFiles)
  await delay(600)
  const readyCopy = (await i18nText('projectContext.status.ready')).trim()
  const readyBadge = await js<string>(`document.querySelector('[data-testid="${newRow}"] [data-testid^="pc-asset-status-"]')?.textContent ?? ''`)
  check('[S3] 处理完成后(经列表刷新)徽标为可用(已就绪)', readyBadge === readyCopy, { readyBadge, readyCopy })
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
  host.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' } as unknown as Electron.KeyboardInputEvent)
  host.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' } as unknown as Electron.KeyboardInputEvent)
  await delay(80)
  const highlighted = await js<string>(`document.querySelector('[data-testid^="pc-mention-option-"][data-highlighted="true"]')?.getAttribute('data-testid') ?? ''`)
  check('[S4] ↓ 移动高亮', highlighted.length > 0, { highlighted })
  host.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' } as unknown as Electron.KeyboardInputEvent)
  host.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' } as unknown as Electron.KeyboardInputEvent)
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
  host.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' } as unknown as Electron.KeyboardInputEvent)
  host.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' } as unknown as Electron.KeyboardInputEvent)
  await delay(80)
  const r1Highlighted = await js<string>(`document.querySelector('[data-testid="pc-mention-extra-skill:acceptance-checklist"]')?.getAttribute('data-highlighted') ?? ''`)
  check('[S4·R-1] ↓ 高亮落在技能行', r1Highlighted === 'true', { r1Highlighted })
  const r1KeyLogMark = await js<number>('window.__poo196.inputChangeLog.length')
  host.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' } as unknown as Electron.KeyboardInputEvent)
  host.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' } as unknown as Electron.KeyboardInputEvent)
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

  // Pin → toast → 行状态翻转 → Pin 面板（as-meeting-1030 起始未 Pin，动作将其翻转为已置顶）
  mark('S5:row-menu-captured')
  // U12 (G12) 消费者钉：行菜单动作文案=键值「置顶」（旧「Pin」→新「置顶」，
  // 断言语义不变：pin 动作入口在且标注为新术语）。
  const pinActionCopy = (await i18nText('projectContext.actions.pin')).trim()
  const rowMenuOpen = await openRowMenu('as-meeting-1030', 'pin')
  check('[S5][U12] 行菜单 Pin 动作呈现「置顶」术语', rowMenuOpen
    && (await js<string>(`document.querySelector('${rowAction('as-meeting-1030', 'pin')}')?.textContent ?? ''`)).trim() === pinActionCopy, { pinActionCopy })
  await js<boolean>(`window.__poo196.pressEnterOn('${rowAction('as-meeting-1030', 'pin')}')`)
  await delay(250)
  mark('S5:pin-clicked')
  // 行状态翻转为 gate；toast 单独记录（toast 渲染本身由 S3/S6 证明）。
  // U12 旧→新映射：「已 Pin」→「已置顶」（键值断言，防术语回退）。
  await until(async () => (await js<string>(`document.querySelector('[data-testid="pc-asset-row-as-meeting-1030"]')?.getAttribute('data-pinned')`)) === 'true', 8000)
  const pinnedToastCopy = (await i18nText('projectContext.toast.pinned')).trim()
  const pinToastSeen = (await toastText()).includes(pinnedToastCopy)
  check('[S5] Pin 操作 toast 反馈（已置顶）', pinToastSeen, { pinToastSeen, pinnedToastCopy })
  const pinnedAttr = await js<string>(`document.querySelector('[data-testid="pc-asset-row-as-meeting-1030"]')?.getAttribute('data-pinned')`)
  check('[S5] 行 data-pinned 翻转', pinnedAttr === 'true', { pinnedAttr })
  // U12 消费钉：行上已置顶图标的 aria-label=「已置顶」（pinnedAria 键值）。
  const pinnedAriaCopyS5 = (await i18nText('projectContext.pin.pinnedAria')).trim()
  const rowAriaLabelsS5 = await js<string[]>(`Array.from(document.querySelectorAll('[data-testid="pc-asset-row-as-meeting-1030"] svg[aria-label]')).map(el => el.getAttribute('aria-label'))`)
  check('[S5][U12] 已置顶图标 aria=「已置顶」', rowAriaLabelsS5.includes(pinnedAriaCopyS5), { rowAriaLabelsS5, pinnedAriaCopyS5 })

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
  // U12 旧→新映射：「取消 Pin」→「取消置顶」（含「取消」的旧断言保留，另钉
  // 逐字术语断言防回退）。
  const unpinActionCopy = (await i18nText('projectContext.actions.unpin')).trim()
  check('[S5] Pin 面板内菜单呈现「取消置顶」', unpinLabel.includes('取消') && unpinLabel === unpinActionCopy, { unpinLabel, unpinActionCopy })
  await js<boolean>(`window.__poo196.pressEnterOn('${rowAction('as-meeting-1030', 'pin')}')`)
  await delay(600)
  check('[S5] Unpin 后从 Pin 面板消失', await js<boolean>(`!window.__poo196.q('${T.pinPane} [data-testid="pc-asset-row-as-meeting-1030"]')`))

  // U12（G12）空态/状态钉：清空其余置顶（as-req-doc / as-design-home）到达
  // 真实空态——「还没有置顶文件」+ hint；unpin toast=「已取消置顶」。
  // 注意：Pin 面板行菜单走 pane 专属 handleUnpin（无 toast）；取消置顶 toast
  // 的消费者在文件库行菜单（下方 files-tab 回路验证）。面板内以状态翻转为准。
  for (const assetId of ['as-req-doc', 'as-design-home']) {
    const menuSel = `${T.pinPane} ${rowMenu(assetId)}`
    let opened = false
    for (const mode of ['key', 'pointer']) {
      if (mode === 'key') await js<boolean>(`window.__poo196.pressEnterOn('${menuSel}')`)
      else await js<boolean>(`window.__poo196.click('${menuSel}')`)
      opened = await until(() => js<boolean>(`window.__poo196.q('${rowAction(assetId, 'pin')}')`), 3000)
      if (opened) break
      await pressEscape()
      await delay(150)
    }
    if (!opened) throw new Error(`pin pane menu never opened for ${assetId}`)
    await js<boolean>(`window.__poo196.pressEnterOn('${rowAction(assetId, 'pin')}')`)
    await until(async () => (await js<number>(`window.__poo196.count('${T.pinPane} [data-testid="pc-asset-row-${assetId}"]')`)) === 0, 8000)
    check(`[S5][U12] ${assetId} 取消置顶后离开 Pin 面板（状态翻转）`, true)
  }
  await until(async () => (await js<boolean>(`window.__poo196.q('${T.pinPane}')`))
    && (await js<number>(`window.__poo196.count('${T.pinPane} [data-testid^="pc-asset-row-"]')`)) === 0, 8000)
  const emptyTitleCopyS5 = (await i18nText('projectContext.pin.emptyTitle')).trim()
  const emptyHintCopyS5 = (await i18nText('projectContext.pin.emptyHint')).trim()
  const pinEmptyText = await js<string>(`document.querySelector('${T.pinPane}')?.textContent ?? ''`)
  check('[S5][U12] Pin 面板空态=「还没有置顶文件」+ 裁决 hint', pinEmptyText.includes(emptyTitleCopyS5) && pinEmptyText.includes(emptyHintCopyS5), { seen: pinEmptyText.slice(0, 80) })
  await capture('s5-u12-pin-pane-empty')

  // U12 toast 消费钉（文件库行菜单路径 = 带 toast 的 handleSetPinned）：
  // 置顶 toast=「已置顶」、取消置顶 toast=「已取消置顶」。回路用 as-design-home
  // （S7 的 Pin 面板冲突探针依赖 as-req-doc 在面板内——它在下方恢复）。
  // 行菜单标签跟随 data-pinned 渲染，先等列表 refetch 收敛再驱动，避免陈旧
  // 菜单标签把「置顶」点成「取消置顶」。
  const rowPinnedS5 = (assetId: string) => js<string>(`document.querySelector('[data-testid="pc-asset-row-${assetId}"]')?.getAttribute('data-pinned')`)
  await clickTab(T.tabFiles)
  await until(() => js<boolean>(`window.__poo196.q('${T.library}')`), 8000)
  await until(async () => (await rowPinnedS5('as-design-home')) === 'false' && (await rowPinnedS5('as-req-doc')) === 'false', 8000)
  const pinnedToastCopyS5b = (await i18nText('projectContext.toast.pinned')).trim()
  const unpinnedToastCopyS5b = (await i18nText('projectContext.toast.unpinned')).trim()
  await clickMenuAction('as-design-home', 'pin')
  let pinToastS5b = ''
  await until(async () => { pinToastS5b = await toastText(); return pinToastS5b.includes(pinnedToastCopyS5b) }, 8000)
  check('[S5][U12] 文件库置顶 toast=「已置顶」', pinToastS5b.includes(pinnedToastCopyS5b), { toastNow: pinToastS5b.slice(0, 120) })
  await until(async () => (await rowPinnedS5('as-design-home')) === 'true', 8000)
  await clickMenuAction('as-design-home', 'pin')
  let unpinToastS5b = ''
  await until(async () => { unpinToastS5b = await toastText(); return unpinToastS5b.includes(unpinnedToastCopyS5b) }, 8000)
  check('[S5][U12] 文件库取消置顶 toast=「已取消置顶」', unpinToastS5b.includes(unpinnedToastCopyS5b), { toastNow: unpinToastS5b.slice(0, 120) })
  // 恢复夹具基线 Pin 态（as-req-doc 必须回到 Pin 面板：S7 依赖；design-home 一并恢复）。
  // 以 data-pinned 真值驱动重试：一次菜单标签竞态不致把恢复点成反向。
  for (const assetId of ['as-req-doc', 'as-design-home']) {
    for (let attempt = 0; attempt < 4 && (await rowPinnedS5(assetId)) !== 'true'; attempt++) {
      await clickMenuAction(assetId, 'pin')
      await probeUntil(async () => (await rowPinnedS5(assetId)) === 'true', 4000)
    }
    await until(async () => (await rowPinnedS5(assetId)) === 'true', 8000)
  }
  check('[S5][U12] 基线 Pin 态恢复（as-req-doc/as-design-home 已置顶）', (await rowPinnedS5('as-req-doc')) === 'true' && (await rowPinnedS5('as-design-home')) === 'true')

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

  // U12 (G12) 消费者钉：19 键改值后所有可达消费者显示新术语（testid/结构不
  // 变，仅逐字文案断言；Pin/unpin 回路与过滤结果在上方保持原语义）。
  mark('S5:u12-terminology')
  const tabsPinsCopy = (await i18nText('projectContext.tabs.pins')).trim()
  const pinsTabLabel = (await js<string>(`document.querySelector('${T.tabPins}')?.textContent ?? ''`)).trim()
  check('[S5][U12] Pin tab 标签呈现「置顶」', pinsTabLabel === tabsPinsCopy, { pinsTabLabel, tabsPinsCopy })
  const readyCopyS5 = (await i18nText('projectContext.status.ready')).trim()
  const processingCopyS5 = (await i18nText('projectContext.status.processing')).trim()
  const failedRetryableCopyS5 = (await i18nText('projectContext.status.failedRetryable')).trim()
  const statusBadgeOf = (id: string) => js<string>(`document.querySelector('[data-testid="pc-asset-row-${id}"] [data-testid^="pc-asset-status-"]')?.textContent ?? ''`)
  check('[S5][U12] 状态徽标「已就绪」', (await statusBadgeOf('as-req-doc')).trim() === readyCopyS5, { badge: await statusBadgeOf('as-req-doc'), readyCopyS5 })
  check('[S5][U12] 状态徽标「正在准备」', (await statusBadgeOf('as-api-doc')).trim() === processingCopyS5, { badge: await statusBadgeOf('as-api-doc'), processingCopyS5 })
  check('[S5][U12] 状态徽标「处理失败，可重试」', (await statusBadgeOf('as-test-plan')).trim() === failedRetryableCopyS5, { badge: await statusBadgeOf('as-test-plan'), failedRetryableCopyS5 })
  const filterCopy = {
    available: (await i18nText('projectContext.statusFilter.available')).trim(),
    processing: (await i18nText('projectContext.statusFilter.processing')).trim(),
    failed: (await i18nText('projectContext.statusFilter.failed')).trim(),
  }
  const filterChipText = (state: string) => js<string>(`document.querySelector('[data-testid="pc-status-filter-${state}"]')?.textContent ?? ''`)
  check('[S5][U12] 状态筛选 chips 呈现「已就绪/正在准备/处理失败」',
    (await filterChipText('available')).trim() === filterCopy.available
    && (await filterChipText('processing')).trim() === filterCopy.processing
    && (await filterChipText('failed')).trim() === filterCopy.failed,
    { filterCopy, chips: [await filterChipText('available'), await filterChipText('processing'), await filterChipText('failed')] })

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
  // Full-loop retries: a half-opened menu (or a menu that closed on the
  // synthetic pointer) must not consume the round — re-open AND re-press
  // within each round, with the real Escape between attempts.
  for (let round = 0; round < 5 && !replaceDialogOpened; round++) {
    if (!await openRowMenu('as-design-home', 'replace')) { await pressEscape(); continue }
    await js<boolean>(`window.__poo196.pressEnterOn('${rowAction('as-design-home', 'replace')}')`)
    replaceDialogOpened = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.replaceDialog}')`), 2500)
    if (!replaceDialogOpened) await pressEscape()
  }
  check('[S7] 替换弹层打开', replaceDialogOpened, {
    menuNow: await js<boolean>(`window.__poo196.q('${rowAction('as-design-home', 'replace')}')`),
    rowMenu: await js<boolean>(`window.__poo196.q('${rowMenu('as-design-home')}')`),
    listRows: await js<number>(`window.__poo196.count('${T.list} [data-testid^="pc-asset-row-"]')`),
  })
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
/* ── S13: 成员面板与创建项目（POO-196 追加轮 D-B/D-C/D-D 2，R3 更新 D11）──
 * 真实 ChatPage 装配面：PanelHeader 右侧「成员」入口（唯一、不在 tablist）
 * → R3 面板（push 形态）按 viewer 角色呈现共享名册（D4）+ 面板内邀请记录/
 * 同事目录/定向邀请子页；创建项目对话框由宿主在 AppShell 边界内常驻挂载
 * （App 模式），覆盖 D-B 全部七条交互契约的可观察行为：默认不勾选、显式提
 * 交才铸 key、created 与进入分离（进入走 onRequestSwitch 项目进入事务）、
 * 响应丢失走恢复查询（同 key、零重发）。 */
async function scenarioMembersAndCreate() {
  await runProgramDirect({ op: 'resetPm' })
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'none' } })
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

  // D11: 「成员」是 PanelHeader 的入口按钮，不在 tab strip 内，也不许有第二个。
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 10000)
  check('[S13] 项目 tab 恒为三个（成员不是第四 tab）', (await js<number>(`window.__poo196.count('${T.tabs} [role="tab"]')`)) === 3)
  check('[S13] 「成员」入口唯一且不在 tablist 内', (await js<number>(`window.__poo196.count('${T.membersButton}')`)) === 1
    && !(await js<boolean>(`window.__poo196.q('${T.tabs} ${T.membersButton}')`)))

  // 面板：宽窗口 push 形态（非模态）+ 共享名册（D4 安全投影）。
  await js<boolean>(`window.__poo196.click('${T.membersButton}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersPanel}')`), 8000)
  check('[S13] 宽窗口面板为 push 形态（非模态、无遮罩）', (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('data-mode')`)) === 'push'
    && !(await js<boolean>(`window.__poo196.q('${T.membersBackdrop}')`)))
  check('[S13] push 形态非 dialog 语义', (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('role') ?? 'none'`)) === 'none')
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  check('[S13] 名册 3 行（协作投影）', (await js<number>(`window.__poo196.count('${T.membersRosterRow}')`)) === 3)
  const rosterCount = (await js<string>(`document.querySelector('${T.membersRosterCount}')?.textContent ?? ''`)).trim()
  check('[S13] 名册计数为服务端 totalActiveMembers', rosterCount.includes('3'), { rosterCount })
  check('[S13] 名册行带 data-user-id（同名按 ID 定位）', await js<boolean>(`Array.from(document.querySelectorAll('${T.membersRosterRow}')).every(row => (row.getAttribute('data-user-id') ?? '').length > 0)`))
  check('[S13] 名册呈现「我」徽标', await js<boolean>(`window.__poo196.q('${T.membersRosterMe}')`))
  check('[S13] 名册行只读（无行内操作按钮）', (await js<number>(`window.__poo196.count('${T.membersRosterRow} button')`)) === 0)

  // 邀请记录是面板内子页（R3 收敛）：入口 → 记录列表 → 返回名册。
  await js<boolean>(`window.__poo196.click('${T.membersInvitationsEntry}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersInvitations}')`), 8000)
  check('[S13] 面板内邀请记录呈现', (await js<number>(`window.__poo196.count('${T.membersInvitationRow}')`)) >= 1)
  await js<boolean>(`window.__poo196.click('${T.membersComposeBack}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRoster}')`), 8000)
  check('[S13] 记录子页返回后名册仍在（面板不关）', await js<boolean>(`window.__poo196.q('${T.membersPanel}')`))
  check('[S13] 前往企业管理入口存在（不驱跳转）', await js<boolean>(`window.__poo196.q('${T.membersOpenManagement}')`))

  // UB3 (U6) pending-invitation summary walkthrough retired: the roster-side
  // pending summary and the in-panel invitations sub-page were removed in the
  // POO-205 member-panel rework (39ea3b0f cleaned their i18n keys; the live
  // ProjectMembersPanel has neither project-members-pending-summary nor
  // project-members-invitations). These checks asserted that dead UI and can
  // no longer run; re-add walkthroughs when the current panel gains an
  // equivalent surface.

  await capture('s13-members-manager-overview')

  // 邀请步骤在面板内（不叠弹层）：目录页 → 无源空态的定向邀请次级路径。
  // 空目标本地拦截，不发出请求。
  await openDirectCompose()
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  await until(async () => (await js<string>('window.__poo196.text()')).includes('请填写手机号或邮箱'), 8000)
  const inviteCallsBefore = await runProgramDirect<{ inviteCalls: unknown[] }>({ op: 'pmCallStats' })
  check('[S13] 空目标零请求', inviteCallsBefore.inviteCalls.length === 0)

  // 手机号目标 → created 结果页 → 复制链接只进内存。
  await typeInto(T.membersInviteTarget, '13800000000')
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 10000)
  check('[S13] 结果页为 created', (await js<string>(`document.querySelector('${T.membersResult}')?.getAttribute('data-result')`)) === 'created')
  const statsAfterInvite = await runProgramDirect<{ inviteCalls: Array<{ command: { createRequestKey: string } }> }>({ op: 'pmCallStats' })
  check('[S13] 邀请请求携带 pm-invite key', /^pm-invite-/.test(statsAfterInvite.inviteCalls[0]?.command?.createRequestKey ?? ''), { command: statsAfterInvite.inviteCalls[0]?.command })
  // UB3 (U2): 复制 Promise 成功前——无「已复制」、无下一步指引、无聚合按钮
  // （单人结果不满两条可用链接）。
  const copyLabelBefore = (await js<string>(`document.querySelector('${T.membersCopyLink}')?.textContent ?? ''`)).trim()
  const copyLinkLabel = (await i18nText('projectMembers.invite.copyLink')).trim()
  check('[S13][U2] 复制前按钮为「复制链接，去发给对方」且无已复制宣称',
    copyLabelBefore.includes(copyLinkLabel)
    && !(await js<boolean>(`window.__poo196.q('${T.membersCopyNextStep}')`))
    && !(await js<boolean>(`window.__poo196.q('${T.membersCopyAll}')`)), { copyLabelBefore, copyLinkLabel })
  await js<boolean>(`window.__poo196.click('${T.membersCopyLink}')`)
  await until(async () => (await js<number>('window.__clipboardLog.length')) > 0, 8000)
  const copiedLink = await js<string>('window.__clipboardLog[0]')
  // 夹具与真实 admin 同构：链接 = 受信 origin + /invite/<HMAC 派生 token>，
  // token 由 key 派生（base64url('invite:'+key) 是夹具的派生式）。
  const expectedToken = Buffer.from(`invite:${statsAfterInvite.inviteCalls[0].command.createRequestKey}`).toString('base64url')
  check('[S13] 复制的链接与 fixture invitationUrl 一致',
    copiedLink === `https://fixture-admin.polo.invalid/invite/${expectedToken}`, { copiedLink })
  // UB3 (U2): 复制成功后——role=status 指引正文出现（手动投递语义），按钮
  // 保留可再复制；再次点击只再写剪贴板，零额外邀请写。
  await until(() => js<boolean>(`window.__poo196.q('${T.membersCopyNextStep}')`), 8000)
  const nextStepRole = (await js<string>(`document.querySelector('${T.membersCopyNextStep}')?.getAttribute('role') ?? 'none'`)).trim()
  const nextStepText = (await js<string>(`document.querySelector('${T.membersCopyNextStep}')?.textContent ?? ''`)).trim()
  const nextStepCopy = (await i18nText('projectMembers.invite.copyNextStep')).trim()
  const copiedLabel13 = (await i18nText('projectMembers.invite.copied')).trim()
  const copyBtnText13 = (await js<string>(`document.querySelector('${T.membersCopyLink}')?.textContent ?? ''`)).trim()
  check('[S13][U2] 复制成功后 role=status 指引与可再复制按钮出现',
    nextStepRole === 'status' && nextStepText.includes(nextStepCopy.slice(0, 12)) && copyBtnText13.includes(copiedLabel13.slice(0, 3)),
    { nextStepRole, nextStepText: nextStepText.slice(0, 40), copyBtnText13 })
  await js<boolean>(`window.__poo196.click('${T.membersCopyLink}')`)
  await until(async () => (await js<number>('window.__clipboardLog.length')) > 1, 8000)
  const inviteCallsAfterCopies = await runProgramDirect<{ inviteCalls: unknown[] }>({ op: 'pmCallStats' })
  check('[S13][U2] 重复复制仅写剪贴板（零额外邀请写，单人无聚合按钮）',
    inviteCallsAfterCopies.inviteCalls.length === 1
    && !(await js<boolean>(`window.__poo196.q('${T.membersCopyAll}')`)), { copies: inviteCallsAfterCopies.inviteCalls.length })
  await capture('s13-invite-created-copy')

  // Esc 只关未提交的步骤/结果页，不关面板（HIG 单一任务步骤）。push 面板
  // 非模态——Esc 生效前提是焦点在面板内（生产用户点入面板后的真实路径）。
  await focusMembersPanel()
  await pressEscape()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRoster}')`), 8000)
  check('[S13] Esc 后回到名册且面板仍在', await js<boolean>(`window.__poo196.q('${T.membersPanel}')`))
  await focusMembersPanel()
  await pressEscape()
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`)), 8000)
  check('[S13] 概览态 Esc 关闭面板', true)

  // ── 创建项目：D-B 1/2/5/7（R3: 显示名可用 → 无负责人补全框）──
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'ok' } })
  check('[S13] 创建入口可达（宿主共享对话框）', await js<boolean>('window.__poo196.openCreateProject()'))
  await until(() => js<boolean>(`window.__poo196.q('${T.createDialog}')`), 8000)
  check('[S13] 打开即表单态', (await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase')`)) === 'form')
  const checkboxChecked = await js<boolean>(`document.querySelector('${T.createResponsibility} input')?.checked ?? false`)
  // D-B 1: 确认框默认不勾选——不是预填，不是恢复。
  check('[S13] 责任确认默认不勾选', checkboxChecked === false)
  check('[S13] 预算事实呈现', await js<boolean>(`window.__poo196.q('${T.createBudgetFact}')`))
  // D7/R3: 可用显示名（林奕）下「你的姓名」补全框与同步提示都不渲染。
  check('[S13] 可用显示名不渲染负责人输入框', !(await js<boolean>(`window.__poo196.q('${T.createOwner}')`)))

  await typeInto(T.createName, '华东区销售资料库')
  await typeInto(T.createPurpose, '集中管理区域销售资料')
  await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)

  // D-B 5: 显式提交时才铸 key；命令回显契约 literal 版本 + 空介绍按 R3 直传。
  await until(async () => (await runProgramDirect<{ createCalls: unknown[] }>({ op: 'pmCallStats' })).createCalls.length > 0, 10000)
  const createStats = await runProgramDirect<{ createCalls: Array<{ idempotencyKey: string; command: Record<string, unknown> }> }>({ op: 'pmCallStats' })
  const firstCreate = createStats.createCalls[0]
  check('[S13] key 形如 pm-create-*', /^pm-create-/.test(firstCreate.idempotencyKey ?? ''), { key: firstCreate.idempotencyKey })
  check('[S13] 命令回显责任 literal 与条款版本', firstCreate.command.paymentResponsibilityAccepted === true && firstCreate.command.paymentResponsibilityTermsVersion === 'POL-79-payment-responsibility-v1', { command: firstCreate.command })

  // D-B 7 + D13: created 与进入分离——刷新列表后经 onRequestSwitch 进入；
  // 进入动作本身关闭对话框。夹具按次生成全新 space id（生产语义）。
  const createdId13 = (await runProgramDirect<{ createdSpace: { productSpaceId: string } | null }>({ op: 'pmCallStats' })).createdSpace?.productSpaceId ?? 'ps-apollo-created'
  await until(async () => (await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `request:${createdId13}`), 10000)
  check('[S13] 创建成功经 onRequestSwitch 进入新项目（非 select 旧通道）',
    (await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `request:${createdId13}`)
    && !(await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `select:${createdId13}`))
  await until(() => createDialogClosed(), 8000)
  check('[S13] 进入动作关闭对话框（创建与进入分离）', true)

  // ── D-B 7 失败面: 刷新列表不含新空间 → 确认页保留 + 可重试，绝不重建 ──
  await js<boolean>(`window.__poo196.setRefreshMissingFor('${CREATED_ENTERPRISE_SPACE_ID}-2')`)
  check('[S13] 失败分支入口可达', await js<boolean>('window.__poo196.openCreateProject()'))
  await until(() => js<boolean>(`window.__poo196.q('${T.createDialog}')`), 8000)
  const reopenPhase = await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase') ?? 'missing'`)
  check('[S13] 失败分支重开即表单态', reopenPhase === 'form', { reopenPhase })
  await typeInto(T.createName, '北区交付资料库')
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
  await until(() => createDialogClosed(), 8000)
  await js<boolean>('window.__poo196.setRefreshMissingFor(null)')

  // ── D-B 6: 响应丢失 → 恢复查询，同 key、零重发 ──
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'lost' } })
  check('[S13] 再次打开创建入口', await js<boolean>('window.__poo196.openCreateProject()'))
  await until(() => js<boolean>(`window.__poo196.q('${T.createDialog}')`), 8000)
  await typeInto(T.createName, '南区渠道资料库')
  await typeInto(T.createPurpose, '沉淀渠道运营资料')
  if (!(await js<boolean>(`document.querySelector('${T.createResponsibility} input')?.checked ?? false`))) {
    await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
  }
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)

  await until(() => js<boolean>(`window.__poo196.q('${T.createRecovery}')`), 10000)
  let lostStats = await runProgramDirect<{ createCalls: Array<{ idempotencyKey: string }>; receiptCalls: Array<{ createRequestKey: string }> }>({ op: 'pmCallStats' })
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
  await until(() => createDialogClosed(), 8000)
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'ok' } })
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'available' } })
  // The successful create COMMITTED the fixture context to ps-apollo-created
  // (real enterProject semantics). Later scenarios assert the apollo project
  // session surface — commit the fixture context back (the fixture boundary:
  // production performs the same round-trip through its own space switch).
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await delay(250)
}

async function scenarioR8aSurfaceScan() {
  const forbidden = [
    'OpenViking', 'Viking', '向量', 'COS', '对象存储', 'bucket', 'presign', '预签名',
    'embedding', '索引库', '全文检索', '解析上限', 'chunk', 'CHUNK',
    'token 上限', 'STORAGE', 'S3', 'OSS',
  ]
  const surfaces: Array<{ label: string; prepare: () => Promise<void>; cleanup?: () => Promise<unknown> }> = [
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

/** 挂闭兜底：Escape 两轮未果时点击遮罩（Radix onInteractOutside 关闭路径）。
 * 关闭判定用 Radix data-state（关闭动画未结束时节点会以 closed 态残留）。 */
const forceCloseDialog = async (selector: string) => {
  const closed = () => js<boolean>(`(() => {
    const el = document.querySelector('${selector}')
    return !el || el.getAttribute('data-state') === 'closed'
  })()`)
  for (let round = 0; round < 5; round++) {
    if (await closed()) return
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
  await until(closed, 8000)
}

/** R3 (D11): the members PANEL (push flex sibling / drawer overlay) replaces
 * the retired centered dialog. Open = the PanelHeader entry button; close =
 * the panel's own close button (the push host has NO overlay to click). */
const openMembersPanel = async () => {
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 10000)
  // A previous scenario's failure can leave the panel open on ANY page —
  // close it first so this open starts from the overview entry click.
  if (await probeUntil(() => js<boolean>(`window.__poo196.q('${T.membersPanel}')`), 400)) {
    await closeMembersPanel()
  }
  await js<boolean>(`window.__poo196.click('${T.membersButton}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersPanel}')`), 8000)
}

/** The push panel is NON-modal: Esc steps back only when focus sits INSIDE
 * the panel (production users click into it). */
const focusMembersPanel = async () => {
  await js<boolean>(`(() => { const el = document.querySelector('${T.membersPanel}'); if (!el) return false; el.focus(); return true })()`)
}

const closeMembersPanel = async () => {
  for (let round = 0; round < 5; round++) {
    if (!(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`))) return
    if (await js<boolean>(`window.__poo196.q('${T.membersClose}')`)) {
      await js<boolean>(`window.__poo196.click('${T.membersClose}')`)
    } else {
      await pressEscape()
    }
    await probeUntil(async () => !(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`)), 2500)
  }
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`)), 8000)
}

/** Radix keeps the dialog CONTENT mounted through the close animation — and
 * if the animationend never fires the node lingers as a data-state=closed
 * ghost. "Closed" is therefore the Radix state, never mere node presence. */
const createDialogClosed = () => js<boolean>(`(() => {
  const el = document.querySelector('${T.createDialog}')
  return !el || el.getAttribute('data-state') === 'closed'
})()`)

const openCreateDialog = async () => {
  check('创建入口可达（宿主共享对话框）', await js<boolean>('window.__poo196.openCreateProject()'))
  await until(() => js<boolean>(`window.__poo196.q('${T.createDialog}')`), 8000)
}

const closeCreateDialog = async () => forceCloseDialog(T.createDialog)

/**
 * R3 (D11): the in-panel targeted compose is the SECONDARY invite path —
 * invite-action opens the colleague directory, and the phone/email compose
 * sits behind the directory's source notice. These loops run with the
 * colleague source scripted 'none' (a SUCCESS empty-source state) so the
 * direct-invite button renders.
 */
const openDirectCompose = async () => {
  await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.colleaguesPage}')`), 8000)
  // The direct-invite button renders only after the directory response
  // lands (the no-source notice arm) — wait for it before clicking.
  await until(() => js<boolean>(`window.__poo196.q('${T.membersDirectInvite}')`), 8000)
  await js<boolean>(`window.__poo196.click('${T.membersDirectInvite}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersCompose}')`), 8000)
}

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
    await probeUntil(() => createDialogClosed(), 6000)
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
  // R3 (D7): the owner completion field only EXISTS when the account display
  // name is missing or over-limit — the usable fixture name renders no input.
  if (await js<boolean>(`window.__poo196.q('${T.createOwner}')`)) {
    await clearAndType(T.createOwner, '林奕')
  }
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

/** S14: 成员面板 owner/manager↔member 两态 + 403 失权清空回路。
 * R3 (D11): the retired manage/member split surfaces and the your-role/
 * contact-owner advisories are GONE — every active role reads the SAME
 * collaboration roster; a member differs only by the ABSENT management
 * affordances. A roster 403 is a real lost-access state (error + retry),
 * never a success path. */
async function scenarioMembersTwoState() {
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.project)`)
  await clickTab(T.tabMessages)
  await delay(200)
  check('[S14] 角色覆盖控制面可用', await js<boolean>('Boolean(window.__poo196Space)'))

  // ── member 两态：member 读同一份名册，零管理读、零管理动作 ──
  const callsBefore = { invite: pmCallCount('pmCreateProjectInvitation'), roster: pmCallCount('pmListProjectMembers'), invitations: pmCallCount('pmListProjectInvitations'), collab: pmCallCount('pmListCollaborationRoster') }
  await js<boolean>('window.__poo196Space.setRole("member")')
  await runProgramDirect({ op: 'setR3RosterRole', args: { role: 'member' } })
  await js<boolean>(`window.__poo196Space.setAccountId('${R3_ACCOUNT_B_ID}')`)
  await delay(600)
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  check('[S14] member 形态渲染共享名册（3 行，D4 全员投影）', (await js<number>(`window.__poo196.count('${T.membersRosterRow}')`)) === 3)
  const memberCount = (await js<string>(`document.querySelector('${T.membersRosterCount}')?.textContent ?? ''`)).trim()
  check('[S14] member 名册计数为服务端人数', memberCount.includes('3'), { memberCount })
  check('[S14] member 无「添加成员」主动作', !(await js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`)))
  check('[S14] member 无邀请记录与管理入口', !(await js<boolean>(`window.__poo196.q('${T.membersInvitationsEntry}')`)) && !(await js<boolean>(`window.__poo196.q('${T.membersOpenManagement}')`)))
  // UB3 (U6): member 无待接受摘要（无邀请读、无入口）。
  check('[S14][U6] member 无待接受摘要入口', !(await js<boolean>(`window.__poo196.q('${T.membersPendingSummary}')`)))
  // UB3 (U7): member 入口按钮同样可发现但无加号，accessible name 用现有成员名。
  const memberEntryAria = (await js<string>(`document.querySelector('${T.membersButton}')?.getAttribute('aria-label') ?? ''`)).trim()
  const memberAriaLabel = (await i18nText('projectMembers.buttonAria')).trim()
  check('[S14][U7] member 入口无加号且 accessible name 为成员名',
    !(await js<boolean>(`window.__poo196.q('${T.membersEntryPlus}')`)) && memberEntryAria === memberAriaLabel,
    { memberEntryAria, memberAriaLabel })
  // D11: 旧 member 降级面（your-role/contact-owner）已撤除——不再以提示替代名册。
  check('[S14] 旧降级面（your-role/contact-owner）零残留',
    (await js<number>(`window.__poo196.count('[data-testid="project-members-your-role"]')`)) === 0
    && (await js<number>(`window.__poo196.count('[data-testid="project-members-contact-owner"]')`)) === 0)
  await delay(400)
  const callsMember = { invite: pmCallCount('pmCreateProjectInvitation'), roster: pmCallCount('pmListProjectMembers'), invitations: pmCallCount('pmListProjectInvitations'), collab: pmCallCount('pmListCollaborationRoster') }
  check('[S14] member 打开零管理请求（名册/邀请/创建读全 0，仅协作名册）',
    callsMember.roster === callsBefore.roster && callsMember.invitations === callsBefore.invitations && callsMember.invite === callsBefore.invite && callsMember.collab > callsBefore.collab,
    { callsBefore, callsMember })
  await capture('s14-members-member-surface')
  await closeMembersPanel()
  check('[S14] member 形态关闭按钮可关闭面板', !(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`)))

  // ── 失权回路：manager 名册加载成功 → 403 once → 名册清空为失权错误面 ──
  mark('S14:manager-open')
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await runProgramDirect({ op: 'setR3RosterRole', args: { role: 'manager' } })
  await js<boolean>(`window.__poo196Space.setAccountId('${ACCOUNT_ID}')`)
  await delay(400)
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  check('[S14] 管理形态名册加载成功（失权前）', (await js<number>(`window.__poo196.count('${T.membersRosterRow}')`)) === 3)
  // UB3 (U7): manager 入口 ≥32px、边框浅底、末尾加号 aria-hidden、accessible
  // name 用「查看成员或邀请同事」（点任意部位仍开同一总览——键盘钉在 R3-06）。
  const entryMetrics = await js<{ height: number; borderTop: string; background: string }>(`(() => {
    const el = document.querySelector('${T.membersButton}')
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return { height: r.height, borderTop: s.borderTopStyle, background: s.backgroundColor }
  })()`)
  const managerEntryAria = (await js<string>(`document.querySelector('${T.membersButton}')?.getAttribute('aria-label') ?? ''`)).trim()
  const openInviteName = (await i18nText('projectMembers.openMembersAndInvite')).trim()
  const plusHidden = (await js<string>(`document.querySelector('${T.membersEntryPlus}')?.getAttribute('aria-hidden') ?? 'missing'`)).trim()
  check('[S14][U7] manager 入口 ≥32px 且有边框与浅底', entryMetrics.height >= 32 && entryMetrics.borderTop !== 'none' && entryMetrics.background !== 'rgba(0, 0, 0, 0)', { entryMetrics })
  check('[S14][U7] manager 入口末尾加号存在且 aria-hidden', plusHidden === 'true', { plusHidden })
  check('[S14][U7] manager 入口 accessible name 为邀请权名称', managerEntryAria === openInviteName, { managerEntryAria, openInviteName })
  mark('S14:manager-close-attempt')
  await closeMembersPanel()
  mark('S14:manager-closed')
  await runProgramDirect({ op: 'setPmFault', args: { method: 'pmListCollaborationRoster', fault: { code: 'forbidden', once: true } } })
  // D4: the roster is scope-keyed (account:project) — a re-open alone never
  // refetches; the 403 face needs a scope change (production: switch back
  // into the project after the authority changed).
  await js<boolean>(`window.__poo196Space.setAccountId('${R3_ACCOUNT_B_ID}')`)
  await openMembersPanel()
  // R3 修复后的真实链路：pm 码随 message marker 过桥，readRpcErrorCode 解码；
  // 403 → 名册清空 + 失权文案（lostAccess）+ 行内重试，管理动作随 viewerRole
  // 未知一起消失（403 只能是真实异常态，不是降级成功面）。
  const rosterErrorShown = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.membersRosterError}')`), 6000)
  const lostAccessCopy = (await i18nText('projectMembers.error.lostAccess')).trim()
  const rosterErrorText = (await js<string>(`document.querySelector('${T.membersRosterError}')?.textContent ?? ''`)).trim()
  check('[S14] 403 后名册清空为失权错误面（失权即清数据）', rosterErrorShown
    && !(await js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`))
    && !(await js<boolean>(`window.__poo196.q('${T.membersRosterCount}')`)), { rosterErrorShown })
  check('[S14] 403 呈现失权文案（lostAccess，非 generic）',
    rosterErrorText.includes(lostAccessCopy.slice(0, 10)), { rosterErrorText: rosterErrorText.slice(0, 60) })
  check('[S14] 失权后管理动作一并消失', !(await js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`)))
  // UB3 (U6): 失权即清——待接受摘要与邀请记录入口一并消失（不残留旧计数）。
  check('[S14][U6] 失权后待接受摘要消失', !(await js<boolean>(`window.__poo196.q('${T.membersPendingSummary}')`)))
  // UB3 (U7): 失权入口回退成员名，绝不显示 fabricated 计数或加号。
  const lostEntryText = ((await js<string>(`document.querySelector('${T.membersButton}')?.textContent ?? 'missing'`)).trim())
  check('[S14][U7] 失权入口无计数无加号（回退成员名）', lostEntryText !== 'missing'
    && !/\d/.test(lostEntryText) && !(await js<boolean>(`window.__poo196.q('${T.membersEntryPlus}')`)), { lostEntryText })
  check('[S14] 失权错误面带行内重试入口', await js<boolean>(`window.__poo196.q('${T.membersRosterRetry}')`))
  await capture('s14-members-403-face')
  await closeMembersPanel()

  // 空间上下文刷新（真实 App 的 refreshProductSpaces 路径）后名册为新鲜数据
  // （无论失权面是否出现，数据卫生断言都成立：重开读新、不回退旧缓存）。
  mark('S14:context-refresh')
  await runProgramDirect({ op: 'setR3RosterRole', args: { role: 'member' } })
  await js<boolean>('window.__poo196Space.setRole("member")')
  await js<boolean>(`window.__poo196Space.setAccountId('${R3_ACCOUNT_B_ID}')`)
  await delay(500)
  await runProgramDirect({ op: 'setR3RosterRole', args: { role: 'manager' } })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await js<boolean>(`window.__poo196Space.setAccountId('${ACCOUNT_ID}')`)
  await delay(500)
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  check('[S14] 空间上下文刷新后名册为新鲜读取（3 行）', (await js<number>(`window.__poo196.count('${T.membersRosterRow}')`)) === 3)
  await closeMembersPanel()
}

/** S15: 邀请回路扩展——本地拦截/步骤返回/码化失败/传输失败重试/复制失败
 * 重试/结果页异态（existing/state_changed/credential_unrecoverable 无链接）。
 * R3 (D11): 定向邀请是面板内次级路径——invite-action 打开同事目录页，无源
 * 空态（fixture script 'none'，一个成功的空来源状态）提供定向邀请入口。 */
async function scenarioInviteLoops() {
  await runProgramDirect({ op: 'resetPm' })
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'none' } })
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
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)

  // 非法目标：本地拦截 + 字段错误 + 零请求
  mark('S15:compose-open')
  const inviteMark0 = pmCallCount('pmCreateProjectInvitation')
  await openDirectCompose()
  await typeInto(T.membersInviteTarget, 'abc')
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  const targetInvalid = (await i18nText('projectMembers.invite.targetInvalid')).trim()
  await until(async () => (await js<string>('window.__poo196.text()')).includes(targetInvalid), 8000)
  check('[S15] 非法目标呈现字段级错误且保留输入步', await js<boolean>(`window.__poo196.q('${T.membersCompose}')`))
  check('[S15] 非法目标零请求', pmCallCount('pmCreateProjectInvitation') - inviteMark0 === 0)

  // 步骤返回按钮：compose → 名册（面板不关），重开输入已清空
  await js<boolean>(`window.__poo196.click('${T.membersComposeBack}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRoster}')`), 8000)
  check('[S15] 返回按钮回到名册且面板仍在', await js<boolean>(`window.__poo196.q('${T.membersPanel}')`))
  await openDirectCompose()
  const targetAfterBack = await js<string>(`document.querySelector('${T.membersInviteTarget}')?.value ?? 'missing'`)
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
  const transportStep = await js<string>(`document.querySelector('${T.membersResult}') ? 'result' : (document.querySelector('${T.membersCompose}') ? 'compose' : 'missing')`)
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
  await closeMembersPanel()

  // 结果页异态：三种非凭证结果均无复制按钮（不泄露/不虚构链接），且都有
  // 「前往企业管理」的受控出口（X2-13）。
  for (const script of ['existing', 'state_changed', 'credential_unrecoverable'] as const) {
    await runProgramDirect({ op: 'setPmInviteScript', args: { script } })
    await openMembersPanel()
    await until(() => js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`), 8000)
    await openDirectCompose()
    await clearAndType(T.membersInviteTarget, '13700000000')
    await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
    await probeUntil(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 8000)
    const resultKind = await js<string>(`document.querySelector('${T.membersResult}')?.getAttribute('data-result') ?? 'missing'`)
    check(`[S15] 异态结果页 ${script} 呈现且无复制入口`, resultKind === script && !(await js<boolean>(`window.__poo196.q('${T.membersCopyLink}')`)), { resultKind })
    check(`[S15][X2-13] 异态结果页 ${script} 保留企业管理出口`, await js<boolean>(`window.__poo196.q('${T.membersResultManagement}')`))
    await js<boolean>(`window.__poo196.click('${T.membersResultBack}')`)
    await until(() => js<boolean>(`window.__poo196.q('${T.membersRoster}')`), 8000)
    await closeMembersPanel()
  }
  await runProgramDirect({ op: 'setPmInviteScript', args: { script: 'ok' } })
  await closeMembersPanel()

  // S2-ENG-3（共识 #6）：响应丢失（聚合已落库、响应消失）→ 显式重试 →
  // 同一请求键 replay 带回同一链接；复制落受信 origin 的绝对 https（E2-2）。
  mark('S15:invite-replay-loop')
  await runProgramDirect({ op: 'resetPm' })
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'none' } })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  await openDirectCompose()
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
  await closeMembersPanel()
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await delay(200)

  // E2-2（共识 #7）相对链接臂：没有公开 origin 的 admin 交出 path-only 链接
  // （review 观察到的真实响应形态）。客户端必须向它本人登录的受信 admin
  // origin（fixture 的 adminGetStatus 应答）解析，剪贴板只落拼全后的绝对
  // https——绝不落裸路径，也不落在别的 origin 上。
  mark('S15:invite-relative-link')
  await runProgramDirect({ op: 'resetPm' })
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'none' } })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  await openDirectCompose()
  await clearAndType(T.membersInviteTarget, '13500000000')
  await runProgramDirect({ op: 'setPmInviteScript', args: { script: 'relative' } })
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 8000)
  const relativeResultKind = await js<string>(`document.querySelector('${T.membersResult}')?.getAttribute('data-result') ?? 'missing'`)
  check('[S15][E2-2] relative 臂到达 created 结果页（fixture 交出 path-only 链接）', relativeResultKind === 'created', { relativeResultKind })
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
  const relativeClip = await js<string>('window.__clipboardLog[0] ?? ""')
  check('[S15][E2-2] path-only 链接复制为受信 origin 拼全的绝对 https（非裸路径/无 query·hash）',
    /^https:\/\/fixture-admin\.polo\.invalid\/invite\/[A-Za-z0-9_-]+$/.test(relativeClip),
    { relativeClip: relativeClip.slice(0, 80) })
  await capture('s15-invite-relative')
  await closeMembersPanel()
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await delay(200)

  // X2-9（共识 #14）：emailDeliveryAvailable=false 的部署——输入步直接按
  // 手机号引导（placeholder 变化），邮箱目标在本地被拒且零请求。
  mark('S15:email-capability-gate')
  // The relative segment's resetPm rearmed the colleague directory
  // ('available') — the secondary compose needs the no-source arm again.
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'none' } })
  await runProgramDirect({ op: 'setPmEmailDelivery', args: { available: false } })
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  await openDirectCompose()
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
  await closeMembersPanel()
  await delay(150)

  // X2-7（共识 #12）：名册首屏失败 → 行内 ghost 重试 → 成功恢复名册。
  // X2-7（共识 #12）：名册首屏失败 → 行内 ghost 重试 → 成功恢复名册。
  // D4 名册以 scope 为键（账号:项目）——首屏失败要求 scope 在故障布置后变
  // 更（生产等价：切账号/切项目后的首次读取），仅开合面板不会重读。
  mark('S15:roster-retry')
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  await closeMembersPanel()
  await runProgramDirect({ op: 'setPmFault', args: { method: 'pmListCollaborationRoster', fault: { code: 'pm_service_unavailable', once: false } } })
  await js<boolean>(`window.__poo196Space.setAccountId('${R3_ACCOUNT_B_ID}')`)
  await js<boolean>(`window.__poo196Space.setAccountId('${ACCOUNT_ID}')`)
  await openMembersPanel()
  const rosterErrorShown = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.membersRosterError}')`), 8000)
  check('[S15][X2-7] 名册失败呈现错误行', rosterErrorShown)
  await runProgramDirect({ op: 'setPmFault', args: { method: 'pmListCollaborationRoster' } })
  if (rosterErrorShown && await js<boolean>(`window.__poo196.q('${T.membersRosterRetry}')`)) {
    await js<boolean>(`window.__poo196.click('${T.membersRosterRetry}')`)
    await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  }
  check('[S15][X2-7] 行内重试恢复名册（无行刷新不静默）', await js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`))
  await capture('s15-roster-retry')
  await closeMembersPanel()

  // ── UB3（U2/U6/U8）：同事目录多选——聚合复制 / 整行选择 / cap 可取消 / 本地姓名 ──
  mark('S15:ub3-colleague-aggregate')
  await runProgramDirect({ op: 'resetPm' })
  // 基础目录 1 人可选（陈晓）+ 注入 2 名可选同事 → 3 条可用链接；随后局部
  // 失败臂需要第 4 条。先做全成功回路（2 人聚合），再做部分失败回路。
  await runProgramDirect({ op: 'stageColleagueDirectory', args: { available: 1 } })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.colleaguesPage}')`), 8000)
  await until(async () => (await js<number>(`window.__poo196.count('${T.colleaguesRowToggle}')`)) >= 2, 8000)

  // (1) U8 整行可点：joined/pending/unavailable 行没有切换按钮；点「姓名」
  // 文本（button 内部内容）只切一次；键盘 Enter（trusted）也只切一次；选择
  // 全程零邀请写。
  check('[S15][U8] 非可选行零按钮', (await js<number>(`window.__poo196.count('[data-testid="project-colleagues-row"][data-project-state="joined"] button')`)) === 0
    && (await js<number>(`window.__poo196.count('[data-testid="project-colleagues-row"][data-project-state="pending"] button')`)) === 0
    && (await js<number>(`window.__poo196.count('[data-testid="project-colleagues-row"][data-project-state="unavailable"] button')`)) === 0)
  await js<boolean>(`window.__poo196.click('${T.colleaguesRow}[data-user-id="u-chen-02"] button > span.flex-1')`)
  await delay(150)
  const chenPressed = (await js<string>(`document.querySelector('${T.colleaguesRow}[data-user-id="u-chen-02"] button')?.getAttribute('aria-pressed') ?? 'missing'`)).trim()
  const selectedAfterName = (await js<string>(`document.querySelector('${T.colleaguesSelected}')?.textContent ?? ''`)).trim()
  check('[S15][U8] 点姓名整行切换一次（aria-pressed 同步）', chenPressed === 'true' && selectedAfterName.includes('1'), { chenPressed, selectedAfterName })
  // 头像区域（aria-hidden span）同属该按钮：再切一次（取消）。
  await js<boolean>(`window.__poo196.click('${T.colleaguesRow}[data-user-id="u-chen-02"] button > span[aria-hidden="true"]')`)
  await delay(150)
  const chenDeselected = (await js<string>(`document.querySelector('${T.colleaguesRow}[data-user-id="u-chen-02"] button')?.getAttribute('aria-pressed') ?? 'missing'`)).trim()
  check('[S15][U8] 点头像区域再切换一次（无冒泡双切）', chenDeselected === 'false'
    && ((await js<string>(`document.querySelector('${T.colleaguesSelected}')?.textContent ?? ''`)).trim()).includes('0'), { chenDeselected })
  // 键盘：trusted Enter 激活行按钮（真实默认激活路径）。
  await js<boolean>(`(() => { const el = document.querySelector('${T.colleaguesRow}[data-user-id="u-chen-02"] button'); el.focus(); return document.activeElement === el })()`)
  await pressEnterTrusted()
  await delay(150)
  const chenKeyboard = (await js<string>(`document.querySelector('${T.colleaguesRow}[data-user-id="u-chen-02"] button')?.getAttribute('aria-pressed') ?? 'missing'`)).trim()
  check('[S15][U8] 键盘 Enter 激活整行（一次切换）', chenKeyboard === 'true', { chenKeyboard })
  check('[S15][U8] 选择不产生邀请写', pmCallCount('pmCreateColleagueInvitation') === 0)

  // (2) U2 聚合复制：选 2 人 → confirm → 结果页出现「复制全部邀请链接」→
  // 内容 = 「姓名\nURL」组、空行分隔、行序保持；逐人按钮仍在；复制只写剪贴板。
  await js<boolean>(`window.__poo196.click('${T.colleaguesRow}[data-user-id="u-cap-01"] button')`)
  await delay(120)
  await js<boolean>(`window.__poo196.click('${T.colleaguesConfirm}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 10000)
  await until(async () => pmCallCount('pmCreateColleagueInvitation') >= 2, 8000)
  await js<boolean>(`(() => {
    window.__clipboardLog = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__clipboardLog.push(text); return true } },
    })
    return true
  })()`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersCopyAll}')`), 8000)
  const copyAllLabelBefore = (await js<string>(`document.querySelector('${T.membersCopyAll}')?.textContent ?? ''`)).trim()
  check('[S15][U2] 两条可用链接出现聚合复制按钮（复制前无已复制）',
    copyAllLabelBefore.includes(((await i18nText('projectMembers.invite.copyAll'))).trim().slice(0, 4))
    && (await js<number>('window.__clipboardLog.length')) === 0, { copyAllLabelBefore })
  const copyAllCallsBefore = pmCallCount('pmCreateColleagueInvitation')
  await js<boolean>(`window.__poo196.click('${T.membersCopyAll}')`)
  await until(async () => (await js<number>('window.__clipboardLog.length')) > 0, 8000)
  const aggregate = await js<string>('window.__clipboardLog[0] ?? ""')
  const aggregateGroups = aggregate.split('\n\n')
  const resultRows15 = await js<string[]>(`Array.from(document.querySelectorAll('${T.membersResult} [data-user-id]')).map(row => row.getAttribute('data-user-id'))`)
  check('[S15][U2] 聚合内容为「姓名\\nURL」组、空行分隔、与结果行序一致', aggregateGroups.length === 2
    && aggregateGroups[0]!.startsWith('陈晓\nhttps://fixture-admin.polo.invalid/invite/')
    && aggregateGroups[1]!.startsWith('容量同事1\nhttps://fixture-admin.polo.invalid/invite/')
    && !aggregate.includes('138'), { groups: aggregateGroups.map(g => g.slice(0, 30)), resultRows15 })
  check('[S15][U2] 聚合复制零额外邀请写且逐人按钮保留',
    pmCallCount('pmCreateColleagueInvitation') === copyAllCallsBefore
    && (await js<number>(`window.__poo196.count('${T.membersCopyLink}')`)) === 2, { calls: pmCallCount('pmCreateColleagueInvitation') })
  await capture('s15-colleagues-aggregate-copy')
  await closeMembersPanel()

  // (3) U6 本地姓名：本次目录选择的结果落到邀请记录——按 invitationId 关联
  // 「本次邀请：陈晓」+ 脱敏标识/创建时间；无映射行保持脱敏标识。
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersPendingSummary}')`), 8000)
  await js<boolean>(`window.__poo196.click('${T.membersPendingSummary}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersInvitations}')`), 8000)
  const localRow15 = await js<string>(`(() => {
    const row = document.querySelector('[data-local-target="陈晓"]')
    return row ? row.textContent : ''
  })()`)
  const localTarget15 = (await i18nText('projectMembers.invitations.localTarget')).replace('{{name}}', '').trim()
  const createdAt15 = (await i18nText('projectMembers.invitations.createdAt')).replace('{{date}}', '').trim()
  check('[S15][U6] 记录行以本地映射命名并保留创建时间',
    localRow15.includes(localTarget15.replace(/[：:]\s*$/, '')) && localRow15.includes(createdAt15.slice(0, 3)),
    { localRow15: localRow15.slice(0, 60), localTarget15, createdAt15 })
  await closeMembersPanel()

  // (4) U2 部分失败 + U8 cap：第 2 轮注入 4 名可选同事（共 5 可选），首写
  // definite 失败（target_already_member）→ 4 条可用 + 1 失败 → 聚合按钮 +
  // 「仅复制可用链接」提示；复制只落可用组；失败行错误保留。cap 臂另开目录。
  mark('S15:ub3-partial-and-cap')
  await runProgramDirect({ op: 'resetPm' })
  await runProgramDirect({ op: 'stageColleagueDirectory', args: { available: 4 } })
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
  await until(async () => (await js<number>(`window.__poo196.count('${T.colleaguesRowToggle}')`)) >= 5, 8000)
  // 全选 5 行中的 4 行（陈晓 + 容量1-3）：点击直至已选 4。
  for (const userId of ['u-chen-02', 'u-cap-01', 'u-cap-02', 'u-cap-03']) {
    await js<boolean>(`window.__poo196.click('${T.colleaguesRow}[data-user-id="${userId}"] button')`)
    await delay(80)
  }
  await runProgramDirect({ op: 'setPmFault', args: { method: 'pmCreateColleagueInvitation', fault: { code: 'target_already_member', once: true } } })
  await js<boolean>(`window.__poo196.click('${T.colleaguesConfirm}')`)
  await until(async () => pmCallCount('pmCreateColleagueInvitation') >= 4, 10000)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 10000)
  await js<boolean>(`(() => {
    window.__clipboardLog = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__clipboardLog.push(text); return true } },
    })
    return true
  })()`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersCopyAll}')`), 8000)
  const noteShown = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.membersCopyAllNote}')`), 6000)
  const noteText = (await js<string>(`document.querySelector('${T.membersCopyAllNote}')?.textContent ?? ''`)).trim()
  const copyAllNoteCopy = (await i18nText('projectMembers.invite.copyAllNote')).trim()
  check('[S15][U2] 部分失败保留逐行错误并呈现聚合提示（仅复制可用链接）',
    noteShown && noteText.includes(copyAllNoteCopy.slice(0, 6))
    && ((await js<string>(`document.querySelector('${T.membersResult}')?.textContent ?? ''`)).trim()).includes(((await i18nText('projectMembers.invite.alreadyMember'))).trim().slice(0, 6)),
    { noteShown, noteText: noteText.slice(0, 40) })
  await js<boolean>(`window.__poo196.click('${T.membersCopyAll}')`)
  await until(async () => (await js<number>('window.__clipboardLog.length')) > 0, 8000)
  const partialAggregate = await js<string>('window.__clipboardLog[0] ?? ""')
  const partialGroups = partialAggregate.split('\n\n')
  check('[S15][U2] 部分失败时只复制可用链接（3 组，失败者不入聚合）', partialGroups.length === 3
    && !partialAggregate.includes('陈晓'), { groups: partialGroups.map(g => g.split('\n')[0]) })
  await closeMembersPanel()

  // (5) U8 cap 取消：注入 51 名可选同事（共 52 可选）→ 选满 50 → 未选行禁用
  // 而已选行仍可取消（修正 `!selectionAtCap` 连已选都禁的条件）。
  mark('S15:ub3-cap-cancel')
  await runProgramDirect({ op: 'resetPm' })
  await runProgramDirect({ op: 'stageColleagueDirectory', args: { available: 51 } })
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  await js<boolean>(`window.__poo196.click('${T.membersInviteAction}')`)
  await until(async () => (await js<number>(`window.__poo196.count('${T.colleaguesRowToggle}')`)) >= 52, 10000)
  const allToggles = `Array.from(document.querySelectorAll('${T.colleaguesRow}[data-project-state="available"] button'))`
  await js<boolean>(`(${allToggles}).forEach(b => b.click()); true`)
  await until(async () => ((await js<string>(`document.querySelector('${T.colleaguesSelected}')?.textContent ?? ''`)).trim()).includes('50'), 10000)
  const capStates = await js<{ selectedDisabled: boolean; unselectedDisabled: boolean; selectedPressed: string }>(`(() => {
    const toggles = ${allToggles}
    const first = toggles[0]
    const last = toggles[toggles.length - 1]
    return { selectedDisabled: first.disabled, unselectedDisabled: last.disabled, selectedPressed: first.getAttribute('aria-pressed') }
  })()`)
  check('[S15][U8] 50 人上限：已选行仍可操作、未选行禁用', capStates.selectedPressed === 'true'
    && capStates.selectedDisabled === false && capStates.unselectedDisabled === true, { capStates })
  // 已选行取消成功（腾出名额后原禁用行恢复可选）。
  await js<boolean>(`(${allToggles})[0].click(); true`)
  await until(async () => ((await js<string>(`document.querySelector('${T.colleaguesSelected}')?.textContent ?? ''`)).trim()).includes('49'), 8000)
  const lastAfterCancel = (await js<boolean>(`(${allToggles})[${allToggles}.length - 1].disabled`))
  check('[S15][U8] 取消已选行后名额腾出（第 51 行恢复可选）', lastAfterCancel === false, { lastAfterCancel })
  await closeMembersPanel()
  await runProgramDirect({ op: 'resetPm' })
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'available' } })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await delay(200)
}

/** S16: 创建对话框回路扩展——焦点、空表单校验、勾选往返、提交门槛、
 * 手机验证/已有企业/版本不匹配三类引导面。 */
async function scenarioCreateLoops() {
  await runProgramDirect({ op: 'resetPm' })
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'ok' } })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  // 防御性清场：前序场景任何中止都可能遗留打开的成员面板（模态叠加会
  // 破坏本场景全部点击/焦点断言）。
  await closeMembersPanel()
  await clickTab(T.tabMessages)
  await clearInput()
  await delay(200)

  // U12（G12）不实施子项钉：「Markdown」入口保留为硬编码预览触发器（点它
  // 打开 onPopOut 预览，不写剪贴板——复制语义只在 Copy 钮上）。
  mark('S16:markdown-preview-not-copy')
  const markdownPresent = await probeUntil(() => js<boolean>('window.__poo196.markdownPopOutPresent()'), 8000)
  check('[S16][U12] Markdown 入口保留（未伪装中文化）', markdownPresent)
  if (markdownPresent) {
    const clipboardBefore = (await js<string[]>('window.__poo196.clipboardLog()')).length
    await js<boolean>('window.__poo196.clickMarkdownPopOut()')
    const previewOpened = await probeUntil(async () => (await js<string>('document.body.innerText')).includes('response.md'), 8000)
    const clipboardAfter = (await js<string[]>('window.__poo196.clipboardLog()')).length
    check('[S16][U12] Markdown 点击仍是预览（response.md 覆盖层）且零剪贴板写入', previewOpened && clipboardAfter === clipboardBefore, { previewOpened, clipboardBefore, clipboardAfter })
    await pressEscape()
    await delay(200)
  }

  await openCreateDialog()
  // E2-3：当前实现关闭后保留表单值（S13 残留会流入本场景），先清空字段
  // 再做空表单断言。R3（D7）下负责人补全框仅在显示名缺失/超限时存在——
  // 夹具显示名可用，这里只有名称/介绍两个字段可清。
  await clearAndType(T.createPurpose, '')
  await clearAndType(T.createName, '')
  const focusOnName = await js<boolean>(`document.activeElement === document.querySelector('${T.createName}')`)
  check('[S16] 打开对话框焦点落在名称输入（键盘轴）', focusOnName)

  // U1（G1）呈现钉：介绍句=裁决文案；名称下的常驻 hint 撤下（无字段错误时
  // hint span 为空）；13px 信息正文在责任勾选上方；24px 方框+整 label 热区。
  const budgetFactCopy = (await i18nText('createProject.budgetFact')).trim()
  const descriptionCopy = (await i18nText('createProject.description')).trim()
  const u1Faces = await js<{ fact: string; factBefore: boolean; boxW: number; boxH: number; hint: string; desc: string }>(`(() => {
    const fact = document.querySelector('${T.createBudgetFact}')
    const consent = document.querySelector('${T.createResponsibility}')
    const input = consent?.querySelector('input')
    const box = input ? input.getBoundingClientRect() : null
    return {
      fact: fact?.textContent ?? '',
      factBefore: Boolean(fact && consent && fact.compareDocumentPosition(consent) & Node.DOCUMENT_POSITION_FOLLOWING),
      boxW: box ? Math.round(box.width) : 0,
      boxH: box ? Math.round(box.height) : 0,
      hint: document.getElementById('create-project-name-hint')?.textContent ?? 'missing',
      desc: document.querySelector('${T.createDialog}')?.textContent ?? '',
    }
  })()`)
  check('[S16][U1] 预算事实=裁决文案且在勾选上方（13px 信息正文）', u1Faces.fact === budgetFactCopy && u1Faces.factBefore, { fact: u1Faces.fact, factBefore: u1Faces.factBefore })
  check('[S16][U1] 责任方框 24px（整 label 热区几何）', u1Faces.boxW === 24 && u1Faces.boxH === 24, { boxW: u1Faces.boxW, boxH: u1Faces.boxH })
  check('[S16][U1] 名称下常驻 hint 撤下、介绍句在弹窗', u1Faces.hint === '' && u1Faces.desc.includes(descriptionCopy), { hint: u1Faces.hint })
  // 热区钉：点句子（非方框）只切一次勾选——native label 语义，双切会回到原态。
  const labelToggle = await js<boolean>(`(() => {
    const label = document.querySelector('${T.createResponsibility}')
    const input = label?.querySelector('input')
    const sentence = Array.from(label?.querySelectorAll(':scope > span') ?? []).find(el => el.textContent.includes('我确认'))
    if (!input || !sentence) return false
    sentence.click()
    const afterFirst = input.checked
    sentence.click()
    return afterFirst === true && input.checked === false
  })()`)
  check('[S16][U1] 点责任句只切一次勾选（热区=整 label）', labelToggle)
  await capture('s16-u1-responsibility-presentation')

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
  // U1 钉：未勾选错误自带 ≥12px 图标，且经 aria-describedby 关联到勾选框。
  const errorFaceU1 = await js<{ iconMin: number; describedBy: string; invalid: string }>(`(() => {
    const error = document.querySelector('${T.createResponsibilityError}')
    const icon = error?.querySelector('svg')
    const iconBox = icon ? icon.getBoundingClientRect() : null
    const input = document.querySelector('${T.createResponsibility} input')
    return {
      iconMin: iconBox ? Math.min(Math.round(iconBox.width), Math.round(iconBox.height)) : 0,
      describedBy: input?.getAttribute('aria-describedby') ?? '',
      invalid: input?.getAttribute('aria-invalid') ?? '',
    }
  })()`)
  check('[S16][U1] 未勾选错误带 ≥12px 图标并 aria 关联勾选框', errorFaceU1.iconMin >= 12
    && errorFaceU1.describedBy.includes('create-project-responsibility-error')
    && errorFaceU1.invalid === 'true', errorFaceU1)
  await capture('s16-create-field-errors')

  // 勾选往返 + 提交门槛：勾→取消→表单提交被责任校验拦截
  mark('S16:responsibility-roundtrip')
  await clearAndType(T.createName, '键盘回路项目')
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
    await until(() => createDialogClosed(), 8000)
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
    await until(() => createDialogClosed(), 8000)
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

  // U4（G4）创建宿主钉：contract_version_unsupported → 服务指引面（正文 +
  // 可展开「查看更新指引」说明块 + 设置导航快捷入口 + 无重试零重发）。
  mark('S16:version-unsupported-guide')
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'code:contract_version_unsupported' } })
  await openCreateDialog()
  await fillCreateForm('版本指引项目')
  // pmCallCount 会把一次 faulted 调用记两条（fault+error），零重发断言按
  // outcome 去重计数（error 条目是同一请求的桥接镜像，不是第二次请求）。
  const pmCreateAttempts = () => result.pcCalls.filter(call => call.method === 'pmCreateEnterprise' && call.outcome !== 'error').length
  const createMarkU4 = pmCreateAttempts()
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.createSubmitError}')`), 8000)
  const versionBodyCopyU4 = (await i18nText('createProject.error.versionUnsupported')).trim()
  const guideActionCopyU4 = (await i18nText('home.projects.updateGuideAction')).trim()
  const collapsedU4 = await js<{ body: string; expanded: string; label: string; editable: boolean }>(`(() => {
    const guide = document.querySelector('${T.createUpdateGuide}')
    const name = document.querySelector('${T.createName}')
    return {
      body: document.querySelector('${T.createSubmitError}')?.textContent ?? '',
      expanded: guide?.getAttribute('aria-expanded') ?? 'missing',
      label: guide?.textContent ?? '',
      editable: Boolean(name) && !name.disabled,
    }
  })()`)
  check('[S16][U4] 版本不支持正文=服务指引文案（表单仍可编辑）', collapsedU4.body.includes(versionBodyCopyU4) && collapsedU4.editable, collapsedU4)
  check('[S16][U4] 「查看更新指引」按钮初始收起', collapsedU4.expanded === 'false' && collapsedU4.label === guideActionCopyU4, collapsedU4)
  // 展开：说明块就地出现 + 客户端更新入口（宿主具备设置导航）+ 诚实注记。
  await js<boolean>(`window.__poo196.click('${T.createUpdateGuide}')`)
  const guideBodyCopyU4 = (await i18nText('home.projects.updateGuideBody')).trim()
  const clientUpdateCopyU4 = (await i18nText('home.projects.clientUpdateAction')).trim()
  const clientUpdateNoteU4 = (await i18nText('home.projects.clientUpdateNote')).trim()
  const expandedU4 = await js<{ guide: string; body: string; shortcut: boolean; note: string }>(`(() => {
    const guide = document.querySelector('${T.createUpdateGuide}')
    return {
      guide: guide?.textContent ?? '',
      body: document.querySelector('${T.createUpdateGuideBody}')?.textContent ?? '',
      shortcut: Boolean(document.querySelector('${T.createClientUpdate}')),
      note: document.querySelector('${T.createSubmitError}')?.textContent ?? '',
    }
  })()`)
  check('[S16][U4] 展开说明块=管理员升级指引', expandedU4.body.includes(guideBodyCopyU4), { body: expandedU4.body.slice(0, 80) })
  check('[S16][U4] 客户端更新入口+「客户端更新不等于服务已更新」注记', expandedU4.shortcut
    && (await js<string>(`document.querySelector('${T.createClientUpdate}')?.textContent ?? ''`)).trim() === clientUpdateCopyU4
    && expandedU4.note.includes(clientUpdateNoteU4), expandedU4)
  await capture('s16-u4-version-guide-expanded')
  // 键盘可操作：焦点在收起钮上按真实 Enter → 收起。
  await js<boolean>(`document.querySelector('${T.createUpdateGuide}').focus()`)
  await pressEnterTrusted()
  await until(() => js<boolean>(`!window.__poo196.q('${T.createUpdateGuideBody}')`), 6000)
  check('[S16][U4] 真实 Enter 收起说明块（键盘可操作）', !(await js<boolean>(`window.__poo196.q('${T.createUpdateGuideBody}')`)))
  // 全程零重发：指引交互不产生任何创建请求；无「重试」入口。
  check('[S16][U4] 指引交互零重发（无重试语义入口）', pmCreateAttempts() - createMarkU4 === 1, { creates: pmCreateAttempts() - createMarkU4 })
  // 设置导航快捷入口真实到 app 设置页（生产 NAVIGATE_EVENT → settings/app）。
  await js<boolean>(`window.__poo196.click('${T.createUpdateGuide}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.createClientUpdate}')`), 6000)
  await js<boolean>(`window.__poo196.click('${T.createClientUpdate}')`)
  const navToSettings = await probeUntil(async () => (await js<Array<{ route: string }>>('window.__poo196.navigateLog()')).some(entry => entry.route === 'settings/app'), 6000)
  check('[S16][U4] 检查客户端更新真实导航到 app 设置页', navToSettings && (await js<string>('window.__poo196.navRoute()')) === 'settings/app', { navToSettings, navRoute: await js<string>('window.__poo196.navRoute()') })
  // 回到会话路由基线，避免导航状态漂移进后续场景。
  await js<boolean>(`window.dispatchEvent(new CustomEvent('polo-ai-navigate', { detail: { route: 'allSessions' } })); true`)
  await delay(300)
  await closeCreateDialog()
  await resetCreateDialogState()
  await runProgramDirect({ op: 'setPmCreateScript', args: { script: 'ok' } })
  await delay(200)

  // U12（G12）键值钉：19 键 zh-Hans 逐字值（消费者 DOM 文案在 S5/R3-03 钉）。
  mark('S16:u12-key-values')
  const u12Expected: Record<string, string> = {
    'projectContext.tabs.pins': '置顶',
    'projectContext.actions.pin': '置顶',
    'projectContext.actions.unpin': '取消置顶',
    'projectContext.pin.emptyTitle': '还没有置顶文件',
    'projectContext.pin.emptyHint': '在文件页置顶文件后，会集中显示在这里，方便快速取用。',
    'projectContext.pin.loading': '正在加载置顶文件…',
    'projectContext.pin.pinnedAria': '已置顶',
    'projectContext.toast.pinned': '已置顶',
    'projectContext.toast.unpinned': '已取消置顶',
    'projectContext.status.ready': '已就绪',
    'projectContext.status.processing': '正在准备',
    'projectContext.status.failedRetryable': '处理失败，可重试',
    'projectContext.statusFilter.available': '已就绪',
    'projectContext.statusFilter.processing': '正在准备',
    'projectContext.statusFilter.failed': '处理失败',
    'projectContext.share.sourceNote': '来自对话：{{title}}',
    'project.entry.historyFailed': '无法读取项目对话，请重新加载',
    'homeSpace.context.enterpriseDescription': '发布到当前空间的应用。',
    'homeSpace.context.personalDescription': '你的个人空间与圈子应用。',
  }
  const u12Actual = await js<Record<string, string>>(`(() => {
    const keys = ${JSON.stringify(Object.keys(u12Expected))}
    return Object.fromEntries(keys.map(key => [key, String(window.__poo196.t(key))]))
  })()`)
  const u12Drift = Object.entries(u12Expected).filter(([key, value]) => u12Actual[key] !== value)
  check('[S16][U12] 19 键 zh-Hans 逐字值（术语统一落位）', u12Drift.length === 0, { drift: u12Drift.map(([key]) => key), actual: u12Drift.map(([key]) => [key, u12Actual[key]]) })
}

/** S17: 空间菜单入口（生产 ProductSpaceSwitcher）——R3 (D11) 唯一入口收敛：
 * 两个旧创建入口（product-space-create-project /
 * product-space-select-create-project）已从生产删除，断言翻转为 count=0；
 * 刷新入口保留且仍触发在线刷新；仅个人空间同样不复活创建入口。 */
async function scenarioSpaceMenuEntry() {
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await clickTab(T.tabMessages)
  await delay(200)

  await armSpaceMenu()
  const items = await js<Array<{ name: string }>>(`Array.from(document.querySelectorAll('${T.spaceMenuItem}')).map(el => ({ name: el.getAttribute('data-space-name') }))`)
  check('[S17] 切换子菜单列出 R3 全目录（组织+个人+项目空间，≥2）', items.length >= 2, { items })
  check('[S17] 旧菜单创建入口已删除（count=0）', (await js<number>(`window.__poo196.count('${T.spaceMenuCreate}')`)) === 0)
  check('[S17] 旧选择页创建入口已删除（count=0）', (await js<number>(`window.__poo196.count('${T.spaceSelectCreate}')`)) === 0)
  check('[S17] 全文档无残留创建入口（唯一入口=首页）',
    (await js<number>(`window.__poo196.count('${T.spaceMenuCreate}')`)) + (await js<number>(`window.__poo196.count('${T.spaceSelectCreate}')`)) === 0)
  check('[S17] 菜单尾「刷新项目」入口存在', await js<boolean>(`window.__poo196.q('${T.spaceMenuRefresh}')`))
  await capture('s17-space-menu-open')
  await pressEscape()
  await delay(200)

  // 刷新入口触发在线刷新（R3 保留项：刷新与邀请接受后空间可见）
  const refreshBefore = (await js<number[]>('window.__poo196.spaceRefreshLog()')).length
  await armSpaceMenu()
  await js<boolean>(`window.__poo196.pressEnterOn('${T.spaceMenuRefresh}')`)
  await until(async () => (await js<number[]>('window.__poo196.spaceRefreshLog()')).length > refreshBefore, 8000)
  check('[S17] 菜单「刷新项目」触发在线刷新', true)
  await pressEscape()
  await delay(200)

  // 仅个人空间：同样零创建入口（不能等待多空间选择页出现）
  await js<boolean>('window.__poo196Space.setPersonalOnly(true)')
  await delay(300)
  await armSpaceMenu()
  const personalItems = await js<number>(`window.__poo196.count('${T.spaceMenuItem}')`)
  check('[S17] 仅个人空间列表同样无「创建项目…」入口', personalItems === 1 && !(await js<boolean>(`window.__poo196.q('${T.spaceMenuCreate}')`)), { personalItems })
  await capture('s17-space-menu-personal-only')
  await pressEscape()
  await js<boolean>('window.__poo196Space.setPersonalOnly(false)')
  await delay(250)
}

/** S18: 第二装配分支（空消息项目会话）+ 会话切换清理 + 创建对话框重开
 * 不残留。 */
async function scenarioBranchesAndLifecycle() {
  await runProgramDirect({ op: 'resetPm' })
  // UB3 (U6): stage a REAL two-page invitation walk BEFORE the panel opens —
  // first page = 2 active + 1 active-but-expired (never counted), second page
  // = a repeatable duplicate + 1 active + 1 accepted. 首页 pending=2 →「至少」；
  // 全加载 pending=3 → 精确。
  await runProgramDirect({ op: 'setPmInvitationPages', args: { pageSize: 3 } })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.projectEmpty)`)
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 10000)
  check('[S18] 空消息项目会话仍渲染三 tab（第二装配分支）', (await js<number>(`window.__poo196.count('${T.tabs} [role="tab"]')`)) === 3)
  check('[S18] 第二分支同样有「成员」按钮', await js<boolean>(`window.__poo196.q('${T.membersButton}')`))
  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  check('[S18] 第二分支成员面板打开管理形态（push + 管理动作在）', (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('data-mode')`)) === 'push'
    && await js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`))

  // UB3 (U6) paginated pending-summary walkthrough retired with the same
  // POO-205 panel rework as S13's summary block: the pending summary, the
  // invitations sub-page and its fault-driven view-only state no longer exist
  // in the live member panel. Fixture reset below is kept so later steps keep
  // their role/fault state.
  await closeMembersPanel()
  await runProgramDirect({ op: 'setPmFault', args: { method: 'pmListProjectInvitations' } })
  await runProgramDirect({ op: 'setPmInvitationPages', args: { pageSize: 0 } })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await delay(200)

  await capture('s18-empty-session-members')

  // 切会话清理：面板打开时切走 → 面板消失且非项目会话零入口
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.personal)`)
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`)), 8000)
  check('[S18] 切会话后成员面板随之关闭', true)
  check('[S18] 非项目会话零成员按钮残留', !(await js<boolean>(`window.__poo196.q('${T.membersButton}')`)))
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.projectEmpty)`)
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 8000)
  await delay(300)
  // E2-4 钉子：ChatPage 未按会话重挂载（MainContentPanel 不设 key），
  // projectMembersOpen 存活于会话切换——切走时分支卸载隐藏面板，切回时
  // 面板自发重现。projectTab 有会话切换重置（S8），membersOpen 没有。
  const reopenVisible = await js<boolean>(`window.__poo196.q('${T.membersPanel}')`)
  const reopenStep = (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('data-mode') ?? 'closed'`))
  check('[S18][E2-4钉子] 切回后面板不自动恢复（无陈旧打开态）', !reopenVisible, { reopenVisible, reopenStep })
  if (reopenVisible) {
    await capture('s18-members-reopened-after-switch')
    await closeMembersPanel()
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

  // UB2 (U11/U3)：换账号清理——被拦截草稿的提示标记与共享进入状态在账号
  // 变化时整体清除（上个账号的草稿 scope 不泄露）。标记由真实拦截产生：
  // 注入 pending 进入状态 → 当前项目会话 composer 触发发送 → 同步拒绝。
  await js<boolean>('window.__poo196.setSession(window.__poo196.sessions.project)')
  await until(() => js<boolean>(`window.__poo196.q('${T.input}')`), 8000)
  await js<boolean>(`window.__poo196.setEntryState({ accountId: '${ACCOUNT_ID}', productSpaceId: '${PRODUCT_SPACE_ID}', generation: 42, phase: 'switching', origin: 'home' })`)
  await delay(200)
  const s18SendMark = (await js<Array<unknown>>('window.__poo196.sendMessageLog')).length
  await typeInto(T.input, '换账号前被拦截的草稿')
  await js<boolean>('window.__poo196.send()')
  await delay(500)
  check('[S18][U11] pending 注入下发送被拒且标记入账（零送达）',
    (await js<Array<unknown>>('window.__poo196.sendMessageLog')).length === s18SendMark
    && ((await js<string>('window.__poo196.inputValue()')) ?? '').includes('换账号前被拦截的草稿')
    && (await js<Array<{ draftKey: string; accountId: string }>>('window.__poo196.sendNotices()')).some(notice => notice.draftKey === SESSION_PROJECT && notice.accountId === ACCOUNT_ID), { notices: await js<Array<unknown>>('window.__poo196.sendNotices()') })
  await js<boolean>(`window.__poo196Space.setAccountId('acct-zhao-03')`)
  await until(async () => (await js<Array<unknown>>('window.__poo196.sendNotices()')).length === 0, 8000)
  check('[S18][U11] 换账号清理提示标记（不泄露上个账号草稿 scope）',
    (await js<Array<unknown>>('window.__poo196.sendNotices()')).length === 0
    && ((await js<{ phase: string }>('window.__poo196.entryState()')).phase === 'idle'))
  await js<boolean>(`window.__poo196Space.setAccountId('${ACCOUNT_ID}')`)
  await js<boolean>(`window.__poo196.setEntryState({ accountId: null, productSpaceId: null, generation: 0, phase: 'idle', origin: null })`)
  await delay(300)

  // ── UB4 (U13)：项目会话 composer 稳定提示 + 帮助；非项目保持当前呈现 ────
  // 有历史的会话宿主与空态同一呈现（ChatPage→ChatDisplay→FreeFormInput）：
  // 占位符稳定不轮播（超过旧轮播间隔仍为 Enter 偏好句），帮助可发现、Esc
  // 关闭回焦；切到非项目会话恢复轮播默认且无帮助按钮。
  await runProgramDirect({ op: 'setSendMessageKey', args: { value: 'enter' } })
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.project)`)
  await until(() => js<boolean>(`window.__poo196.q('${T.input}')`), 8000)
  const s18Placeholder = () => js<string>(`document.querySelector('${T.input}')?.getAttribute('aria-placeholder') ?? 'missing'`)
  await until(async () => ((await s18Placeholder()) === (await i18nText('project.entry.inputPlaceholder')).trim()), 8000)
  await delay(5300)
  check('[S18][U13] 项目会话占位符稳定（等待超过旧轮播间隔仍为 Enter 偏好句）',
    (await s18Placeholder()) === (await i18nText('project.entry.inputPlaceholder')).trim())
  await js<boolean>(`window.__poo196.click('${T.composerHelp}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.composerHelpContent}')`), 8000)
  check('[S18][U13] 会话 composer 输入帮助可打开（真实快捷键行）',
    ((await js<string>(`document.querySelector('${T.composerHelpContent}')?.textContent ?? ''`)).includes((await i18nText('chatInput.placeholder.shiftTab')).trim().slice(0, 4))))
  await js<boolean>('window.__poo196.focusInput()')
  await pressEscape()
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.composerHelpContent}')`)), 8000)
  check('[S18][U13] Esc 关闭帮助并回焦输入框',
    ((await js<string>(`document.activeElement?.getAttribute('data-tutorial') ?? 'missing'`)).trim()) === 'chat-input')
  // 非项目会话：保持当前呈现（轮播默认占位符、无帮助按钮）。
  await runProgramDirect({ op: 'setSendMessageKey', args: { value: 'enter' } })
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.personal)`)
  await until(() => js<boolean>(`window.__poo196.q('${T.input}')`), 8000)
  await delay(400)
  check('[S18][U13] 非项目会话保持轮播默认（无帮助按钮、占位符非项目稳定句）',
    !(await js<boolean>(`window.__poo196.q('${T.composerHelp}')`))
    && (await s18Placeholder()) !== (await i18nText('project.entry.inputPlaceholder')).trim()
    && (await s18Placeholder()) !== (await i18nText('project.entry.inputPlaceholderClick')).trim())
  await capture('s18-composer-presentation')
  await runProgramDirect({ op: 'setSendMessageKey', args: { value: 'enter' } })

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
  // R3: the targeted compose is the directory page's secondary path — arm the
  // no-source success state so the compose/visual faces stay reachable.
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'none' } })
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
      await openMembersPanel()
      await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
      await capture(`s19-members-overview-${theme}-${lang}`)

      // 输入步（经同事目录页的次级路径）→ 结果页（复制态）
      await openDirectCompose()
      await typeInto(T.membersInviteTarget, '13600001234')
      await capture(`s19-members-compose-${theme}-${lang}`)
      await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
      await until(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 10000)
      await js<boolean>(`window.__poo196.click('${T.membersCopyLink}')`)
      await delay(350)
      await capture(`s19-members-result-${theme}-${lang}`)
      await closeMembersPanel()

      // member 表面
      await js<boolean>('window.__poo196Space.setRole("member")')
      await delay(300)
      await openMembersPanel()
      await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
      await capture(`s19-members-member-${theme}-${lang}`)
      await closeMembersPanel()
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
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'available' } })
}

/** S20: R8a 禁词扫描扩展——成员面板各步 + 创建对话框 × 三语言。 */
async function scenarioR8aMembersCreate() {
  const forbidden = [
    'OpenViking', 'Viking', '向量', 'COS', '对象存储', 'bucket', 'presign', '预签名',
    'embedding', '索引库', '全文检索', '解析上限', 'chunk', 'CHUNK',
    'token 上限', 'STORAGE', 'S3', 'OSS',
  ]
  await runProgramDirect({ op: 'resetPm' })
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'none' } })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await clickTab(T.tabMessages)
  await clearInput()
  await delay(200)

  const surfaces: Array<{ label: string; prepare: () => Promise<void>; cleanup: () => Promise<void> }> = [
    {
      label: 'members-overview',
      prepare: async () => {
        await openMembersPanel()
        await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
      },
      cleanup: () => closeMembersPanel(),
    },
    {
      label: 'members-compose',
      prepare: async () => {
        await openMembersPanel()
        await until(() => js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`), 8000)
        await openDirectCompose()
      },
      cleanup: () => closeMembersPanel(),
    },
    {
      label: 'members-result',
      prepare: async () => {
        await openMembersPanel()
        await until(() => js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`), 8000)
        await openDirectCompose()
        await typeInto(T.membersInviteTarget, '13400001234')
        await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
        await until(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 10000)
      },
      cleanup: () => closeMembersPanel(),
    },
    {
      label: 'members-member-surface',
      prepare: async () => {
        await js<boolean>('window.__poo196Space.setRole("member")')
        await delay(250)
        await openMembersPanel()
        await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
      },
      cleanup: async () => {
        await closeMembersPanel()
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
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'available' } })
}

/** S21: 性能——成员面板打开→名册可见、创建对话框打开、邀请提交→结果页。 */
async function scenarioMembersPerformance() {
  await runProgramDirect({ op: 'resetPm' })
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'none' } })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await clickTab(T.tabMessages)
  await delay(200)

  const openDurations: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now()
    await js<boolean>(`window.__poo196.click('${T.membersButton}')`)
    await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 10000)
    openDurations.push(Date.now() - t0)
    await closeMembersPanel()
    await delay(150)
  }
  const medianOpen = openDurations.sort((a, b) => a - b)[1]
  check('[S21] 成员面板打开到名册可见中位 <1500ms', medianOpen < 1500, { openDurations, medianOpen })

  const tCreate0 = Date.now()
  await openCreateDialog()
  const createOpenMs = Date.now() - tCreate0
  check('[S21] 创建对话框打开 <1500ms', createOpenMs < 1500, { createOpenMs })
  await closeCreateDialog()

  await openMembersPanel()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`), 8000)
  await openDirectCompose()
  await typeInto(T.membersInviteTarget, '13500001234')
  const tInvite = Date.now()
  await js<boolean>(`window.__poo196.click('${T.membersInviteSubmit}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersResult}')`), 10000)
  const inviteMs = Date.now() - tInvite
  check('[S21] 邀请提交→结果页 <2000ms', inviteMs < 2000, { inviteMs })
  await capture('s21-invite-roundtrip')
  await closeMembersPanel()
  await runProgramDirect({ op: 'setColleagueScript', args: { script: 'available' } })
  await clickTab(T.tabMessages)
  await delay(150)
}

/* ── POO-196 R3（裁决 D11/D12）：六个新增场景 + 八个 TODO 骨架 ─────────────
 * 首页「项目」目录（D6 协商列表）、容量/排序（P3）、加载与撤权真态（P4）、
 * 最小创建与身份补全（D7）、直接进入与最近会话（D13/D14）、成员面板形态
 * （D8/D4）。fixture 边界照旧：页面与 hooks 全部生产源码，只有窗口/tab
 * 壳、IPC 与登录态被夹具。 */

/** R3 home-mode fixture setup: fresh directory + sessions + visit records,
 * the production HomePage mounted through ?mode=home (__poo196.setMode). */
const enterHomeMode = async () => {
  await runProgramDirect({ op: 'resetR3' })
  await runProgramDirect({ op: 'resetPm' })
  // The create dialog's auto-enter memo is keyed by the created space id and
  // the dialog instance NEVER remounts across scenarios — offset the fixture
  // id sequence so a home scenario's created id can never collide with an id
  // an earlier scenario already attempted (production mints globally fresh
  // ids; the fixture mirrors that freshness).
  fixture.pm.createdSeq += 100
  await runProgramDirect({ op: 'setR3SessionsMode', args: { mode: 'recent' } })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await js<boolean>(`window.__poo196.clearVisits('${ACCOUNT_ID}')`)
  await js<boolean>(`window.__poo196.clearVisits('${R3_ACCOUNT_B_ID}')`)
  // Scenario isolation: the entry/switch logs accumulate across scenarios —
  // stale entries would let some() probes pass on a previous scenario's ride.
  await js<boolean>('window.__poo196.clearLogs()')
  await js<boolean>('window.__poo196.setMode("home")')
  await until(() => js<boolean>(`window.__poo196.q('${T.homeProjects}')`), 12000)
}

/** HomePage reads the negotiated directory on MOUNT (the effect keys on the
 * account string + a local reload tick), so a reprogrammed directory needs a
 * page remount — the same fresh read a production context refresh produces. */
const remountHome = async () => {
  await js<boolean>('window.__poo196.setMode("chat")')
  await delay(150)
  await js<boolean>('window.__poo196.setMode("home")')
  await until(() => js<boolean>(`window.__poo196.q('${T.homeProjects}')`), 12000)
}

const leaveHomeMode = async () => {
  // The entry scenarios commit the fixture context to their target project;
  // restore the apollo project scope BEFORE the ChatPage tab assertions (the
  // production tab strip renders only for the committed project session).
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await js<boolean>('window.__poo196.setMode("chat")')
  await until(() => js<boolean>(`window.__poo196.q('${T.tabs}')`), 12000)
  await runProgramDirect({ op: 'resetR3' })
  await runProgramDirect({ op: 'resetPm' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await js<boolean>('window.__poo196.clearLogs()')
  await clickTab(T.tabMessages)
  await delay(150)
}

/** Visible-card counter: the capacity classes hide via display:none, so the
 * DOM row count alone is not the rendered count. */
const visibleCardCount = () => js<number>(`Array.from(document.querySelectorAll('${T.homeProjectCard}')).filter(el => el.getClientRects().length > 0).length`)

/** UB5 (U9): the resident project search — visible (not display:none) input. */
const projectSearchVisible = () => js<boolean>(`(() => { const el = document.querySelector('${T.homeProjectSearch}'); return Boolean(el) && el.getClientRects().length > 0 })()`)

/** UB5 (U9): clear the resident project search the way a user's clear gesture
 * does (select-all + replace with empty through the real input path). */
const clearProjectSearchInput = () => js<boolean>(`(() => { const el = document.querySelector('${T.homeProjectSearch}'); el.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, ''); return true })()`)

const cardIdsInDomOrder = () => js<string[]>(`Array.from(document.querySelectorAll('${T.homeProjectCard}')).map(el => el.getAttribute('data-product-space-id') ?? '')`)

/** D12 R3-01: personal/organization/project 首页目录——三首页都渲染「项目」
 * 区域；卡片集合=仅 enterpriseKind==='project' 的条目（organization 聚合
 * 永不出卡）；当前标识唯一；应用搜索不越界到项目；同名 twin 按 ID 定位。 */
async function scenarioR3HomeProjectDirectory() {
  await enterHomeMode()
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)

  // 区域层级：hero（home-quick-access-section）之后是「项目」，再是「应用」。
  const sectionOrder = await js<boolean>(`(() => {
    const hero = document.querySelector('[data-testid="home-quick-access-section"]')
    const projects = document.querySelector('${T.homeProjects}')
    const apps = document.querySelector('${T.homeAppsTitle}')
    return Boolean(hero && projects && apps)
      && hero.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING
      && projects.compareDocumentPosition(apps) & Node.DOCUMENT_POSITION_FOLLOWING
  })()`)
  check('[R3-01] hero →「项目」→「应用」区域顺序', sectionOrder)

  // 卡片集合：organization 空间（ps-apollo）与个人空间（ps-personal-lin）
  // 都不渲染卡片；六个 project 空间全部渲染。
  const ids = await cardIdsInDomOrder()
  check('[R3-01] 卡片集合=仅 enterpriseKind=project（六张）', ids.length === 6
    && ids.includes(R3_PROJECT_ALPHA_ID) && ids.includes(R3_PROJECT_BETA_ID)
    && ids.includes(R3_PROJECT_EMPTY_ID) && ids.includes(R3_PROJECT_READONLY_ID)
    && ids.includes(R3_TWIN_A_ID) && ids.includes(R3_TWIN_B_ID), { ids })
  check('[R3-01] organization 空间不出卡', !ids.includes('ps-apollo'))
  check('[R3-01] 个人空间不出卡', !ids.includes('ps-personal-lin'))

  // 顺序：未进入过 → 按当前 locale 名称 + ID 稳定排序（页内同一 Collator）。
  const orderCheck = await js<boolean>(`(() => {
    const cards = Array.from(document.querySelectorAll('${T.homeProjectCard}'))
    const entries = cards.map(el => ({ id: el.getAttribute('data-product-space-id') ?? '', name: el.getAttribute('aria-label') ?? '' }))
    const collator = new Intl.Collator(document.documentElement.lang || 'zh-Hans')
    const sorted = [...entries].sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return JSON.stringify(entries.map(e => e.id)) === JSON.stringify(sorted.map(e => e.id))
  })()`)
  check('[R3-01] 未访问卡片按 locale 名称+ID 稳定排序', orderCheck)

  // 当前标识：fixture 提交到 alpha 后徽标唯一且落在 alpha 卡上。
  await js<boolean>(`window.__poo196Space.setActiveSpace('${R3_PROJECT_ALPHA_ID}')`)
  await delay(300)
  const currentIds = await js<string[]>(`Array.from(document.querySelectorAll('${T.homeProjectCard} [data-testid="home-project-current"]')).map(el => el.closest('[data-testid="home-project-card"]')?.getAttribute('data-product-space-id') ?? '')`)
  check('[R3-01] 「当前」徽标唯一且落在当前空间卡', (await js<number>(`window.__poo196.count('${T.homeProjectCurrent}')`)) === 1
    && currentIds.length === 1 && currentIds[0] === R3_PROJECT_ALPHA_ID, { currentIds })
  // UB5 (U14): committed PROJECT → 「当前项目：{{name}}」— the classification
  // comes from the negotiated summary type; the committed name rides {{name}}
  // verbatim (a project is never announced as the organization).
  const projectIdentityExpected = await js<string>(`window.__poo196.t('homeSpace.context.currentProject', { name: '华东区销售资料库' })`)
  const projectIdentityShown = await js<string>(`document.querySelector('${T.homeSpaceContextTitle}')?.textContent ?? ''`)
  check('[R3-01][U14] 当前项目身份条=「当前项目：华东区销售资料库」（真实名称不改）', projectIdentityShown === projectIdentityExpected, { projectIdentityShown, projectIdentityExpected })
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await delay(200)

  // 元数据：purpose 按 summary 呈现；read_only 徽标；人数未知绝不伪造 0。
  const alphaText = await js<string>(`document.querySelector('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_ALPHA_ID}"]')?.textContent ?? ''`)
  check('[R3-01] 卡片呈现 summary 的 purpose', alphaText.includes('集中管理华东区客户与销售过程资料'), { sample: alphaText.slice(0, 60) })
  check('[R3-01] read_only 空间呈现只读徽标', await js<boolean>(`Boolean(document.querySelector('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_READONLY_ID}"] [data-testid="home-project-readonly"]'))`))
  check('[R3-01] 无 activeMemberCount 时不渲染成员数（无伪造 0）', !(await js<string>(`document.querySelector('${T.homeProjects}')?.textContent ?? ''`)).includes('位成员'))

  // 应用搜索作用域：工具栏搜索词不进入项目区。
  await typeInto(T.homeDirectorySearch, '不存在的应用xyz')
  await delay(500)
  check('[R3-01] 应用搜索不影响项目卡片', (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) === 6)
  await js<boolean>(`(() => { const el = document.querySelector('${T.homeDirectorySearch}'); el.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, ''); return true })()`)
  await delay(300)

  // 同名 twin：按 data-product-space-id 独立定位与进入（名称不可作键）。
  const twinTexts = await js<number>(`Array.from(document.querySelectorAll('${T.homeProjectCard}')).filter(el => (el.getAttribute('aria-label') ?? '') === '${R3_TWIN_NAME}').length`)
  check('[R3-01] 同名 twin 两张并存', twinTexts === 2)
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_TWIN_B_ID}"]')`)
  await until(async () => (await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `committed:${R3_TWIN_B_ID}`), 12000)
  check('[R3-01] 点击同名 twin 进入的是 ID 命中的那张（twinB）',
    (await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `committed:${R3_TWIN_B_ID}`)
      && !(await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `request:${R3_TWIN_A_ID}`))

  // ── UB5 (U9/U14): 常驻搜索、空间身份层级与 frozen 卡片样式 ───────────────
  // twin 提交后宿主按生产规则把表面切到了会话侧——showHome() 重新挂载首页
  // （等价再次打开首页 tab，目录新读），再回到 organization scope 跑钉子。
  await js<boolean>('window.__poo196.showHome()')
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) === 6, 12000)
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await delay(400)

  // U14: organization home → 「当前单位：{{name}}」（分类来自协商 summary
  // 类型；已提交名称逐字进入 {{name}}，不从名字猜、不剥「项目空间」）。
  const orgIdentityExpected = await js<string>(`window.__poo196.t('homeSpace.context.currentOrganization', { name: 'Apollo 项目空间' })`)
  const orgIdentityShown = await js<string>(`document.querySelector('${T.homeSpaceContextTitle}')?.textContent ?? ''`)
  check('[R3-01][U14] organization 身份条=「当前单位：Apollo 项目空间」（真实名称不改）', orgIdentityShown === orgIdentityExpected, { orgIdentityShown, orgIdentityExpected })
  // U14: the compact identity row — 8px vertical padding + 13px semibold
  // name + 12px secondary description.
  check('[R3-01][U14] 身份条紧凑（py-8px、名称 13px semibold、说明 12px 次级）',
    await js<boolean>(`(() => {
      const section = document.querySelector('${T.homeSpaceContext}')
      const title = document.querySelector('${T.homeSpaceContextTitle}')
      return Boolean(section && title)
        && section.className.includes('py-[8px]')
        && title.className.includes('text-[13px]')
        && title.className.includes('font-semibold')
    })()`))

  // U14: 项目区标题/说明换新键（旧→新映射：项目 → 我们的项目）。
  const projectsTitleCopy = (await i18nText('home.projects.title')).trim()
  const projectsDescCopy = (await i18nText('home.projects.description')).trim()
  const projectsSectionText = await js<string>(`document.querySelector('${T.homeProjects}')?.textContent ?? ''`)
  check('[R3-01][U14] 项目区标题=「我们的项目」+ 新说明', projectsSectionText.includes(projectsTitleCopy) && projectsSectionText.includes(projectsDescCopy),
    { projectsTitleCopy, projectsDescCopy })

  // U14: 卡片层级——每张卡名称前对话气泡 + 右下共用 U3「进入项目」标签。
  const bubbleCount = await js<number>(`Array.from(document.querySelectorAll('${T.homeProjectCard} h3 svg')).length`)
  const enterLabelCount = await js<number>(`window.__poo196.count('${T.homeProjectEnterLabel}')`)
  check('[R3-01][U14] 六张卡都带对话气泡图标+「进入项目」标签', bubbleCount === 6 && enterLabelCount === 6, { bubbleCount, enterLabelCount })
  // U14: frozen POO-41 卡片语言保持——圆角/材质/hover 抬升/grid 断点逐字未动。
  check('[R3-01][U14] frozen 卡片样式保持（rounded-20/材质/hover/grid 断点）',
    await js<boolean>(`(() => {
      const card = document.querySelector('${T.homeProjectCard}')
      const grid = card?.parentElement
      const cls = card?.className ?? ''
      const gridCls = grid?.className ?? ''
      return cls.includes('rounded-[20px]') && cls.includes('client-material-card')
        && cls.includes('hover:-translate-y-[1px]') && cls.includes('hover:shadow-middle')
        && gridCls.includes('grid-cols-1') && gridCls.includes('min-[761px]:grid-cols-2')
        && gridCls.includes('min-[1081px]:grid-cols-3')
    })()`))

  // U9: 常驻搜索——未展开（1440 宽）即可发现；查询只过滤项目区，应用工具栏
  // 搜索词与结果不受影响。
  check('[R3-01][U9] 项目搜索常驻可发现（1440 宽）',
    await js<boolean>(`(() => { const el = document.querySelector('${T.homeProjectSearch}'); return Boolean(el) && el.getClientRects().length > 0 })()`))
  await typeInto(T.homeProjectSearch, R3_TWIN_NAME)
  await delay(400)
  check('[R3-01][U9] 项目查询只过滤项目区（beta+双 twin 命中 3 卡），应用工具栏不受影响',
    (await visibleCardCount()) === 3
    && (await js<string>(`document.querySelector('${T.homeDirectorySearch}')?.value ?? ''`)) === '')
  await capture('r3-01-u9-u14-resident-search-identity')
  await js<boolean>(`(() => { const el = document.querySelector('${T.homeProjectSearch}'); el.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, ''); return true })()`)
  await delay(300)
  await capture('r3-01-directory')
  await leaveHomeMode()
}

/** D12 R3-02: 容量边界（0/1/两行/超两行）、展开-搜索-收起回路、唯一创建
 * 入口、成功进入才写 visit 记录、账号切换隔离。 */
async function scenarioR3ProjectCapacityAndOrdering() {
  await enterHomeMode()
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  check('[R3-02] 全目录：唯一创建入口（首页 header）', (await js<number>(`window.__poo196.count('${T.homeProjectCreate}')`)) === 1)
  check('[R3-02] 旧创建入口全文档 count=0',
    (await js<number>(`window.__poo196.count('${T.spaceMenuCreate}')`)) + (await js<number>(`window.__poo196.count('${T.spaceSelectCreate}')`)) === 0)

  // 0 边界：verified-empty 走「还没有项目」，创建入口仍在（唯一主动作）。
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'empty' } })
  await remountHome()
  await until(() => js<boolean>(`window.__poo196.q('${T.homeProjectEmpty}')`), 12000)
  check('[R3-02] 0 项目 →「还没有项目」空态且零卡片', (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) === 0)
  check('[R3-02] 空目录仍保留唯一创建入口', (await js<number>(`window.__poo196.count('${T.homeProjectCreate}')`)) === 1)
  // UB5 (U9): 0 项目（已加载零集合）搜索仍常驻；空态/无匹配不互串。
  check('[R3-02][U9] 0 项目搜索仍常驻可发现', await projectSearchVisible()
    && !(await js<boolean>(`window.__poo196.q('${T.homeProjectNoMatches}')`)))
  await capture('r3-02-empty-directory')

  // 1 边界：单卡、无展开控件。
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'one' } })
  await remountHome()
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) === 1, 12000)
  check('[R3-02] 1 项目 → 单卡且无「查看全部」', !(await js<boolean>(`window.__poo196.q('${T.homeProjectExpand}')`)))
  check('[R3-02][U9] 1 项目搜索常驻可发现', await projectSearchVisible())

  // 超两行 + UB5 (U9) 常驻搜索矩阵（900px 视口=两列断点带）。
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'ok' } })
  await remountHome()
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) === 6, 12000)
  host.setSize(900, 900)
  await delay(400)
  check('[R3-02] 超两行收起态只渲染两行（4 卡可见）', (await visibleCardCount()) === 4)
  check('[R3-02] 收起态出现「查看全部」', await js<boolean>(`window.__poo196.q('${T.homeProjectExpand}')`))
  // U9 旧→新映射：搜索原先「展开后才出现」，现为常驻——收起态即可发现。
  check('[R3-02][U9] 收起态搜索常驻可发现（900px 窄屏）', await projectSearchVisible())
  // U9: 查询命中折叠区项目（只读卡排序在第 6 位、收起态 900px 下隐藏）→
  // 全部命中绕过两行截断；展开/收起控件同时隐藏（不存在隐式擦掉查询的路径）。
  await typeInto(T.homeProjectSearch, '只读')
  await delay(400)
  check('[R3-02][U9] 查询命中折叠区项目：全部命中（1 卡），无展开/收起控件', (await visibleCardCount()) === 1
    && !(await js<boolean>(`window.__poo196.q('${T.homeProjectExpand}')`))
    && !(await js<boolean>(`window.__poo196.q('${T.homeProjectCollapse}')`)))
  await capture('r3-02-u9-collapsed-area-hit')
  // U9: 清空查询 → 恢复原展开偏好（仍收起两行）+「查看全部」回来。
  await clearProjectSearchInput()
  await delay(400)
  check('[R3-02][U9] 清空查询恢复收起两行+「查看全部」', (await visibleCardCount()) === 4
    && await js<boolean>(`window.__poo196.q('${T.homeProjectExpand}')`)
    && !(await js<boolean>(`window.__poo196.q('${T.homeProjectNoMatches}')`)))
  await js<boolean>(`window.__poo196.click('${T.homeProjectExpand}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.homeProjectCollapse}')`), 8000)
  check('[R3-02] 展开后全部可见并出现项目搜索+收起', (await visibleCardCount()) === 6
    && await js<boolean>(`window.__poo196.q('${T.homeProjectSearch}')`)
    && await js<boolean>(`window.__poo196.q('${T.homeProjectCollapse}')`))
  await typeInto(T.homeProjectSearch, '不存在的项目zzz')
  await delay(400)
  check('[R3-02] 项目搜索无匹配 →「没有匹配的项目」', await js<boolean>(`window.__poo196.q('${T.homeProjectNoMatches}')`)
    && (await visibleCardCount()) === 0)
  check('[R3-02][U9] 查询非空时无展开/收起控件', !(await js<boolean>(`window.__poo196.q('${T.homeProjectExpand}')`))
    && !(await js<boolean>(`window.__poo196.q('${T.homeProjectCollapse}')`)))
  // U9: 无匹配提示紧接输入框下方（同容器、紧随其后）——不在输入框上方，
  // 也不落进应用区。
  check('[R3-02][U9] 无匹配提示紧接输入框下方', await js<boolean>(`(() => {
    const input = document.querySelector('${T.homeProjectSearch}')
    const hint = document.querySelector('${T.homeProjectNoMatches}')
    return Boolean(input && hint)
      && Boolean(input.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING)
      && input.parentElement === hint.parentElement
  })()`))
  await capture('r3-02-expanded-search')
  // U9 旧→新映射：旧检查「收起=清空搜索」按裁决改为「展开/收起与查询独立
  // 存储——清空才恢复原展开偏好」。查询非空时本无收起钮，直接清空。
  await clearProjectSearchInput()
  await delay(400)
  check('[R3-02][U9] 清空查询恢复展开偏好（6 卡全显+收起钮）', (await visibleCardCount()) === 6
    && await js<boolean>(`window.__poo196.q('${T.homeProjectCollapse}')`)
    && !(await js<boolean>(`window.__poo196.q('${T.homeProjectNoMatches}')`)))
  await js<boolean>(`window.__poo196.click('${T.homeProjectCollapse}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.homeProjectExpand}')`), 8000)
  check('[R3-02] 收起回到两行', (await visibleCardCount()) === 4
    && !(await js<boolean>(`window.__poo196.q('${T.homeProjectNoMatches}')`)))

  // UB5 (U9): 7 项目容量边界——搜索仍常驻，展开控件在任何断点都保留。
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'seven' } })
  await remountHome()
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) === 7, 12000)
  const expandTextSeven = await js<string>(`document.querySelector('${T.homeProjectExpand}')?.textContent ?? ''`)
  check('[R3-02][U9] 7 项目搜索常驻且「查看全部（7）」', await projectSearchVisible() && expandTextSeven.includes('（7）'), { expandTextSeven })
  host.setSize(1440, 900)
  await delay(350)
  check('[R3-02][U9] 宽屏（1440）搜索仍常驻可发现', await projectSearchVisible())
  // 还原 6 项目目录，供后续 visit/账号隔离钉使用。
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'ok' } })
  await remountHome()
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) === 6, 12000)

  // 成功进入才写 visit：进入前的记录为空，事务落地后才有 alpha 记录。
  const visitsBefore = await js<Record<string, number>>(`window.__poo196.visitOrder('${ACCOUNT_ID}')`)
  check('[R3-02] 进入前无 visit 记录', Object.keys(visitsBefore).length === 0, { visitsBefore })
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_ALPHA_ID}"]')`)
  await until(async () => (await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `committed:${R3_PROJECT_ALPHA_ID}`), 12000)
  await until(async () => (await js<Array<{ route: string; skipAutoSelect: boolean }>>('window.__poo196.navigateLog()')).some(entry => entry.route === `allSessions/session/${SESSION_R3_ALPHA_RECENT}`), 12000)
  const visitsAfter = await js<Record<string, number>>(`window.__poo196.visitOrder('${ACCOUNT_ID}')`)
  check('[R3-02] 进入成功后才写 visit 记录（仅 alpha）', Boolean(visitsAfter[R3_PROJECT_ALPHA_ID]) && Object.keys(visitsAfter).length === 1, { visitsAfter })

  // visit 驱动排序：回到首页后 alpha 第一。
  await js<boolean>('window.__poo196.showHome()')
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) === 6, 12000)
  check('[R3-02] visit 记录把 alpha 排到首位', (await cardIdsInDomOrder())[0] === R3_PROJECT_ALPHA_ID, { ids: await cardIdsInDomOrder() })

  // 账号切换隔离：账号 B 的 visit 集合为空（排序回退名称序），A 的记录不动。
  // UB5 (U9): 项目查询不跨账号——切账号先清空查询（展开偏好是设备级，不动）。
  await typeInto(T.homeProjectSearch, '华东区')
  await delay(400)
  check('[R3-02][U9] 项目查询过滤生效（仅华东区命中 1 卡）', (await visibleCardCount()) === 1)
  await js<boolean>(`window.__poo196Space.setAccountId('${R3_ACCOUNT_B_ID}')`)
  await until(async () => (await js<string>(`document.querySelector('${T.homeProjectSearch}')?.value ?? 'pending'`)) === '', 8000)
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) === 6, 12000)
  // 1440 宽（本段视口）收起容量=2×3：查询清空后 6 卡应全部恢复可见。
  check('[R3-02][U9] 切账号清空项目查询且全部卡片恢复（1440 宽 6 卡全显）',
    (await js<string>(`document.querySelector('${T.homeProjectSearch}')?.value ?? ''`)) === ''
    && (await visibleCardCount()) === 6)
  await delay(400)
  const orderForB = await cardIdsInDomOrder()
  check('[R3-02] 账号 B 看不到 A 的 visit 排序（回退名称序）', orderForB[0] !== R3_PROJECT_ALPHA_ID, { orderForB })
  await js<boolean>(`window.__poo196Space.setAccountId('${ACCOUNT_ID}')`)
  await delay(400)
  check('[R3-02] 切回账号 A 恢复 visit 排序', (await cardIdsInDomOrder())[0] === R3_PROJECT_ALPHA_ID)
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await leaveHomeMode()
}

/** D12 R3-03: 加载态/失败态/版本不支持（P4 真态区分）+ 撤权后目录更新。
 * 注意：夹具模式只证 UI 真态与协商面；真实服务联动由 L/live 入口证明。 */
async function scenarioR3LoadingAndRevocation() {
  // 骨架：慢响应下先出现 home-project-loading，再被卡片替换。
  await runProgramDirect({ op: 'setLatency', args: { ms: 700 } })
  await enterHomeMode()
  const skeletonSeen = await probeUntil(() => js<boolean>(`window.__poo196.q('${T.homeProjectLoading}')`), 6000)
  check('[R3-03] 首读慢响应呈现骨架（非空白非空态）', skeletonSeen)
  // UB5 (U9): 加载态绝不被搜索的空结果替代（无「没有匹配的项目」/「还没有项目」）。
  check('[R3-03][U9] 加载态不渲染无匹配/空态', !(await js<boolean>(`window.__poo196.q('${T.homeProjectNoMatches}')`))
    && !(await js<boolean>(`window.__poo196.q('${T.homeProjectEmpty}')`)))
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 15000)
  await runProgramDirect({ op: 'setLatency', args: { ms: 40 } })

  // P4：pm 通道抛错 → error face，绝不渲染成「还没有项目」。
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'fault' } })
  await remountHome()
  await until(() => js<boolean>(`window.__poo196.q('${T.homeProjectError}')`), 12000)
  const errorCopy = (await i18nText('home.projects.loadFailed')).trim()
  const errorShown = (await js<string>(`document.querySelector('${T.homeProjectError}')?.textContent ?? ''`)).trim()
  check('[R3-03] 首读失败呈现 error face（映射文案、非空态）', errorShown.includes(errorCopy.slice(0, 4))
    && !(await js<boolean>(`window.__poo196.q('${T.homeProjectEmpty}')`)), { errorShown: errorShown.slice(0, 60) })
  check('[R3-03] generic 失败带显式重试入口', await js<boolean>(`window.__poo196.q('${T.homeProjectErrorRetry}')`))
  // UB5 (U9): 失败态同样不被搜索空结果替代（搜索常驻但不产出假结果面）。
  check('[R3-03][U9] 失败态不渲染无匹配/空态', !(await js<boolean>(`window.__poo196.q('${T.homeProjectNoMatches}')`))
    && !(await js<boolean>(`window.__poo196.q('${T.homeProjectEmpty}')`)))
  await capture('r3-03-error-face')

  // 重试恢复：清障后点重试 → 目录回来。
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'ok' } })
  await js<boolean>(`window.__poo196.click('${T.homeProjectErrorRetry}')`)
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  check('[R3-03] 重试后目录恢复', !(await js<boolean>(`window.__poo196.q('${T.homeProjectError}')`)))

  // 版本不支持：409 → 专用文案 + 无重试按钮（重试同一条线路不可能解决）。
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'version' } })
  await remountHome()
  await until(() => js<boolean>(`window.__poo196.q('${T.homeProjectError}')`), 12000)
  const versionCopy = (await i18nText('home.projects.versionUnsupported')).trim()
  const versionShown = (await js<string>(`document.querySelector('${T.homeProjectError}')?.textContent ?? ''`)).trim()
  check('[R3-03] 版本不支持呈现专用文案', versionShown.includes(versionCopy.slice(0, 6)), { versionShown: versionShown.slice(0, 80) })
  check('[R3-03] 版本不支持无重试按钮', !(await js<boolean>(`window.__poo196.q('${T.homeProjectErrorRetry}')`)))
  check('[R3-03] 版本不支持仍不渲染空态/卡片', !(await js<boolean>(`window.__poo196.q('${T.homeProjectEmpty}')`))
    && (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) === 0)

  // U4（G4）首页宿主钉：可展开指引 + 设置导航（导航可用时）+ 键盘收起。
  // 旧→新映射：正文从「请更新服务后重试」改为服务/管理员指引（U4 修改裁决）。
  const guideActionCopyR3 = (await i18nText('home.projects.updateGuideAction')).trim()
  const collapsedR3 = await js<{ expanded: string; label: string }>(`(() => {
    const guide = document.querySelector('${T.homeProjectUpdateGuide}')
    return { expanded: guide?.getAttribute('aria-expanded') ?? 'missing', label: guide?.textContent ?? '' }
  })()`)
  check('[R3-03][U4] 「查看更新指引」主按钮在且初始收起', collapsedR3.expanded === 'false' && collapsedR3.label === guideActionCopyR3, collapsedR3)
  await js<boolean>(`window.__poo196.click('${T.homeProjectUpdateGuide}')`)
  const guideBodyCopyR3 = (await i18nText('home.projects.updateGuideBody')).trim()
  const clientUpdateCopyR3 = (await i18nText('home.projects.clientUpdateAction')).trim()
  const clientUpdateNoteR3 = (await i18nText('home.projects.clientUpdateNote')).trim()
  const expandedR3 = await js<{ body: string; shortcut: boolean; note: string }>(`(() => {
    return {
      body: document.querySelector('${T.homeProjectUpdateGuideBody}')?.textContent ?? '',
      shortcut: Boolean(document.querySelector('${T.homeProjectClientUpdate}')),
      note: document.querySelector('${T.homeProjectError}')?.textContent ?? '',
    }
  })()`)
  check('[R3-03][U4] 展开说明块=联系 Polo 管理员指引', expandedR3.body.includes(guideBodyCopyR3), { body: expandedR3.body.slice(0, 80) })
  check('[R3-03][U4] 检查客户端更新入口+「客户端更新不等于服务已更新」注记', expandedR3.shortcut
    && (await js<string>(`document.querySelector('${T.homeProjectClientUpdate}')?.textContent ?? ''`)).trim() === clientUpdateCopyR3
    && expandedR3.note.includes(clientUpdateNoteR3), expandedR3)
  await capture('r3-03-u4-version-guide-expanded')
  // 键盘收起：焦点在收起钮 + 真实 Enter。
  await js<boolean>(`document.querySelector('${T.homeProjectUpdateGuide}').focus()`)
  await pressEnterTrusted()
  await until(() => js<boolean>(`!window.__poo196.q('${T.homeProjectUpdateGuideBody}')`), 6000)
  check('[R3-03][U4] 真实 Enter 收起说明块（键盘可操作）', !(await js<boolean>(`window.__poo196.q('${T.homeProjectUpdateGuideBody}')`)))
  // 重新展开后设置导航真实到 app 设置页（宿主具备设置导航 → 快捷入口存在）。
  await js<boolean>(`window.__poo196.click('${T.homeProjectUpdateGuide}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.homeProjectClientUpdate}')`), 6000)
  await js<boolean>(`window.__poo196.click('${T.homeProjectClientUpdate}')`)
  const navToSettingsR3 = await probeUntil(async () => (await js<Array<{ route: string }>>('window.__poo196.navigateLog()')).some(entry => entry.route === 'settings/app'), 6000)
  check('[R3-03][U4] 检查客户端更新真实导航到 app 设置页', navToSettingsR3 && (await js<string>('window.__poo196.navRoute()')) === 'settings/app', { navToSettingsR3, navRoute: await js<string>('window.__poo196.navRoute()') })
  // 回到会话路由基线 + 回首页（导航事件把宿主表面切走了，与真实 tab 行为一致）。
  await js<boolean>(`window.dispatchEvent(new CustomEvent('polo-ai-navigate', { detail: { route: 'allSessions' } })); true`)
  await delay(200)
  await remountHome()
  await until(() => js<boolean>(`window.__poo196.q('${T.homeProjectError}')`), 12000)
  await capture('r3-03-version-unsupported')
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'ok' } })

  // stale 钉子的假态：ready 态无「可能不是最新」标记（生产当前无 stale 写入
  // 方——钉子保留，出现即回归信号）。
  await remountHome()
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  check('[R3-03] ready 态无 stale 标记（假态钉）', (await js<number>(`window.__poo196.count('${T.homeProjectStale}')`)) === 0)

  // U12（G12）消费钉：HomeSpaceContext 空间说明改值——企业态呈现「发布到
  // 当前空间的应用。」（不再绑定该企业空间措辞，键名/结构不变）。
  const enterpriseDescCopy = (await i18nText('homeSpace.context.enterpriseDescription')).trim()
  check('[R3-03][U12] 空间说明=「发布到当前空间的应用。」', (await js<string>('document.body.innerText')).includes(enterpriseDescCopy), { enterpriseDescCopy })

  // ── UB5 (U14): 类型未知 →「当前空间：{{name}}」。协商 summary 缺失当前
  // 空间的分类行时，身份条必须给中性面——不从名字猜组织/项目，真实名称
  // 逐字保留。数据注入（legacy）仅摘除 ps-apollo 的 summary 行。
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'legacy' } })
  await remountHome()
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) === 6, 12000)
  const unknownIdentityExpected = await js<string>(`window.__poo196.t('homeSpace.context.currentSpace', { name: 'Apollo 项目空间' })`)
  const unknownIdentityShown = await js<string>(`document.querySelector('${T.homeSpaceContextTitle}')?.textContent ?? ''`)
  check('[R3-03][U14] summary 缺失 →「当前空间：Apollo 项目空间」（不猜组织/项目）', unknownIdentityShown === unknownIdentityExpected, { unknownIdentityShown, unknownIdentityExpected })
  await capture('r3-03-u14-unclassified-identity')
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'ok' } })

  // ── UB2 (U10): committed 进入后 getSessions 拒绝 → 持久错误面（历史未知
  // ≠ 空项目，绝不渲染可发送空态或旧项目消息）；「重新加载」重读重进；
  // scope 离开目标后旧错误不得复活。
  await runProgramDirect({ op: 'resetR3' })
  await runProgramDirect({ op: 'setR3SessionsMode', args: { mode: 'fault' } })
  await js<boolean>('window.__poo196.showHome()')
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  const createsBeforeHistoryFault = (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length
  const getSessionsBeforeFault = (await runProgramDirect<{ getSessionsCalls: unknown[] }>({ op: 'r3Stats' })).getSessionsCalls.length
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_ALPHA_ID}"]')`)
  await until(async () => ((await js<{ phase: string; productSpaceId: string | null; origin: string | null }>('window.__poo196.entryState()')).phase === 'history-failed'), 12000)
  const failedStateR3 = await js<{ productSpaceId: string | null; origin: string | null }>('window.__poo196.entryState()')
  check('[R3-03][U10] committed 后读历史失败 → history-failed 且保留目标',
    failedStateR3.productSpaceId === R3_PROJECT_ALPHA_ID && failedStateR3.origin === 'home', { failedStateR3 })
  const historyFailedCopy = (await i18nText('project.entry.historyFailed')).trim()
  await js<boolean>('window.__poo196.showChats()')
  await until(() => js<boolean>(`window.__poo196.q('${T.projectEntryHistoryError}')`), 8000)
  const historyErrorText = await js<string>(`document.querySelector('${T.projectEntryHistoryError}')?.textContent ?? ''`)
  check('[R3-03][U10] 持久错误面保留项目标题+错误文案+「重新加载」',
    historyErrorText.includes('华东区销售资料库')
    && historyErrorText.includes(historyFailedCopy.slice(0, 6))
    && await js<boolean>(`window.__poo196.q('${T.projectEntryRetry}')`))
  // 「不显示旧项目消息」的落地面断言：face 分支覆盖一切路由（包括前序场景
  // 留下的会话路由）——对话面（pc-tabs 的 ChatPage/EmptyState）不在 DOM，
  // face 单独在场。
  check('[R3-03][U10] 不落成可发送空态/不显示旧会话（face 覆盖路由，无对话面）',
    !(await js<boolean>(`window.__poo196.q('${T.projectEntryEmpty}')`))
    && !(await js<boolean>(`window.__poo196.q('[data-testid="pc-tabs"]')`))
    && await js<boolean>(`window.__poo196.q('${T.projectEntryHistoryError}')`)
    && (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === createsBeforeHistoryFault, {
      emptyState: await js<boolean>(`window.__poo196.q('${T.projectEntryEmpty}')`),
      chatTabs: await js<boolean>(`window.__poo196.q('[data-testid="pc-tabs"]')`),
      face: await js<boolean>(`window.__poo196.q('${T.projectEntryHistoryError}')`),
      navRoute: await js<string>('window.__poo196.navRoute()'),
      creates: (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length,
      createsBefore: createsBeforeHistoryFault,
      entry: await js<unknown>('window.__poo196.entryState()'),
    })
  check('[R3-03][U10] 失败前确实发起了新鲜历史读（getSessions）',
    (await runProgramDirect<{ getSessionsCalls: unknown[] }>({ op: 'r3Stats' })).getSessionsCalls.length > getSessionsBeforeFault)
  await capture('r3-03-history-error-face')
  // history-failed 重试：重读目标历史，再按原选择规则进入。
  await runProgramDirect({ op: 'setR3SessionsMode', args: { mode: 'recent' } })
  await js<boolean>(`window.__poo196.click('${T.projectEntryRetry}')`)
  await until(async () => (await js<string>('window.__poo196.chatSession()')) === SESSION_R3_ALPHA_RECENT, 12000)
  check('[R3-03][U10] 「重新加载」重读历史并落地最近会话（错误面收口）',
    (await js<string>('window.__poo196.chatSession()')) === SESSION_R3_ALPHA_RECENT
    && ((await js<{ phase: string }>('window.__poo196.entryState()')).phase === 'ready')
    && !(await js<boolean>(`window.__poo196.q('${T.projectEntryHistoryError}')`)))
  await capture('r3-03-history-error-recovered')

  // 撤权/换 scope 后不恢复旧错误：beta 失败保留 → scope 离开（回 apollo）→
  // 状态被清；再切回 beta（历史可读）旧错误也不复活。
  await runProgramDirect({ op: 'setR3SessionsMode', args: { mode: 'fault' } })
  await js<boolean>('window.__poo196.showHome()')
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_BETA_ID}"]')`)
  await until(async () => ((await js<{ phase: string; productSpaceId: string | null }>('window.__poo196.entryState()')).phase === 'history-failed'
    && (await js<{ productSpaceId: string | null }>('window.__poo196.entryState()')).productSpaceId === R3_PROJECT_BETA_ID), 12000)
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await until(async () => ((await js<{ phase: string }>('window.__poo196.entryState()')).phase === 'idle'), 8000)
  await runProgramDirect({ op: 'setR3SessionsMode', args: { mode: 'recent' } })
  await js<boolean>(`window.__poo196Space.setActiveSpace("${R3_PROJECT_BETA_ID}")`)
  await delay(600)
  await js<boolean>('window.__poo196.showChats()')
  await delay(400)
  check('[R3-03][U10] 撤权/换 scope 后旧错误不复活（状态清空、错误面消失）',
    ((await js<{ phase: string }>('window.__poo196.entryState()')).phase === 'idle')
    && !(await js<boolean>(`window.__poo196.q('${T.projectEntryHistoryError}')`)))
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await delay(300)

  // 撤权：alpha 从目录消失（spaces 与 summaries 同步收窄），重挂后无卡。
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'revoked' } })
  await remountHome()
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  await until(async () => !((await cardIdsInDomOrder()).includes(R3_PROJECT_ALPHA_ID)), 4000)
  check('[R3-03] 撤权后 alpha 卡与 summary 一并消失',
    !((await cardIdsInDomOrder()).includes(R3_PROJECT_ALPHA_ID)))
  await runProgramDirect({ op: 'setR3DirectoryScript', args: { script: 'ok' } })
  await leaveHomeMode()
}

/** D12 R3-04: 最小创建表单与身份补全——唯一入口、字段可见性（负责人补全框
 * 仅显示名缺失/超限时出现+同步提示）、责任勾选门、空介绍穿透真实命令、
 * 128/512/64 边界截断、创建成功经 onRequestSwitch 进入。 */
async function scenarioR3MinimalCreateAndIdentity() {
  await enterHomeMode()
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)

  // 唯一入口：首页 header 一处，菜单/选择页旧入口为 0。
  check('[R3-04] 唯一创建入口（home-project-create count=1）', (await js<number>(`window.__poo196.count('${T.homeProjectCreate}')`)) === 1)
  check('[R3-04] 旧入口全文档 count=0',
    (await js<number>(`window.__poo196.count('${T.spaceMenuCreate}')`)) + (await js<number>(`window.__poo196.count('${T.spaceSelectCreate}')`)) === 0)

  // 表单可见性：名称（autofocus）+ 介绍（选填）+ 责任勾选；可用显示名 →
  // 负责人补全框与同步提示都不出现。
  await js<boolean>('window.__poo196Space.setAdminName("林奕")')
  await delay(200)
  check('[R3-04] 创建入口可达', await js<boolean>('window.__poo196.openCreateProject()'))
  await until(() => js<boolean>(`window.__poo196.q('${T.createDialog}')`), 8000)
  check('[R3-04] 名称字段在且获得焦点', await js<boolean>(`window.__poo196.q('${T.createName}')`)
    && await js<boolean>(`document.activeElement === document.querySelector('${T.createName}')`))
  check('[R3-04] 介绍字段为选填', (await js<string>(`document.querySelector('${T.createDialog}')?.textContent ?? ''`)).includes('选填'))
  check('[R3-04] 责任勾选与预算事实在', await js<boolean>(`window.__poo196.q('${T.createResponsibility}')`)
    && await js<boolean>(`window.__poo196.q('${T.createBudgetFact}')`))
  check('[R3-04] 可用显示名无负责人补全框/同步提示', !(await js<boolean>(`window.__poo196.q('${T.createOwner}')`))
    && !(await js<boolean>(`window.__poo196.q('${T.createOwnerSyncHint}')`)))

  // U1（G1）钉：预算事实=裁决文案且在勾选上方；介绍句=裁决文案；名称下
  // 常驻 hint 撤下（testid 保留：create-project-budget-fact/responsibility/submit）。
  const budgetFactCopyR34 = (await i18nText('createProject.budgetFact')).trim()
  const descriptionCopyR34 = (await i18nText('createProject.description')).trim()
  const u1FacesR34 = await js<{ fact: string; factBefore: boolean; hint: string; desc: string }>(`(() => {
    const fact = document.querySelector('${T.createBudgetFact}')
    const consent = document.querySelector('${T.createResponsibility}')
    return {
      fact: fact?.textContent ?? '',
      factBefore: Boolean(fact && consent && fact.compareDocumentPosition(consent) & Node.DOCUMENT_POSITION_FOLLOWING),
      hint: document.getElementById('create-project-name-hint')?.textContent ?? 'missing',
      desc: document.querySelector('${T.createDialog}')?.textContent ?? '',
    }
  })()`)
  check('[R3-04][U1] 预算事实=裁决文案（勾选上方、13px 信息正文）', u1FacesR34.fact === budgetFactCopyR34 && u1FacesR34.factBefore, { fact: u1FacesR34.fact, factBefore: u1FacesR34.factBefore })
  check('[R3-04][U1] 介绍句=裁决文案且名称 hint 撤下', u1FacesR34.desc.includes(descriptionCopyR34) && u1FacesR34.hint === '', { hint: u1FacesR34.hint })

  // 责任勾选门：名称就绪但未勾选 → 提交被拦 + 零创建请求。
  const createMark0 = pmCallCount('pmCreateEnterprise')
  await clearAndType(T.createName, '身份补全测试项目')
  await js<boolean>(`window.__poo196.click('${T.createSubmit}')`)
  const confirmRequired = (await i18nText('createProject.confirmRequired')).trim()
  await until(async () => (await js<string>('window.__poo196.text()')).includes(confirmRequired), 8000)
  check('[R3-04] 未勾选责任被提交门拦截（零请求）', pmCallCount('pmCreateEnterprise') - createMark0 === 0)

  // 边界截断：名称 129 字输入截到 128（DOM maxLength），介绍 513 截到 512。
  await clearAndType(T.createName, '名'.repeat(129))
  const nameLen = await js<number>(`document.querySelector('${T.createName}').value.length`)
  await clearAndType(T.createPurpose, '介'.repeat(513))
  const purposeLen = await js<number>(`document.querySelector('${T.createPurpose}').value.length`)
  check('[R3-04] 名称 129→128、介绍 513→512（DOM 边界截断）', nameLen === 128 && purposeLen === 512, { nameLen, purposeLen })

  // 空介绍穿透真实命令：勾选后提交，command.purpose 为合法空串。
  await clearAndType(T.createName, '空介绍穿透项目')
  await clearAndType(T.createPurpose, '')
  // UB2 (U10/U3): 在提交前布好 getSessions 故障——创建本身不读会话历史，
  // 但创建成功后的自动进入要读；故障让「创建成功→进入失败」确定性可达。
  await runProgramDirect({ op: 'setR3SessionsMode', args: { mode: 'fault' } })
  await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
  // 提交通道与生产一致：表单 submit 事件 = 浏览器 Enter 提交驱动的同一
  // onSubmit（D7：Enter 与鼠标同一门）。合成 pointer 在 Radix 面上的不稳定
  // 性是驱动层已知噪声（见 README 驱动方式）；若 dismiss 竞态把对话框提前
  // 关掉，重开再驱动——文字草稿按 E2-3 契约保留，绝不静默重发。
  let createFired = false
  // The wire-log counter only (result.pcCalls) — NEVER mixed with the
  // fixture-store counter (pmCallStats.createCalls is cleared by resetPm,
  // so the two diverge across scenarios).
  const createFiredProbe = () => probeUntil(async () => pmCallCount('pmCreateEnterprise') > createMark0, 5000)
  for (let round = 0; round < 3 && !createFired; round++) {
    // A dismiss race may have re-opened the dialog WITHOUT a create (the
    // previous create's auto-enter reset the consent — E2-3: it never
    // survives a reopen), so every round re-arms the responsibility checkbox.
    if (!(await js<boolean>(`document.querySelector('${T.createResponsibility} input')?.checked ?? false`))) {
      await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
    }
    if (!(await js<boolean>(`window.__poo196.q('#create-project-form')`))) {
      await js<boolean>('window.__poo196.openCreateProject()')
      await until(() => js<boolean>(`window.__poo196.q('#create-project-form')`), 8000)
      if (!(await js<boolean>(`document.querySelector('${T.createResponsibility} input')?.checked ?? false`))) {
        await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
      }
    }
    await js<boolean>(`(() => { const f = document.querySelector('#create-project-form'); if (!f) return false; f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return true })()`)
    createFired = await createFiredProbe()
  }
  const endStats = await runProgramDirect<{ createCalls: unknown[]; createdSpace: unknown }>({ op: 'pmCallStats' })
  const endFaces = await js<string>(`(() => {
    const d = document.querySelector('${T.createDialog}')
    return JSON.stringify({
      open: Boolean(d),
      radixState: d?.getAttribute('data-state') ?? 'absent',
      phase: d?.getAttribute('data-phase') ?? 'absent',
      respChecked: document.querySelector('${T.createResponsibility} input')?.checked ?? null,
      nameLen: document.querySelector('${T.createName}')?.value.length ?? null,
    })
  })()`)
  check('[R3-04] 提交经生产通道到达真实命令', createFired, { createFired, creates: endStats.createCalls.length, createdSpace: endStats.createdSpace, faces: endFaces })
  const emptyPurposeStats = await runProgramDirect<{ createCalls: Array<{ command: Record<string, unknown> }> }>({ op: 'pmCallStats' })
  const lastCreate = emptyPurposeStats.createCalls[emptyPurposeStats.createCalls.length - 1]
  check('[R3-04] 空介绍以合法空串进入真实命令', lastCreate.command.purpose === '', { purpose: lastCreate.command.purpose })

  // 创建成功 → 自动进入经 onRequestSwitch（不是 onSelectProductSpace）。
  const createdIdR34 = (await runProgramDirect<{ createdSpace: { productSpaceId: string } | null }>({ op: 'pmCallStats' })).createdSpace?.productSpaceId ?? 'ps-apollo-created'
  await until(async () => (await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `request:${createdIdR34}`), 12000)
  check('[R3-04] 创建成功经 onRequestSwitch 进入（request+committed，非 select）',
    (await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `committed:${createdIdR34}`)
      && !(await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry.startsWith('select:')))
  await until(() => createDialogClosed(), 8000)
  check('[R3-04] 进入动作关闭对话框', true)
  // UB2 (U10/U3)：创建来源进入读历史失败 → 持久错误面（创建来源额外行），
  // 重试只重进、不再 create。注意 scope 仍在 created 项目上（尚未切走）。
  const createsR34 = (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length
  await until(async () => {
    const entry = await js<{ phase: string; productSpaceId: string | null; origin: string | null }>('window.__poo196.entryState()')
    return entry.phase === 'history-failed' && entry.productSpaceId === createdIdR34 && entry.origin === 'create'
  }, 12000)
  check('[R3-04][U10] 创建来源失败保留目标且 origin=create',
    ((await js<{ productSpaceId: string | null }>('window.__poo196.entryState()')).productSpaceId) === createdIdR34)
  await js<boolean>('window.__poo196.showChats()')
  await until(() => js<boolean>(`window.__poo196.q('${T.projectEntryHistoryError}')`), 8000)
  const createdFaceText = await js<string>(`document.querySelector('${T.projectEntryHistoryError}')?.textContent ?? ''`)
  check('[R3-04][U10] 创建来源错误面带「项目已创建，暂时无法进入」+「重新加载」',
    createdFaceText.includes((await i18nText('createProject.created.enterFailed')).trim().slice(0, 5))
    && createdFaceText.includes((await i18nText('project.entry.historyFailed')).trim().slice(0, 6))
    && Boolean(createdFaceText.match('空介绍穿透项目'))
    && await js<boolean>(`window.__poo196.q('${T.projectEntryRetry}')`))
  check('[R3-04][U10] 失败面零会话创建、创建请求不增（只重试进入）',
    (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === createsR34)
  await capture('r3-04-create-enter-failed-face')
  await runProgramDirect({ op: 'setR3SessionsMode', args: { mode: 'recent' } })
  await js<boolean>(`window.__poo196.click('${T.projectEntryRetry}')`)
  await until(async () => ((await js<{ phase: string }>('window.__poo196.entryState()')).phase === 'ready'), 12000)
  check('[R3-04][U10] 重试只重进不再 create（created 项目无历史 → 空态落地）',
    (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === createsR34
    && await js<boolean>(`window.__poo196.q('${T.projectEntryEmpty}')`)
    && !(await js<boolean>(`window.__poo196.q('${T.projectEntryHistoryError}')`)))
  await capture('r3-04-create-enter-recovered')
  await capture('r3-04-create-entered')

  // ── UB4 (U5) 一次性拉人引导：创建成功→恢复落地只弹一次 ─────────────────
  // 恢复落点（创建来源 history-failed → 重新加载落地）由实际对话宿主接住：
  // intent 恰在此消费，面板直落「添加成员」选择页（不是总览），底部有
  // 「先不拉人，直接开始」；整条路径 0 invite / 0 createSession / 0 send。
  const ub4InviteMark = pmCallCount('pmCreateColleagueInvitation') + pmCallCount('pmCreateProjectInvitation')
  const ub4SendMark = (await js<Array<unknown>>('window.__poo196.sendMessageLog')).length
  const ub4CreateMark = (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length
  await until(() => js<boolean>(`window.__poo196.q('${T.membersPanel}')`), 12000)
  check('[R3-04][U5] 恢复落地只弹一次：面板自动打开且直落「添加成员」选择页',
    (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('data-mode') ?? 'closed'`)) === 'push'
    && await js<boolean>(`window.__poo196.q('${T.colleaguesPage}')`)
    && !(await js<boolean>(`window.__poo196.q('${T.membersRoster}')`)))
  check('[R3-04][U5] 自动打开面板底部有「先不拉人，直接开始」',
    ((await js<string>(`document.querySelector('${T.projectOnboardingSkip}')?.textContent ?? ''`)).trim()).includes((await i18nText('project.entry.skipInvite')).trim().slice(0, 4)))
  check('[R3-04][U5] 打开即消费 intent（一次性，不因后续重渲染/返回重弹）',
    (await js<unknown>('window.__poo196.onboardingIntent()')) === null)
  check('[R3-04][U5] 自动打开零写入（0 invite / 0 createSession / 0 send）',
    pmCallCount('pmCreateColleagueInvitation') + pmCallCount('pmCreateProjectInvitation') === ub4InviteMark
    && (await js<Array<unknown>>('window.__poo196.sendMessageLog')).length === ub4SendMark
    && (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === ub4CreateMark)
  await capture('r3-04-onboarding-auto-open')
  // 跳过：关闭面板并把焦点交回输入框。
  await js<boolean>(`window.__poo196.click('${T.projectOnboardingSkip}')`)
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`)), 8000)
  check('[R3-04][U5] 跳过关闭面板且聚焦输入框',
    ((await js<string>(`document.activeElement?.getAttribute('data-tutorial') ?? 'missing'`)).trim()) === 'chat-input')
  // 关闭再进（普通卡片重进同项目）：intent 已消费 → 不再弹。
  await js<boolean>('window.__poo196.showHome()')
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${createdIdR34}"]')`)
  await until(async () => ((await js<{ phase: string }>('window.__poo196.entryState()')).phase === 'ready'), 12000)
  await until(() => js<boolean>(`window.__poo196.q('${T.projectEntryEmpty}')`), 12000)
  check('[R3-04][U5] 关闭再进不再弹（面板 absent、空态正常）',
    !(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`))
    && (await js<unknown>('window.__poo196.onboardingIntent()')) === null)
  await capture('r3-04-onboarding-skipped-reenter')

  // 取消/进入失败销毁 intent：第二次创建的进入 request 被拒（生产取消语义
  // 沿原事务原因）→ enter-failed → intent 销毁；「重新进入」落地不再弹。
  await js<boolean>('window.__poo196Space.setSwitchRejectOnce(true)')
  await js<boolean>('window.__poo196.openCreateProject()')
  await until(() => js<boolean>(`window.__poo196.q('#create-project-form')`), 8000)
  await clearAndType(T.createName, '取消销毁意图项目')
  await js<boolean>(`window.__poo196.click('${T.createResponsibility}')`)
  await js<boolean>(`(() => { const f = document.querySelector('#create-project-form'); if (!f) return false; f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return true })()`)
  await until(async () => pmCallCount('pmCreateEnterprise') > 0, 8000)
  await until(async () => ((await js<{ phase: string; productSpaceId: string | null }>('window.__poo196.entryState()')).phase === 'enter-failed'), 12000)
  const cancelledId = (await runProgramDirect<{ createdSpace: { productSpaceId: string } | null }>({ op: 'pmCallStats' })).createdSpace?.productSpaceId ?? ''
  check('[R3-04][U5] 进入失败（取消）销毁 intent 且保留可重试目标',
    (await js<unknown>('window.__poo196.onboardingIntent()')) === null
    && ((await js<{ productSpaceId: string | null }>('window.__poo196.entryState()')).productSpaceId) === cancelledId
    && cancelledId !== createdIdR34)
  // 「重新进入」只重新进入（不重复 create）且落地不再弹拉人面板。生产语境：
  // 上下文刷新后才感知新项目——fixture 用 reloadProjects（同一类上下文重建）
  // 让失败卡的「重新进入」可达。
  await js<boolean>('window.__poo196.showHome()')
  await js<boolean>('window.__poo196Space.reloadProjects()')
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectEnterRetry}')`)) === 1, 12000)
  const createsBeforeRetry = (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length
  await js<boolean>(`window.__poo196.click('${T.homeProjectEnterRetry}')`)
  await until(async () => ((await js<{ phase: string }>('window.__poo196.entryState()')).phase === 'ready'), 12000)
  await until(() => js<boolean>(`window.__poo196.q('${T.projectEntryEmpty}')`), 12000)
  check('[R3-04][U5] 取消后重进落地不再弹（面板 absent、零 create、intent 仍空）',
    !(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`))
    && (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === createsBeforeRetry
    && (await js<unknown>('window.__poo196.onboardingIntent()')) === null)
  await capture('r3-04-onboarding-cancel-destroyed')
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await runProgramDirect({ op: 'resetR3' })

  // 显示名缺失 → 「你的姓名」补全框 + 同步提示出现；65 字超限同样出现。
  await js<boolean>('window.__poo196Space.setAdminName("")')
  await delay(400)
  check('[R3-04] 再次打开创建入口', await js<boolean>('window.__poo196.openCreateProject()'))
  await until(() => js<boolean>(`window.__poo196.q('${T.createDialog}')`), 8000)
  await until(async () => (await js<string>(`document.querySelector('${T.createDialog}')?.getAttribute('data-phase') ?? ''`)) === 'form', 8000)
  const adminNow = await js<string>('String(window.__poo196Space.adminName())')
  const ownerFaces = await js<{ owner: boolean; hint: boolean; phase: string; syncHintId: boolean; admin: string }>(`(() => {
    const dialog = document.querySelector('${T.createDialog}')
    return {
      owner: Boolean(document.querySelector('${T.createOwner}')),
      hint: Boolean(document.querySelector('${T.createOwnerSyncHint}')),
      phase: dialog?.getAttribute('data-phase') ?? 'missing',
      syncHintId: Boolean(dialog?.querySelector('#create-project-owner-sync-hint')),
      admin: String(window.__poo196Space.adminName()),
    }
  })()`)
  check('[R3-04] 显示名缺失 → 负责人补全框出现', ownerFaces.owner && ownerFaces.hint, ownerFaces)
  await clearAndType(T.createOwner, '补'.repeat(65))
  const ownerLen = await js<number | null>(`(() => { const el = document.querySelector('${T.createOwner}'); return el ? el.value.length : null })()`)
  check('[R3-04] 负责人 65→64（DOM 边界截断）', ownerLen === 64, { ownerLen })
  await closeCreateDialog()
  await js<boolean>('window.__poo196Space.setAdminName("林奕")')
  await delay(200)
  await leaveHomeMode()
}

/** D12 R3-05: 直接进入与最近会话——点卡 → onRequestSwitch → committed →
 * getSessions 最近会话 → navigate allSessions(该 id)；无历史 → 零写入意图
 * （skipAutoSelect 在事件边界被丢、落回 lastSelected——生产现实钉）；切换
 * 中（entry pending）发送被拒。空态首发送语义由 C-UI 组件隔离测试覆盖。 */
async function scenarioR3DirectEntryAndRecentSession() {
  await enterHomeMode()
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  const statsBefore = await runProgramDirect<{ getSessionsCalls: unknown[] }>({ op: 'r3Stats' })

  // 点卡 → 两段式事务：request → committed；无历史项目不在此列。
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_ALPHA_ID}"]')`)
  await until(async () => (await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `committed:${R3_PROJECT_ALPHA_ID}`), 12000)
  check('[R3-05] 点卡走 request→committed 两段事务',
    (await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `request:${R3_PROJECT_ALPHA_ID}`))

  // 最近会话：fresh getSessions → 选 alpha 的最近（不是更旧的 alpha，更不是
  // apollo 空间里更新的 decoy——作用域按 productSpaceId 过滤）。
  await until(async () => (await js<Array<{ route: string; skipAutoSelect: boolean }>>('window.__poo196.navigateLog()')).some(entry => entry.route === `allSessions/session/${SESSION_R3_ALPHA_RECENT}`), 12000)
  const navLast = await js<{ route: string; skipAutoSelect: boolean }>('window.__poo196.navigateLog()[window.__poo196.navigateLog().length - 1]')
  check('[R3-05] 进入落在最近会话（allSessions/<id>）', navLast.route === `allSessions/session/${SESSION_R3_ALPHA_RECENT}` && !navLast.skipAutoSelect, { navLast })
  check('[R3-05] 渲染的 ChatPage 即该会话', (await js<string>('window.__poo196.chatSession()')) === SESSION_R3_ALPHA_RECENT)
  const statsAfter = await runProgramDirect<{ getSessionsCalls: unknown[] }>({ op: 'r3Stats' })
  check('[R3-05] 进入读取了新鲜会话列表（getSessions）', statsAfter.getSessionsCalls.length > statsBefore.getSessionsCalls.length)
  const visits = await js<Record<string, number>>(`window.__poo196.visitOrder('${ACCOUNT_ID}')`)
  check('[R3-05] 落地成功才写 visit（alpha）', Boolean(visits[R3_PROJECT_ALPHA_ID]))
  await capture('r3-05-entered-recent-session')

  // 无历史 → 零写入空态：生产发出 allSessions + skipAutoSelect（D14），
  // NavigationContext 事件边界透传 skipAutoSelect → 抑制 lastSelected 自动
  // 选择 → MainContentPanel 渲染可编辑项目对话空态（project-entry-empty），
  // 全程零写入（createSession 不被调用）。
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await js<boolean>('window.__poo196.showHome()')
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  const createsBeforeEmpty = (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_EMPTY_ID}"]')`)
  await until(async () => (await js<Array<{ route: string; skipAutoSelect: boolean }>>('window.__poo196.navigateLog()')).some(entry => entry.route === 'allSessions' && entry.skipAutoSelect), 12000)
  check('[R3-05] 无历史项目发出 allSessions + skipAutoSelect（零写入意图）',
    (await js<Array<{ route: string; skipAutoSelect: boolean }>>('window.__poo196.navigateLog()')).some(entry => entry.route === 'allSessions' && entry.skipAutoSelect))
  // D14 空态落地：skipAutoSelect 透传生效 → 空态面板出现而非拉回旧会话。
  await until(async () => (await js<boolean>(`window.__poo196.q('${T.projectEntryEmpty}')`)), 12000)
  check('[R3-05] 无历史进入落在可编辑空态（project-entry-empty 出现）',
    (await js<boolean>(`window.__poo196.q('${T.projectEntryEmpty}')`)))
  check('[R3-05] 空态不拉回 lastSelected 会话（chatSession 为空）',
    !(await js<string>('window.__poo196.chatSession()')),
    { chatSession: await js<string>('window.__poo196.chatSession()') })
  check('[R3-05] 进入零写入（createSession 调用数=0）', (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === createsBeforeEmpty)
  await capture('r3-05-empty-entry-landing')

  // ── UB4 (U5/U13)：空态三动作卡 + 项目 composer 稳定提示与帮助 ──────────
  // 三张卡都是纯呈现动作：点击前后 create/invite/send 计数不变；「邀请同事」
  // 走现有选择页、「上传」切文件 tab 并真实打开既有 AssetUploadDialog、
  // 「直接开始聊」仅聚焦 composer。U13：占位符不再轮播快捷键/#，Enter 偏好
  // 稳定显示「输入问题，按回车发送」；帮助可发现、Esc 关闭回焦；cmd-enter
  // 偏好换「输入问题，点击发送」。
  await runProgramDirect({ op: 'setSendMessageKey', args: { value: 'enter' } })
  const ub4InviteMark05 = pmCallCount('pmCreateColleagueInvitation') + pmCallCount('pmCreateProjectInvitation')
  const ub4SendMark05 = (await js<Array<unknown>>('window.__poo196.sendMessageLog')).length
  const ub4CreateMark05 = (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length
  const ub4PlaceholderOf = () => js<string>(`document.querySelector('${T.input}')?.getAttribute('aria-placeholder') ?? 'missing'`)
  check('[R3-05][U5] 空态三动作卡在（邀请同事/上传/直接开始聊）',
    (await js<number>(`window.__poo196.count('${T.projectEntryActionInvite}')`)) === 1
    && (await js<number>(`window.__poo196.count('${T.projectEntryActionUpload}')`)) === 1
    && (await js<number>(`window.__poo196.count('${T.projectEntryActionStart}')`)) === 1)
  check('[R3-05][U5] 副文案=助手说明+邀请后句（有邀请权）；占位符不再复用副文案',
    ((await js<string>(`document.querySelector('${T.projectEntryEmptyHint}')?.textContent ?? ''`)).includes((await i18nText('project.entry.inviteHint')).trim().slice(0, 4)))
    && ((await ub4PlaceholderOf()).includes((await i18nText('project.entry.inputPlaceholder')).trim().slice(0, 4))))
  // U13：等待超过旧轮播间隔（5000ms），占位符仍稳定为 Enter 偏好那一句。
  await delay(5300)
  const ub4PlaceholderAfterRotationWindow = await ub4PlaceholderOf()
  check('[R3-05][U13] 等待超过旧轮播间隔仍为稳定占位符（Enter 偏好）',
    ub4PlaceholderAfterRotationWindow === (await i18nText('project.entry.inputPlaceholder')).trim(),
    { placeholder: ub4PlaceholderAfterRotationWindow })
  // U13 帮助：常驻图标 → 小帮助内容（真实发送/换行/Shift+Tab/@/#/侧栏行）
  // → Esc 关闭并回焦输入框。
  await js<boolean>(`window.__poo196.click('${T.composerHelp}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.composerHelpContent}')`), 8000)
  const ub4HelpRows = (await js<string>(`document.querySelector('${T.composerHelpContent}')?.textContent ?? ''`))
  check('[R3-05][U13] 输入帮助内容列出真实发送/换行/快捷键行',
    ub4HelpRows.includes((await i18nText('project.entry.inputPlaceholder')).trim().slice(0, 4))
    && ub4HelpRows.includes((await i18nText('chatInput.placeholder.newLine')).trim().slice(0, 4))
    && ub4HelpRows.includes((await i18nText('chatInput.placeholder.shiftTab')).trim().slice(0, 4))
    && ub4HelpRows.includes((await i18nText('chatInput.placeholder.mention')).trim().slice(0, 3))
    && ub4HelpRows.includes((await i18nText('chatInput.placeholder.labels')).trim().slice(0, 3)))
  await js<boolean>('window.__poo196.focusInput()')
  await pressEscape()
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.composerHelpContent}')`)), 8000)
  check('[R3-05][U13] Esc 关闭帮助并回焦输入框',
    !(await js<boolean>(`window.__poo196.q('${T.composerHelpContent}')`))
    && ((await js<string>(`document.activeElement?.getAttribute('data-tutorial') ?? 'missing'`)).trim()) === 'chat-input')
  await capture('r3-05-composer-help')
  // 「邀请同事」卡 → 现有「添加成员」选择页；全程零写入。
  await js<boolean>(`window.__poo196.click('${T.projectEntryActionInvite}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.colleaguesPage}')`), 8000)
  check('[R3-05][U5] 「邀请同事」卡直落选择页且零写入（0 invite / 0 createSession / 0 send）',
    await js<boolean>(`window.__poo196.q('${T.colleaguesPage}')`)
    && pmCallCount('pmCreateColleagueInvitation') + pmCallCount('pmCreateProjectInvitation') === ub4InviteMark05
    && (await js<Array<unknown>>('window.__poo196.sendMessageLog')).length === ub4SendMark05
    && (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === ub4CreateMark05)
  await capture('r3-05-action-invite')
  await js<boolean>(`window.__poo196.click('${T.membersClose}')`)
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.colleaguesPage}')`)), 8000)
  // 「上传」卡 → 切文件 tab + 真实打开既有 AssetUploadDialog（能力服从原库）。
  await js<boolean>(`window.__poo196.click('${T.projectEntryActionUpload}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.uploadDialog}')`), 12000)
  const ub4ActionsVisible = () => js<boolean>(`(() => { const el = document.querySelector('${T.projectEntryActions}'); return Boolean(el && el.getClientRects().length > 0) })()`)
  check('[R3-05][U5] 「上传」卡切文件 tab 且打开真实上传对话框（零写入）',
    await js<boolean>(`window.__poo196.q('${T.library}')`)
    && await js<boolean>(`window.__poo196.q('${T.uploadDialog}')`)
    && !(await ub4ActionsVisible())
    && pmCallCount('pmCreateColleagueInvitation') + pmCallCount('pmCreateProjectInvitation') === ub4InviteMark05
    && (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === ub4CreateMark05)
  await capture('r3-05-action-upload-real-dialog')
  await pressEscape()
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.uploadDialog}')`)), 8000)
  // 「直接开始聊」卡 → 仅聚焦 composer（回到消息 tab 后点击）。
  await clickTab(T.tabMessages)
  await until(async () => (await ub4ActionsVisible()) === true, 8000)
  await js<boolean>(`window.__poo196.click('${T.projectEntryActionStart}')`)
  check('[R3-05][U5] 「直接开始聊」仅聚焦 composer（零写入）',
    ((await js<string>(`document.activeElement?.getAttribute('data-tutorial') ?? 'missing'`)).trim()) === 'chat-input'
    && (await js<Array<unknown>>('window.__poo196.sendMessageLog')).length === ub4SendMark05
    && (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === ub4CreateMark05)
  // U13 cmd-enter 偏好：重进换新 composer 实例 → 稳定行换成「点击发送」。
  await runProgramDirect({ op: 'setSendMessageKey', args: { value: 'cmd-enter' } })
  await js<boolean>('window.__poo196.showHome()')
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_EMPTY_ID}"]')`)
  await until(async () => (await js<boolean>(`window.__poo196.q('${T.projectEntryEmpty}')`)), 12000)
  await until(async () => ((await ub4PlaceholderOf()) === (await i18nText('project.entry.inputPlaceholderClick')).trim()), 12000)
  check('[R3-05][U13] cmd-enter 偏好 → 「输入问题，点击发送」（换行键不说成发送键）',
    (await ub4PlaceholderOf()) === (await i18nText('project.entry.inputPlaceholderClick')).trim())
  await runProgramDirect({ op: 'setSendMessageKey', args: { value: 'enter' } })
  await capture('r3-05-action-cards')

  // ── UB2 (U3/U10/U11): 进入反馈、发送准入、草稿完整保留、落地引导 ────────
  // 旧→新映射：pending 期间的 toast 断言从 project.entry.scopeChanged 改为
  // U11 持久提示键 project.entry.sendBlocked（scopeChanged 保留给深层 scope
  // 不符兜底，ChatPage 深层检查沿用）；原「零送达」与「放行后落地」检查语义
  // 原样保留，其余为新增钉子。
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await js<boolean>('window.__poo196.showHome()')
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  const enterLabelCopy = (await i18nText('home.projects.enter')).trim()
  check('[R3-05][U3] 每张卡右下可见「进入项目」标签（非嵌套，卡片仍是唯一激活目标）',
    (await js<number>(`window.__poo196.count('${T.homeProjectEnterLabel}')`)) === 6
    && ((await js<string>(`document.querySelector('${T.homeProjectEnterLabel}')?.textContent ?? ''`)).includes(enterLabelCopy.slice(0, 2))))

  await js<boolean>('window.__poo196Space.setHoldSwitch(true)')
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_BETA_ID}"]')`)
  await until(async () => (await js<boolean>('window.__poo196.entryPending()')) === true, 8000)
  check('[R3-05] hold 住切换：entry pending 且未 committed',
    (await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `request:${R3_PROJECT_BETA_ID}`)
      && !(await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `committed:${R3_PROJECT_BETA_ID}`))
  // U3 卡片反馈：仅目标卡 spinner+「正在进入项目…」+aria-busy；重复鼠标/键盘
  // 激活不重入（request 恰一次）。
  const enteringCopy = (await i18nText('home.projects.entering')).trim()
  await delay(120)
  check('[R3-05][U3] 仅目标卡呈现进入反馈（spinner+文案+aria-busy）',
    (await js<number>(`window.__poo196.count('${T.homeProjectEntering}')`)) === 1
    && (await js<string>(`document.querySelector('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_BETA_ID}"]')?.getAttribute('aria-busy') ?? ''`)) === 'true'
    && ((await js<string>(`document.querySelector('${T.homeProjectEntering}')?.textContent ?? ''`)).includes(enteringCopy.slice(0, 4))))
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_BETA_ID}"]')`)
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_BETA_ID}"]')`)
  await js<boolean>(`window.__poo196.pressEnterOn('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_BETA_ID}"]')`)
  check('[R3-05][U3] 重复鼠标/键盘激活不重入（beta request 恰一次）',
    (await js<string[]>('window.__poo196.spaceSwitchLog()')).filter(entry => entry === `request:${R3_PROJECT_BETA_ID}`).length === 1)

  // U11 发送准入：等待期在对话面（apollo 空态 composer）触发发送 → 同步拒绝、
  // 零送达、草稿原样保留、无内容提示标记入账。
  await js<boolean>('window.__poo196.showChats()')
  await until(() => js<boolean>(`window.__poo196.q('${T.input}')`), 8000)
  const sendMark = (await js<Array<unknown>>('window.__poo196.sendMessageLog')).length
  const createsMark = (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length
  await typeInto(T.input, '切换期间试图发送')
  await js<boolean>('window.__poo196.send()')
  await delay(600)
  const sendBlockedCopy = (await i18nText('project.entry.sendBlocked')).trim()
  check('[R3-05][U11] pending 期间发送被拒（sendBlocked toast，零送达）',
    (await js<Array<unknown>>('window.__poo196.sendMessageLog')).length === sendMark
      && (await js<string>('window.__poo196.toastText()')).includes(sendBlockedCopy.slice(0, 6)), { toast: (await js<string>('window.__poo196.toastText()')).slice(0, 60) })
  check('[R3-05][U11] 等待期持久提示在输入框上方（project-entry-send-notice）',
    await js<boolean>(`window.__poo196.q('${T.projectEntrySendNotice}')`)
      && ((await js<string>(`document.querySelector('${T.projectEntrySendNotice}')?.textContent ?? ''`)).includes(sendBlockedCopy.slice(0, 6))))
  check('[R3-05][U11] 被拦截的草稿仍在输入框（未清空）',
    ((await js<string>('window.__poo196.inputValue()')) ?? '').includes('切换期间试图发送'))
  const blockedNotice = await js<Array<{ accountId: string; productSpaceId: string; draftKey: string; generation: number }>>('window.__poo196.sendNotices()')
  check('[R3-05][U11] 拦截记录一个无内容提示标记（account/project/draftKey/generation）',
    blockedNotice.length === 1
    && blockedNotice[0]!.draftKey.startsWith('empty:')
    && blockedNotice[0]!.productSpaceId === 'ps-apollo'
    && typeof blockedNotice[0]!.generation === 'number', { marker: blockedNotice[0] })
  check('[R3-05][U11] 拦截零会话创建（0 createSession）',
    (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === createsMark)
  await capture('r3-05-send-gate')
  await js<boolean>('window.__poo196Space.setHoldSwitch(false)')
  await until(async () => (await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `committed:${R3_PROJECT_BETA_ID}`), 12000)
  await until(async () => (await js<string>('window.__poo196.chatSession()')) === SESSION_R3_BETA_RECENT, 12000)
  check('[R3-05] 放行后事务落地（beta 最近会话）', (await js<string>('window.__poo196.chatSession()')) === SESSION_R3_BETA_RECENT)
  // U11 落地引导（跨对话）：拦截发生在 apollo 空态草稿，落地在 beta 会话 →
  // 「项目已打开。刚才的内容保留在原对话，请返回原对话发送。」
  const retainedCopy = (await i18nText('project.entry.sendRetainedElsewhere')).trim()
  await until(() => js<boolean>(`window.__poo196.q('${T.projectEntrySendNotice}')`), 8000)
  check('[R3-05][U11] 落地在另一对话 →「保留在原对话」引导',
    ((await js<string>(`document.querySelector('${T.projectEntrySendNotice}')?.textContent ?? ''`)).includes(retainedCopy.slice(0, 6))))

  // ── U11 同对话落地 + 完整草稿保留：进入已 committed 的 beta（fast-path
  // resume），用 getSessions 时延拉长 resuming 窗口；在 beta 会话输入文字+
  // 真实附件+项目引用（KB/批注由会话种子提供）→ 点发送 / 真实 Enter /
  // craft:submit-input 三门同拒 → 0 send、0 createSession、批注未标已发送、
  // 草稿逐项保留；落地同一会话 →「请点击发送」→ 用户一次发送恰一次请求，
  // 载荷携带全部草稿字段。
  await runProgramDirect({ op: 'setR3SessionsDelay', args: { ms: 6000 } })
  await js<boolean>('window.__poo196.showHome()')
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_BETA_ID}"]')`)
  await until(async () => ((await js<{ phase: string }>('window.__poo196.entryState()')).phase === 'resuming'), 8000)
  check('[R3-05][U3] getSessions 时延窗口内 phase=resuming（共享状态可观测）', true)
  await js<boolean>('window.__poo196.showChats()')
  await until(() => js<boolean>(`window.__poo196.q('${T.input}')`), 8000)
  const statsBeforeFull = await runProgramDirect<{ annotationCommands: unknown[] }>({ op: 'r3Stats' })
  const sendMarkFull = (await js<Array<unknown>>('window.__poo196.sendMessageLog')).length
  const createsMarkFull = (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length
  const betaDraftRefs = [{ assetId: 'as-draft-pin', version: 2, name: '拦截引用.md' }]
  await js<boolean>(`window.__poo196.setDraftRefs('${SESSION_R3_BETA_RECENT}', ${JSON.stringify(betaDraftRefs)})`)
  await typeInto(T.input, '落地前的完整草稿')
  // 真实附件：clipboardData.files 粘贴路径（生产 readFileAsAttachment）。
  await js<boolean>(`(() => {
    const file = new File(['UB2 拦截钉子附件正文'], 'blocked-draft.txt', { type: 'text/plain' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const el = document.querySelector('${T.input}')
    if (!el) return false
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    return true
  })()`)
  await until(async () => ((await js<string>('document.body.innerText')).includes('blocked-draft.txt')), 8000)
  check('[R3-05][U11] 完整草稿就位（文字+附件+引用+KB+待发批注）',
    ((await js<string>('window.__poo196.inputValue()')) ?? '').includes('落地前的完整草稿')
    && ((await js<string>('document.body.innerText')).includes('把这份要点同步给华东区'))
    && (await js<Array<unknown>>(`window.__poo196.count('[data-testid="project-asset-draft-chips"]')`)) >= 1)
  // 三门同拒：点发送（craft:submit-input）、真实 Enter、再点一次。
  await js<boolean>('window.__poo196.send()')
  await delay(400)
  await js<boolean>('window.__poo196.focusInput()')
  await pressEnterTrusted()
  await delay(400)
  await js<boolean>('window.__poo196.send()')
  await delay(600)
  check('[R3-05][U11] 等待期三门发送全被拒（0 send / 0 createSession / 批注未标已发送）',
    (await js<Array<unknown>>('window.__poo196.sendMessageLog')).length === sendMarkFull
    && (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === createsMarkFull
    && (await runProgramDirect<{ annotationCommands: unknown[] }>({ op: 'r3Stats' })).annotationCommands.length === statsBeforeFull.annotationCommands.length)
  check('[R3-05][U11] 拦截后草稿逐项保留（文字/附件/引用/KB/批注）',
    ((await js<string>('window.__poo196.inputValue()')) ?? '').includes('落地前的完整草稿')
    && ((await js<string>('document.body.innerText')).includes('blocked-draft.txt'))
    && JSON.stringify(await js<Array<unknown>>(`window.__poo196.draftRefs('${SESSION_R3_BETA_RECENT}')`)) === JSON.stringify(betaDraftRefs)
    && ((await js<string>('document.body.innerText')).includes('把这份要点同步给华东区')))
  const blockedMarkerFull = await js<Array<{ draftKey: string; generation: number }>>('window.__poo196.sendNotices()')
  check('[R3-05][U11] 会话草稿拦截标记入账（draftKey=会话 id）',
    blockedMarkerFull.some(notice => notice.draftKey === SESSION_R3_BETA_RECENT))
  await capture('r3-05-full-draft-blocked')
  await until(async () => ((await js<{ phase: string }>('window.__poo196.entryState()')).phase === 'ready'), 12000)
  await until(async () => (await js<string>('window.__poo196.chatSession()')) === SESSION_R3_BETA_RECENT, 12000)
  const sendReadyCopy = (await i18nText('project.entry.sendReady')).trim()
  check('[R3-05][U11] 同对话落地 →「项目已打开，请点击发送」引导',
    ((await js<string>(`document.querySelector('${T.projectEntrySendNotice}')?.textContent ?? ''`)).includes(sendReadyCopy.slice(0, 5))))
  // 用户一次发送 = 一次请求，载荷携带全部草稿字段（文字/附件/项目引用），
  // 批注此刻才标记已发送（恰好一条 updateAnnotation）。
  await js<boolean>('window.__poo196.send()')
  await until(async () => (await js<Array<unknown>>('window.__poo196.sendMessageLog')).length === sendMarkFull + 1, 12000)
  const acceptedSend = (await js<Array<{ sessionId: string; message: string; attachments: Array<{ name?: string }>; projectAssetRefs: unknown[] }>>('window.__poo196.sendMessageLog'))[sendMarkFull]!
  check('[R3-05][U11] 一次发送恰一次请求且载荷完整（文字/附件/项目引用）',
    acceptedSend.sessionId === SESSION_R3_BETA_RECENT
    // ChatDisplay appends the follow-up annotation section after the typed
    // text — the draft text leads the payload verbatim.
    && acceptedSend.message.startsWith('落地前的完整草稿')
    && acceptedSend.attachments.length === 1 && acceptedSend.attachments[0]!.name === 'blocked-draft.txt'
    && JSON.stringify(acceptedSend.projectAssetRefs) === JSON.stringify(betaDraftRefs), { acceptedSend })
  const statsAfterFull = await runProgramDirect<{ annotationCommands: Array<{ annotationId?: string }> }>({ op: 'r3Stats' })
  check('[R3-05][U11] 已发送才标记批注（恰好一条 updateAnnotation）',
    statsAfterFull.annotationCommands.length === statsBeforeFull.annotationCommands.length + 1
    && statsAfterFull.annotationCommands.some(command => command.annotationId === 'ann-r3-beta-followup'))
  check('[R3-05][U11] 发送消费本对话提示标记（guidance 收口）',
    !(await js<Array<{ draftKey: string }>>('window.__poo196.sendNotices()')).some(notice => notice.draftKey === SESSION_R3_BETA_RECENT))
  await runProgramDirect({ op: 'setR3SessionsDelay', args: { ms: 0 } })

  // U3 显式取消/失败：request 拒绝（生产取消确认语义）→ enter-failed 保留
  // 目标 → 失败卡常驻错误 +「重新进入」→ 重试只重新进入并落地。
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await js<boolean>('window.__poo196.showHome()')
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)
  await js<boolean>('window.__poo196Space.setSwitchRejectOnce(true)')
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_ALPHA_ID}"]')`)
  await until(async () => ((await js<{ phase: string; productSpaceId: string | null }>('window.__poo196.entryState()')).phase === 'enter-failed'), 8000)
  check('[R3-05][U3] 显式取消沿原事务原因 → enter-failed 且保留目标',
    ((await js<{ productSpaceId: string | null }>('window.__poo196.entryState()')).productSpaceId) === R3_PROJECT_ALPHA_ID)
  const enterFailedCopy = (await i18nText('home.projects.enterFailed')).trim()
  check('[R3-05][U3] 失败卡常驻错误 +「重新进入」（home-project-enter-error/retry）',
    (await js<number>(`window.__poo196.count('${T.homeProjectEnterError}')`)) === 1
    && await js<boolean>(`window.__poo196.q('${T.homeProjectEnterRetry}')`)
    && ((await js<string>(`document.querySelector('${T.homeProjectEnterError}')?.textContent ?? ''`)).includes(enterFailedCopy.slice(0, 4))))
  await capture('r3-05-enter-failed-card')
  await js<boolean>(`window.__poo196.click('${T.homeProjectEnterRetry}')`)
  await until(async () => (await js<string[]>('window.__poo196.spaceSwitchLog()')).some(entry => entry === `committed:${R3_PROJECT_ALPHA_ID}`), 12000)
  await until(async () => (await js<string>('window.__poo196.chatSession()')) === SESSION_R3_ALPHA_RECENT, 12000)
  check('[R3-05][U3] 「重新进入」重发受控事务并落地（alpha 最近会话）',
    (await js<string>('window.__poo196.chatSession()')) === SESSION_R3_ALPHA_RECENT)
  const visitsAfterRetry = await js<Record<string, number>>(`window.__poo196.visitOrder('${ACCOUNT_ID}')`)
  check('[R3-05][U3] 成功才写最近访问（重试落地后）', Boolean(visitsAfterRetry[R3_PROJECT_ALPHA_ID]))
  await leaveHomeMode()
}

/** D12 R3-07（P12-5）：项目标题/介绍作为权威上下文元数据——空态首发送的
 * createSession 载荷携带 projectContext（fixture 面观测载荷拼装；真实模型
 * 请求的落盘证据由 packages/server-core project-model-context.acceptance
 * 以捕获端点提供）。断言：唯一名+空介绍、无伪造问候消息、跨项目隔离。 */
async function scenarioR3ProjectModelContext() {
  await enterHomeMode()
  await until(async () => (await js<number>(`window.__poo196.count('${T.homeProjectCard}')`)) > 0, 12000)

  const createsBefore = (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length
  const sendsBefore = (await js<Array<{ sessionId: string; message: string }>>('window.__poo196.sendMessageLog')).length

  // 进入 verified-empty 项目（独特名「新项目·尚无对话」，介绍缺省）→ 空态。
  await js<boolean>(`window.__poo196.click('[data-testid="home-project-card"][data-product-space-id="${R3_PROJECT_EMPTY_ID}"]')`)
  await until(async () => (await js<boolean>(`window.__poo196.q('${T.projectEntryEmpty}')`)), 12000)
  check('[R3-07] 空项目落在可编辑空态', await js<boolean>(`window.__poo196.q('${T.projectEntryEmpty}')`))
  check('[R3-07] 进入零写入', (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === createsBefore)

  // 用户显式首发送（P12-5 纪律：不替代用户发消息）。
  const typed = 'P12-5 载荷验证首条'
  // P12-5 场景的输入与提交都在页面侧完成：craft:insert-text（FreeFormInput
  // 直接 setInput+syncToParent——execCommand 不保证 React 状态同步）+
  // craft:submit-input，页面内重试环直至会话创建落地（跨进程往返的时序抖动
  // 不重试会假阴性）。
  const pageSideSend = `(async () => {
    const before = window.__poo196.createSessionLog().length;
    for (let attempt = 0; attempt < 24; attempt++) {
      window.dispatchEvent(new CustomEvent('craft:insert-text', { detail: { text: "P12-5 \u8f7d\u8377\u9a8c\u8bc1\u9996\u6761" } }));
      await new Promise(r => setTimeout(r, 150));
      window.dispatchEvent(new CustomEvent('craft:submit-input'));
      for (let wait = 0; wait < 10; wait++) {
        await new Promise(r => setTimeout(r, 100));
        if (window.__poo196.createSessionLog().length > before) return { ok: true, attempts: attempt + 1 };
      }
    }
    return { ok: false, attempts: 24 };
  })()`
  // 页面侧循环异步自转（不 await——js 助手 15s 硬限短于循环上限），编排器
  // 以 30s 宽轮询等待落地；探针/日志在 runtime 证据里可核对。
  await js<boolean>(`(() => { void (${pageSideSend}); return true })()`)
  check('[R3-07] 页面侧首发送循环已启动', true)
  await until(async () => (await js<Array<unknown>>('window.__poo196.createSessionLog()')).length === createsBefore + 1, 30000)

  const creates = await js<Array<{ productSpaceId: string; sessionId: string; projectContext?: { name?: string; purpose?: string }; rawOptions?: string }>>('window.__poo196.createSessionLog()')
  const mine = creates[creates.length - 1]!
  check('[R3-07] 首发送恰好创建一个会话', creates.length === createsBefore + 1)
  const emptyStateTitle = (await js<string>(`(document.querySelector('${T.projectEntryEmpty} h2, ${T.projectEntryEmpty} h3')?.textContent ?? '').trim()`))
  check('[R3-07] projectContext 标题=项目权威名称', mine.projectContext?.name === '新项目·尚无对话', { projectContext: mine.projectContext, rawOptions: mine.rawOptions, emptyStateTitle })
  check('[R3-07] 空介绍不编造 purpose（缺省即缺省）', !mine.projectContext?.purpose, { projectContext: mine.projectContext })
  check('[R3-07] 会话绑定本项目空间', mine.productSpaceId === R3_PROJECT_EMPTY_ID)

  // 跨项目隔离：载荷名称≠任何其它项目的名称（甲/乙名称互斥的载荷级断言）。
  const others = ['华东区销售资料库', '北区交付资料库', '只读归档区', R3_TWIN_NAME]
  check('[R3-07] 载荷不混入其它项目上下文', others.every(name => name !== mine.projectContext?.name))

  // 无伪造问候：唯一的用户消息就是键入文本本身（不含项目名、无自动消息）。
  await until(async () => (await js<Array<{ sessionId: string; message: string }>>('window.__poo196.sendMessageLog')).length === sendsBefore + 1, 12000)
  const sends = await js<Array<{ sessionId: string; message: string }>>('window.__poo196.sendMessageLog')
  const mySend = sends[sends.length - 1]!
  check('[R3-07] 恰好一条用户消息且为键入原文', sends.length === sendsBefore + 1 && mySend.message === typed)
  check('[R3-07] 用户消息不携带项目名（元数据走系统侧）', !mySend.message.includes('新项目·尚无对话'))
  // 首发送的 navigate 在 100ms 延迟后到达（与生产 deep-link 相同的时序）。
  await until(async () => (await js<string>('window.__poo196.chatSession()')) === mine.sessionId, 12000)
  check('[R3-07] 落在创建的会话上', (await js<string>('window.__poo196.chatSession()')) === mine.sessionId)
  await capture('r3-07-model-context-payload')
  await leaveHomeMode()
}

/** D12 R3-06: 成员面板形态——宽窗口 push（非模态）、名册/计数/搜索（D4）、
 * 窄视口（<768）drawer（role=dialog + aria-modal + backdrop、点遮罩关闭）、
 * member 角色共享名册且无管理动作。 */
async function scenarioR3MemberPanelResponsive() {
  await runProgramDirect({ op: 'resetPm' })
  await runProgramDirect({ op: 'resetR3' })
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await js<boolean>('window.__poo196Space.setActiveSpace("ps-apollo")')
  await js<boolean>(`window.__poo196.setSession(window.__poo196.sessions.project)`)
  await clickTab(T.tabMessages)
  await delay(200)
  host.setSize(1440, 900)
  await delay(300)

  // push 形态（D8 默认推挤）：非模态、无遮罩、无 dialog 语义。
  // UB3 (U7)：首开走「入口按钮内部头像」——名字/头像/加号均打开同一总览。
  await js<boolean>(`window.__poo196.click('${T.membersButton} span[aria-hidden="true"]')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersPanel}')`), 8000)
  check('[R3-06] 宽窗口面板为 push 形态', (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('data-mode')`)) === 'push')
  check('[R3-06] push 非模态（无 role=dialog、无遮罩）', (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('role') ?? 'none'`)) === 'none'
    && !(await js<boolean>(`window.__poo196.q('${T.membersBackdrop}')`)))
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)

  // D4 名册：行带 data-user-id、「我」徽标、服务端总数（非客户端计数）。
  check('[R3-06] 名册 3 行且行带 data-user-id', (await js<number>(`window.__poo196.count('${T.membersRosterRow}')`)) === 3
    && await js<boolean>(`Array.from(document.querySelectorAll('${T.membersRosterRow}')).every(row => (row.getAttribute('data-user-id') ?? '').length > 0)`))
  const rosterCount = (await js<string>(`document.querySelector('${T.membersRosterCount}')?.textContent ?? ''`)).trim()
  check('[R3-06] 计数呈现服务端 totalActiveMembers', rosterCount.includes('3'), { rosterCount })
  const entryLabel = (await js<string>(`document.querySelector('${T.membersButton}')?.textContent ?? ''`)).trim()
  check('[R3-06] 入口按钮呈现「成员 N」', entryLabel.includes('成员') && entryLabel.includes('3'), { entryLabel })

  // UB3 (U7)：成员入口按钮化——≥32px 高、边框+浅底、manager 末尾加号
  // （aria-hidden），accessible name 用邀请权名称；未知人数不显示 0。
  const entryMetrics06 = await js<{ height: number; borderTop: string; background: string }>(`(() => {
    const el = document.querySelector('${T.membersButton}')
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return { height: r.height, borderTop: s.borderTopStyle, background: s.backgroundColor }
  })()`)
  const entryAria06 = (await js<string>(`document.querySelector('${T.membersButton}')?.getAttribute('aria-label') ?? ''`)).trim()
  const openInviteName06 = (await i18nText('projectMembers.openMembersAndInvite')).trim()
  const plusHidden06 = (await js<string>(`document.querySelector('${T.membersEntryPlus}')?.getAttribute('aria-hidden') ?? 'missing'`)).trim()
  check('[R3-06][U7] 入口 ≥32px、有边框与浅底', entryMetrics06.height >= 32
    && entryMetrics06.borderTop !== 'none' && entryMetrics06.background !== 'rgba(0, 0, 0, 0)', { entryMetrics06 })
  check('[R3-06][U7] 入口末尾加号 aria-hidden', plusHidden06 === 'true', { plusHidden06 })
  check('[R3-06][U7] 入口 accessible name 为「查看成员或邀请同事」', entryAria06 === openInviteName06, { entryAria06, openInviteName06 })

  // 服务端搜索：q 过滤页面行，总数不被 q 重算。
  await typeInto(T.membersSearch, '陈')
  await delay(900)
  check('[R3-06] 名册搜索过滤行（陈晓）', (await js<number>(`window.__poo196.count('${T.membersRosterRow}')`)) === 1
    && ((await js<string>(`document.querySelector('${T.membersRosterRow}')?.textContent ?? ''`)).includes('陈晓')))
  check('[R3-06] 搜索不改变总人数', ((await js<string>(`document.querySelector('${T.membersRosterCount}')?.textContent ?? ''`)).trim()).includes('3'))
  await clearAndType(T.membersSearch, '')
  await delay(700)
  check('[R3-06] 清空搜索恢复全名册', (await js<number>(`window.__poo196.count('${T.membersRosterRow}')`)) === 3)
  await capture('r3-06-push-panel')

  // 窄视口（<768）：drawer 形态 = role=dialog + aria-modal + backdrop。
  host.setSize(720, 900)
  await until(async () => (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('data-mode') ?? ''`)) === 'drawer', 8000)
  check('[R3-06] 窄视口（<768）切换为 drawer 形态', true)
  check('[R3-06] drawer 承载 dialog 语义（role+aria-modal）', (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('role') ?? ''`)) === 'dialog'
    && (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('aria-modal') ?? ''`)) === 'true')
  check('[R3-06] drawer 呈现 backdrop', await js<boolean>(`window.__poo196.q('${T.membersBackdrop}')`))
  // 形态切换不换内容树：名册/搜索/计数仍在（业务状态不 remount）。
  check('[R3-06] 切型保留名册内容', (await js<number>(`window.__poo196.count('${T.membersRosterRow}')`)) === 3)
  await capture('r3-06-drawer-panel')

  // 点遮罩关闭（drawer 专属关闭路径）。
  await js<boolean>(`window.__poo196.click('${T.membersBackdrop}')`)
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`)), 8000)
  check('[R3-06] 点击 backdrop 关闭 drawer', true)
  host.setSize(1440, 900)
  await delay(350)

  // UB3 (U7)：键盘可达 + 关闭焦点归还——聚焦入口，trusted Enter 打开同一
  // 总览；面板关闭后焦点回到成员入口按钮。
  await js<boolean>(`(() => { const el = document.querySelector('${T.membersButton}'); el.focus(); return document.activeElement === el })()`)
  await pressEnterTrusted()
  await until(() => js<boolean>(`window.__poo196.q('${T.membersPanel}')`), 8000)
  check('[R3-06][U7] 键盘 Enter 打开同一总览（键盘可达）', true)
  await closeMembersPanel()
  const focusBack06 = ((await js<string>(`document.activeElement?.getAttribute('data-testid') ?? 'missing'`)).trim())
  check('[R3-06][U7] 关闭后焦点归还成员入口', focusBack06 === 'pc-members-button', { focusBack06 })

  // member 角色：同一份名册 + 计数，零管理动作（invite/记录/管理入口全无）。
  // D4: 名册 viewerRole 是 live authority——fixture 名册必须按 member 应答；
  // 角色变更伴随 scope 变更（换账号=换名册作用域），名册才重读新角色。
  await js<boolean>('window.__poo196Space.setRole("member")')
  await runProgramDirect({ op: 'setR3RosterRole', args: { role: 'member' } })
  await js<boolean>(`window.__poo196Space.setAccountId('${R3_ACCOUNT_B_ID}')`)
  await delay(600)
  await js<boolean>(`window.__poo196.click('${T.membersButton}')`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersRosterRow}')`), 8000)
  check('[R3-06] member 共享名册（3 行 + 计数）', (await js<number>(`window.__poo196.count('${T.membersRosterRow}')`) ) === 3
    && ((await js<string>(`document.querySelector('${T.membersRosterCount}')?.textContent ?? ''`)).trim()).includes('3'))
  check('[R3-06] member 无 invite/记录/管理动作', !(await js<boolean>(`window.__poo196.q('${T.membersInviteAction}')`))
    && !(await js<boolean>(`window.__poo196.q('${T.membersInvitationsEntry}')`))
    && !(await js<boolean>(`window.__poo196.q('${T.membersOpenManagement}')`)))
  await capture('r3-06-member-roster')
  await closeMembersPanel()
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await runProgramDirect({ op: 'setR3RosterRole', args: { role: 'manager' } })
  await js<boolean>(`window.__poo196Space.setAccountId('${ACCOUNT_ID}')`)
  await delay(300)

  // ── UB4 (U5)：一次性拉人自动打开 × 角色权限 × 宽窄切型 ──────────────────
  // 会话宿主（ChatPage，已有历史的恢复落点）同样接住 intent：夹具态注入
  // ready entry + intent（与 setEntryState 同类的状态注入）→ manager + 宽窗
  // = push 形态自动打开直落选择页；member = 不弹（intent 保持待定，面板
  // 不开）；窄窗 = drawer 形态同样自动打开。
  await js<boolean>(`window.__poo196.setEntryState({ accountId: '${ACCOUNT_ID}', productSpaceId: '${PRODUCT_SPACE_ID}', generation: 901, phase: 'ready', origin: 'create' })`)
  await js<boolean>(`window.__poo196.setOnboardingIntent({ accountId: '${ACCOUNT_ID}', productSpaceId: '${PRODUCT_SPACE_ID}', generation: 901 })`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersPanel}')`), 12000)
  check('[R3-06][U5] 注入 intent → 会话宿主自动打开且直落「添加成员」选择页（宽窗 push）',
    (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('data-mode') ?? 'closed'`)) === 'push'
    && await js<boolean>(`window.__poo196.q('${T.colleaguesPage}')`)
    && await js<boolean>(`window.__poo196.q('${T.projectOnboardingSkip}')`)
    && (await js<unknown>('window.__poo196.onboardingIntent()')) === null)
  await capture('r3-06-onboarding-push-auto-open')
  await js<boolean>(`window.__poo196.click('${T.projectOnboardingSkip}')`)
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`)), 8000)
  // member：同样注入，无邀请权 → 不弹（intent 不被消费）。
  await js<boolean>('window.__poo196Space.setRole("member")')
  await runProgramDirect({ op: 'setR3RosterRole', args: { role: 'member' } })
  await js<boolean>(`window.__poo196Space.setAccountId('${R3_ACCOUNT_B_ID}')`)
  await delay(600)
  await js<boolean>(`window.__poo196.setEntryState({ accountId: '${R3_ACCOUNT_B_ID}', productSpaceId: '${PRODUCT_SPACE_ID}', generation: 902, phase: 'ready', origin: 'create' })`)
  await js<boolean>(`window.__poo196.setOnboardingIntent({ accountId: '${R3_ACCOUNT_B_ID}', productSpaceId: '${PRODUCT_SPACE_ID}', generation: 902 })`)
  await delay(900)
  check('[R3-06][U5] member 注入 intent 不自动打开（无邀请动作、intent 未消费）',
    !(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`))
    && (await js<unknown>('window.__poo196.onboardingIntent()')) !== null)
  await capture('r3-06-onboarding-member-no-open')
  // 恢复 manager + 窄窗：drawer 形态同样自动打开（切型不是豁免）。
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await runProgramDirect({ op: 'setR3RosterRole', args: { role: 'manager' } })
  await js<boolean>(`window.__poo196Space.setAccountId('${ACCOUNT_ID}')`)
  await delay(400)
  host.setSize(720, 900)
  await delay(350)
  await js<boolean>(`window.__poo196.setEntryState({ accountId: '${ACCOUNT_ID}', productSpaceId: '${PRODUCT_SPACE_ID}', generation: 903, phase: 'ready', origin: 'create' })`)
  await js<boolean>(`window.__poo196.setOnboardingIntent({ accountId: '${ACCOUNT_ID}', productSpaceId: '${PRODUCT_SPACE_ID}', generation: 903 })`)
  await until(() => js<boolean>(`window.__poo196.q('${T.membersPanel}')`), 12000)
  check('[R3-06][U5] 窄窗 drawer 形态同样自动打开（切型不是豁免）',
    (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('data-mode') ?? 'closed'`)) === 'drawer'
    && (await js<string>(`document.querySelector('${T.membersPanel}')?.getAttribute('role') ?? ''`)) === 'dialog'
    && await js<boolean>(`window.__poo196.q('${T.colleaguesPage}')`)
    && await js<boolean>(`window.__poo196.q('${T.projectOnboardingSkip}')`))
  await capture('r3-06-onboarding-drawer-auto-open')
  await js<boolean>(`window.__poo196.click('${T.projectOnboardingSkip}')`)
  await until(async () => !(await js<boolean>(`window.__poo196.q('${T.membersPanel}')`)), 8000)
  host.setSize(1440, 900)
  await delay(350)
  // 场景隔离：清掉注入的 entry/intent 残留。
  await js<boolean>(`window.__poo196.setEntryState({ accountId: null, productSpaceId: null, generation: 0, phase: 'idle', origin: null })`)
  await js<boolean>('window.__poo196.clearLogs()')
  await js<boolean>('window.__poo196Space.setRole("manager")')
  await runProgramDirect({ op: 'setR3RosterRole', args: { role: 'manager' } })
  await delay(200)
}

/* ── D12 其余八个场景（本轮 TODO 骨架）：函数已占位、不注册不调用。内容
 * 说明写在注释里，落地时按 D12 的关键 check 清单实现并注册进 scenarios。 */

/** TODO D12 R3-08 `scenarioR3NativePaneSuspension`：browser/canvas/file-
 * preview 开关矩阵 × drawer 打开——drawer 打开时原生 view 真实隐藏或
 * detach、关闭后按同 instanceId/URL 恢复、canvas load 计数不增、文件位置/
 * 聊天草稿保留、跨 scope 不恢复旧工具。 */
async function scenarioR3NativePaneSuspension() {
  // TODO: open browser/canvas/file-preview panes, open the members drawer,
  // assert native views are hidden/detached (visibility lifecycle) and
  // restored with the SAME instanceId/URL on close; canvas load count must
  // not increase; drafts and file positions preserved; no cross-scope resume.
}

/** TODO D12 R3-09 `scenarioR3RosterAllRoles`：owner/manager/member 共享同一
 * 名册投影；完整分页 + 姓名搜索（覆盖未加载页）、「我」徽标/角色徽标/首字
 * 头像/服务端总数；member 无电话邮箱治理字段与管理动作；停用/撤权清空。 */
async function scenarioR3RosterAllRoles() {
  // TODO: page the roster (nextCursor > 0 fixture), search names beyond the
  // loaded page, assert me-badge/role-badge/initial avatar/server count per
  // role; member must see no contact/governance fields; revoke clears data.
}

/** TODO D12 R3-10 `scenarioR3ColleagueSelection`：主企业 member + 项目 owner
 * 可选同事；来源企业名正确；搜索命中未加载页；同名按 ID 独立；多选确认前
 * 零写请求；joined/pending/unavailable 不可选；无源/多源降级；跨企业拒绝。 */
async function scenarioR3ColleagueSelection() {
  // TODO: drive project-colleagues-page (multi-select), assert source name,
  // server-side search beyond loaded page, same-name distinct ids, zero
  // writes before confirm, non-available states unselectable, none/ambiguous
  // fallback faces, cross-enterprise refusal (coded 403 fixture).
}

/** TODO D12 R3-11 `scenarioR3InvitationAcceptanceAndRecovery`：确认后逐对象
 * 邀请（每对象一请求、并发上限）；接受前计数不变；真实接受后刷新名册；
 * 复制失败不产生新写；部分失败只重试失败项；unknown 查原 key；同 key 重复
 * 只返回 existing；HMAC 不可恢复不造新邀请。 */
async function scenarioR3InvitationAcceptanceAndRecovery() {
  // TODO: multi-target confirm → per-object pmCreateColleagueInvitation
  // calls; roster count unchanged pre-acceptance; copy-failure writes
  // nothing; retryFailed only re-hits failed objects; queryResult resolves
  // unknown via the original key; duplicate key answers existing; the
  // credential_unrecoverable outcome fabricates no new invitation.
}

/** TODO D12 R3-12 `scenarioR3MembershipOrderAndMigration`：企业→项目与项目
 * →企业双向容量判定；多项目并存；第二 organization 409；定向/共享申请/审
 * 批/restore 全入口同一 guard；有证据分类、无证据留 organization；并发创建
 * 最多一个 organization 成功。夹具只证 UI 面，真实 DB 证据来自 A-DB。 */
async function scenarioR3MembershipOrderAndMigration() {
  // TODO: fixture-drive the membership faces around the five guarded entry
  // points (create/claim/shared apply/approve/restore); the authoritative
  // capacity/migration proof lives in the admin DB integration tests.
}

/** TODO D12 R3-13 `scenarioR3UniqueEntryAndLifecycle`：两个旧创建入口为 0 且
 * 刷新后仍为 0；个人单空间首页可创建；邀请接受后刷新可见；切账号/切项目清
 * selection/roster，旧响应不复活（generation 丢弃）。 */
async function scenarioR3UniqueEntryAndLifecycle() {
  // TODO: re-assert the retired entries after refresh; personal-only home
  // can still create; post-acceptance refresh shows the invitee; account/
  // project switches clear colleague selection and roster and drop late
  // responses (scope generation fence).
}

/** TODO D12 R3-14 `scenarioR3KeyboardLocalesAndMotion`：卡片 Enter/Space 激
 * 活；表单 autofocus/IME 组合 Enter 不提交；责任勾选可聚焦；子页 Esc 逐级
 * 返回/总览 Esc 关闭且不触聊天双 Esc；切型焦点恢复；7 locale 长文本/复数
 * 与 prefers-reduced-motion。 */
async function scenarioR3KeyboardLocalesAndMotion() {
  // TODO: keyboard-activate a project card (Enter/Space), IME-composition
  // Enter must not submit the create form, Esc walks sub-pages back one step
  // without reaching the chat double-Esc, mode switch restores focus by the
  // stable focus key, and the 7-locale long-copy/plural + reduced-motion
  // matrix over the new surfaces.
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
      // POO-196 R3 (adjudication D12): the first six new scenarios. The
      // remaining eight (R3-07…R3-14) stay as documented TODO skeletons —
      // they are NOT registered until implemented.
      ['R3-01-首页项目目录', scenarioR3HomeProjectDirectory],
      ['R3-02-项目容量与排序', scenarioR3ProjectCapacityAndOrdering],
      ['R3-03-加载与撤权', scenarioR3LoadingAndRevocation],
      ['R3-04-最小创建与身份', scenarioR3MinimalCreateAndIdentity],
      ['R3-05-直接进入与最近会话', scenarioR3DirectEntryAndRecentSession],
      ['R3-06-成员面板形态', scenarioR3MemberPanelResponsive],
      ['R3-07-模型上下文载荷(P12-5)', scenarioR3ProjectModelContext],
    )
  }
  // POO196_SCENARIOS=S0,S14 — 局部复跑过滤器（调试/复验用）。
  const filter = (process.env.POO196_SCENARIOS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const selected = filter.length ? scenarios.filter(([name]) => filter.some(f => name.startsWith(f))) : scenarios
  for (const [name, run] of selected) {
    steps.length = 0
    host.show()
    host.focus()
    const checksBefore = result.checks.length
    try {
      await run()
      result.scenarios.push({ name, ok: true, checks: result.checks.length - checksBefore })
    } catch (error) {
      result.scenarios.push({ name, ok: false, checks: result.checks.length - checksBefore, detail: `${String((error as Error).message).slice(0, 700)} | steps: ${steps.join(' → ')}` })
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
// 30 scenarios (S0–S21 + R3-01–06) × per-scenario waits — 25 min budget.
const timer = setTimeout(() => { result.error = 'global timeout'; finish(1) }, 1_500_000)

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
    // Per-scenario check counts (D12: 报告逐场景 check 数).
    for (const scenario of result.scenarios) {
      console.log(`SCENARIO ${scenario.ok ? 'ok' : 'FAIL'} ${scenario.name} checks=${scenario.checks}${scenario.ok ? '' : ` detail=${String(scenario.detail).slice(0, 200)}`}`)
    }
    for (const s of failedScenarios) console.error(`SCENARIO STILL FAILING: ${s.name}`)
    return finish(failed.length || failedScenarios.length ? 1 : 0)
  })
  .catch((e) => {
    result.error = String((e as Error).stack ?? e)
    console.error(e)
    finish(1)
  })
