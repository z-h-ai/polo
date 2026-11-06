/**
 * POO-196 experience-review fixture data — the ONE source shared by the
 * renderer harness page (sessions/messages seeded through the production
 * atoms) and the main-process fixture store (project assets served through
 * the pc* IPC stubs). Realistic Chinese project content: multi-tag,
 * multi-state (indexed/processing/failed/unsupported), confirmed/unconfirmed,
 * pinned, trashed, multi-version, several uploaders.
 */
import type { Message, Session } from '../../src/shared/types'
import type {
  PcAssetDto,
  PcCapabilitiesResponse,
  PcSearchResponse,
} from '@polo-ai/shared/protocol'

/** Fixture sessions/messages carry runtime extras the production types omit
 * (lastUsedAt ordering hints, per-message projectAssetRefs snapshot chips the
 * ChatDisplay reads). The intersection keeps real-field checking while
 * allowing the extras — the boundary the cast documents is deliberate. */
type FixtureSession = Session & Record<string, unknown>
type FixtureMessage = Message & Record<string, unknown>

export const WORKSPACE_ID = 'ws-apollo'
export const PRODUCT_SPACE_ID = 'ps-apollo'
export const ACCOUNT_ID = 'acct-lin-01'
export const CURRENT_USER_ID = 'u-lin-01'
export const PERSONAL_SPACE_ID = 'ps-personal-lin'

export const SESSION_PROJECT = 'sess-apollo-24'
export const SESSION_PERSONAL = 'sess-personal-notes'
/** R2 扩展: a PROJECT session with NO messages — drives ChatPage's second
 * assembly branch (D-D: 两处装配都要覆盖 the members button). */
export const SESSION_PROJECT_EMPTY = 'sess-apollo-empty'

const now = Date.parse('2026-10-31T09:30:00+08:00')
const iso = (s: string) => s

/** The committed enterprise space the harness presents as active. */
export const productSpaceContextValue = {
  accountId: CURRENT_USER_ID,
  activeProductSpaceId: PRODUCT_SPACE_ID,
  activeProductSpace: {
    id: PRODUCT_SPACE_ID,
    kind: 'enterprise' as const,
    enterpriseId: 'ent-apollo-01',
    name: 'Apollo 项目空间',
    role: 'manager' as const,
    accessMode: 'active' as const,
    payer: { enterpriseId: 'ent-apollo-01', plan: 'enterprise' },
  },
  productSpaces: [
    {
      id: PRODUCT_SPACE_ID,
      kind: 'enterprise' as const,
      enterpriseId: 'ent-apollo-01',
      name: 'Apollo 项目空间',
      role: 'manager' as const,
      accessMode: 'active' as const,
      payer: { enterpriseId: 'ent-apollo-01', plan: 'enterprise' },
    },
    {
      id: PERSONAL_SPACE_ID,
      kind: 'personal' as const,
      name: '我的空间',
      accessMode: 'active' as const,
      payer: { userId: ACCOUNT_ID, plan: 'pro' },
    },
  ],
  allProductSpaces: [
    {
      id: PRODUCT_SPACE_ID,
      kind: 'enterprise' as const,
      enterpriseId: 'ent-apollo-01',
      name: 'Apollo 项目空间',
      role: 'manager' as const,
      accessMode: 'active' as const,
      payer: { enterpriseId: 'ent-apollo-01', plan: 'enterprise' },
    },
    {
      id: PERSONAL_SPACE_ID,
      kind: 'personal' as const,
      name: '我的空间',
      accessMode: 'active' as const,
      payer: { userId: ACCOUNT_ID, plan: 'pro' },
    },
  ],
  membershipListVerified: true,
  personalProductSpaceId: PERSONAL_SPACE_ID,
  productSpaceContextKey: `${ACCOUNT_ID}::${PRODUCT_SPACE_ID}::7`,
  contextVersion: 7,
  pendingSwitch: null,
  onSelectProductSpace: () => {},
  onRefreshProductSpaces: () => null,
  onRecoverActiveProductSpace: async () => true,
  onConfirmStopAndSwitch: () => {},
  onRetryFailedStops: () => {},
  onRetryTargetLoad: () => {},
  onCancelSwitch: () => {},
  onDismissTargetAccessLost: () => {},
  onStopSwitchExecution: () => {},
}

/**
 * The enterprise project library. `uploaderUserId === CURRENT_USER_ID` rows
 * expose the replace entry; `陈晓` rows do not (permission split, D4.1).
 */
export function initialAssets(): PcAssetDto[] {
  return [
    {
      id: 'as-req-doc',
      name: '需求文档 v2.3.docx',
      tags: [
        { id: 'requirement', label: '需求文档', preset: true },
        { id: 'stage', label: '阶段成果', preset: true },
      ],
      uploaderUserId: 'u-chen-02',
      uploaderDisplayName: '陈晓',
      source: { kind: 'file', note: 'PO 平台导出' },
      status: 'active',
      currentVersion: 3,
      revision: 9,
      pinned: true,
      pinnedAt: iso('2026-10-28T10:12:00+08:00'),
      createdAt: iso('2026-09-02T14:00:00+08:00'),
      updatedAt: iso('2026-10-28T10:12:00+08:00'),
      trashedAt: null,
      trashExpiresAt: null,
      deletedById: null,
      current: {
        version: 3,
        sizeBytes: 1_863_211,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        checksumSha256: 'a'.repeat(64),
        createdAt: iso('2026-10-28T10:10:00+08:00'),
        createdById: 'u-chen-02',
        processing: 'indexed',
        confirmedAt: iso('2026-10-29T09:00:00+08:00'),
        confirmedByUserId: 'u-lin-01',
      },
    },
    {
      id: 'as-design-home',
      name: '设计稿-首页.fig',
      tags: [
        { id: 'design', label: '设计稿', preset: true },
        { id: 'stage', label: '阶段成果', preset: true },
      ],
      uploaderUserId: CURRENT_USER_ID,
      uploaderDisplayName: '林奕',
      source: { kind: 'file', note: null },
      status: 'active',
      currentVersion: 2,
      revision: 5,
      pinned: true,
      pinnedAt: iso('2026-10-30T16:40:00+08:00'),
      createdAt: iso('2026-09-20T11:00:00+08:00'),
      updatedAt: iso('2026-10-30T16:40:00+08:00'),
      trashedAt: null,
      trashExpiresAt: null,
      deletedById: null,
      current: {
        version: 2,
        sizeBytes: 24_115_904,
        mime: 'image/figma',
        checksumSha256: 'b'.repeat(64),
        createdAt: iso('2026-10-30T16:38:00+08:00'),
        createdById: CURRENT_USER_ID,
        processing: 'indexed',
        confirmedAt: null,
        confirmedByUserId: null,
      },
    },
    {
      id: 'as-meeting-1030',
      name: '会议纪要-1030.md',
      tags: [{ id: 'meeting', label: '会议纪要', preset: true }],
      uploaderUserId: CURRENT_USER_ID,
      uploaderDisplayName: '林奕',
      source: { kind: 'session', note: '迭代对齐会' },
      status: 'active',
      currentVersion: 1,
      revision: 2,
      pinned: false,
      pinnedAt: null,
      createdAt: iso('2026-10-30T18:20:00+08:00'),
      updatedAt: iso('2026-10-30T18:20:00+08:00'),
      trashedAt: null,
      trashExpiresAt: null,
      deletedById: null,
      current: {
        version: 1,
        sizeBytes: 8_432,
        mime: 'text/markdown',
        checksumSha256: 'c'.repeat(64),
        createdAt: iso('2026-10-30T18:20:00+08:00'),
        createdById: CURRENT_USER_ID,
        processing: 'indexed',
        confirmedAt: null,
        confirmedByUserId: null,
      },
    },
    {
      id: 'as-api-doc',
      name: 'API 接口文档.md',
      tags: [{ id: 'tech', label: '技术方案', preset: true }],
      uploaderUserId: 'u-zhao-03',
      uploaderDisplayName: '赵倩',
      source: { kind: 'file', note: null },
      status: 'active',
      currentVersion: 1,
      revision: 2,
      pinned: false,
      pinnedAt: null,
      createdAt: iso('2026-10-31T08:55:00+08:00'),
      updatedAt: iso('2026-10-31T08:55:00+08:00'),
      trashedAt: null,
      trashExpiresAt: null,
      deletedById: null,
      current: {
        version: 1,
        sizeBytes: 41_192,
        mime: 'text/markdown',
        checksumSha256: 'd'.repeat(64),
        createdAt: iso('2026-10-31T08:55:00+08:00'),
        createdById: 'u-zhao-03',
        processing: 'processing',
        confirmedAt: null,
        confirmedByUserId: null,
      },
    },
    {
      id: 'as-test-plan',
      name: '测试计划-11月.xlsx',
      tags: [
        { id: 'stage', label: '阶段成果', preset: true },
        { id: 'data', label: '数据', preset: true },
      ],
      uploaderUserId: 'u-chen-02',
      uploaderDisplayName: '陈晓',
      source: { kind: 'file', note: null },
      status: 'active',
      currentVersion: 1,
      revision: 2,
      pinned: false,
      pinnedAt: null,
      createdAt: iso('2026-10-29T15:00:00+08:00'),
      updatedAt: iso('2026-10-29T15:04:00+08:00'),
      trashedAt: null,
      trashExpiresAt: null,
      deletedById: null,
      current: {
        version: 1,
        sizeBytes: 512_880,
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        checksumSha256: 'e'.repeat(64),
        createdAt: iso('2026-10-29T15:00:00+08:00'),
        createdById: 'u-chen-02',
        processing: 'failed',
        confirmedAt: null,
        confirmedByUserId: null,
      },
    },
    {
      id: 'as-brand-pdf',
      name: '品牌规范-v1.pdf',
      tags: [{ id: 'source', label: '原始资料', preset: true }],
      uploaderUserId: 'u-chen-02',
      uploaderDisplayName: '陈晓',
      source: { kind: 'file', note: '设计组共享' },
      status: 'active',
      currentVersion: 1,
      revision: 2,
      pinned: false,
      pinnedAt: null,
      createdAt: iso('2026-09-10T09:00:00+08:00'),
      updatedAt: iso('2026-09-10T09:00:00+08:00'),
      trashedAt: null,
      trashExpiresAt: null,
      deletedById: null,
      current: {
        version: 1,
        sizeBytes: 8_912_800,
        mime: 'application/pdf',
        checksumSha256: 'f'.repeat(64),
        createdAt: iso('2026-09-10T09:00:00+08:00'),
        createdById: 'u-chen-02',
        processing: 'unsupported',
        confirmedAt: null,
        confirmedByUserId: null,
      },
    },
    {
      id: 'as-data-dict',
      name: '数据字典.csv',
      tags: [
        { id: 'data', label: '数据', preset: true },
        { id: '客户资料', label: '客户资料', preset: false },
      ],
      uploaderUserId: CURRENT_USER_ID,
      uploaderDisplayName: '林奕',
      source: { kind: 'file', note: null },
      status: 'active',
      currentVersion: 2,
      revision: 4,
      pinned: false,
      pinnedAt: null,
      createdAt: iso('2026-10-12T10:30:00+08:00'),
      updatedAt: iso('2026-10-25T11:11:00+08:00'),
      trashedAt: null,
      trashExpiresAt: null,
      deletedById: null,
      current: {
        version: 2,
        sizeBytes: 128_760,
        mime: 'text/csv',
        checksumSha256: '1'.repeat(64),
        createdAt: iso('2026-10-25T11:10:00+08:00'),
        createdById: CURRENT_USER_ID,
        processing: 'indexed',
        confirmedAt: iso('2026-10-26T09:30:00+08:00'),
        confirmedByUserId: 'u-chen-02',
      },
    },
    {
      id: 'as-prototype-html',
      name: '原型演示-首页.html',
      tags: [{ id: 'design', label: '设计稿', preset: true }],
      uploaderUserId: CURRENT_USER_ID,
      uploaderDisplayName: '林奕',
      source: { kind: 'file', note: null },
      status: 'active',
      currentVersion: 1,
      revision: 2,
      pinned: false,
      pinnedAt: null,
      createdAt: iso('2026-10-22T14:00:00+08:00'),
      updatedAt: iso('2026-10-22T14:00:00+08:00'),
      trashedAt: null,
      trashExpiresAt: null,
      deletedById: null,
      current: {
        version: 1,
        sizeBytes: 96_400,
        mime: 'text/html',
        checksumSha256: '5'.repeat(64),
        createdAt: iso('2026-10-22T14:00:00+08:00'),
        createdById: CURRENT_USER_ID,
        processing: 'indexed',
        confirmedAt: null,
        confirmedByUserId: null,
      },
    },
    {
      // S-10 预览隔离夹具：一份来自外部的不可信 HTML。内容在 main.ts 的
      // pcGetPreviewUrl 里按 previewPort 现填（信标地址依赖运行期端口）。
      id: 'as-hostile-html',
      name: '外部共享-不可信页面.html',
      tags: [{ id: 'source', label: '原始资料', preset: true }],
      uploaderUserId: 'u-zhao-03',
      uploaderDisplayName: '赵倩',
      source: { kind: 'url', note: '外部渠道收到的自包含 HTML 附件' },
      status: 'active',
      currentVersion: 1,
      revision: 1,
      pinned: false,
      pinnedAt: null,
      createdAt: iso('2026-10-20T09:00:00+08:00'),
      updatedAt: iso('2026-10-20T09:00:00+08:00'),
      trashedAt: null,
      trashExpiresAt: null,
      deletedById: null,
      current: {
        version: 1,
        sizeBytes: 4_096,
        mime: 'text/html',
        checksumSha256: '6'.repeat(64),
        createdAt: iso('2026-10-20T09:00:00+08:00'),
        createdById: 'u-zhao-03',
        processing: 'indexed',
        confirmedAt: null,
        confirmedByUserId: null,
      },
    },
    {
      id: 'as-long-name',
      name: 'Design-Entwurf-Startseiten-Layout-v23-Finalversion-mit-Kommentaren-Freigabe.md',
      tags: [{ id: 'design', label: '设计稿', preset: true }],
      uploaderUserId: 'u-zhao-03',
      uploaderDisplayName: '赵倩',
      source: { kind: 'file', note: null },
      status: 'active',
      currentVersion: 1,
      revision: 2,
      pinned: false,
      pinnedAt: null,
      createdAt: iso('2026-10-18T10:00:00+08:00'),
      updatedAt: iso('2026-10-18T10:00:00+08:00'),
      trashedAt: null,
      trashExpiresAt: null,
      deletedById: null,
      current: {
        version: 1,
        sizeBytes: 15_200,
        mime: 'text/markdown',
        checksumSha256: '4'.repeat(64),
        createdAt: iso('2026-10-18T10:00:00+08:00'),
        createdById: 'u-zhao-03',
        processing: 'indexed',
        confirmedAt: null,
        confirmedByUserId: null,
      },
    },
    {
      id: 'as-old-spec',
      name: '旧版规格说明-2025.pdf',
      tags: [{ id: 'source', label: '原始资料', preset: true }],
      uploaderUserId: 'u-zhao-03',
      uploaderDisplayName: '赵倩',
      source: { kind: 'file', note: null },
      status: 'trashed',
      currentVersion: 1,
      revision: 3,
      pinned: false,
      pinnedAt: null,
      createdAt: iso('2025-12-01T10:00:00+08:00'),
      updatedAt: iso('2026-10-27T14:02:00+08:00'),
      trashedAt: iso('2026-10-27T14:02:00+08:00'),
      trashExpiresAt: iso('2026-11-26T14:02:00+08:00'),
      deletedById: CURRENT_USER_ID,
      current: {
        version: 1,
        sizeBytes: 2_041_000,
        mime: 'application/pdf',
        checksumSha256: '2'.repeat(64),
        createdAt: iso('2025-12-01T10:00:00+08:00'),
        createdById: 'u-zhao-03',
        processing: 'indexed',
        confirmedAt: null,
        confirmedByUserId: null,
      },
    },
    {
      id: 'as-draft-copy',
      name: '首页文案草稿-废弃.docx',
      tags: [{ id: 'design', label: '设计稿', preset: true }],
      uploaderUserId: CURRENT_USER_ID,
      uploaderDisplayName: '林奕',
      source: { kind: 'file', note: null },
      status: 'trashed',
      currentVersion: 4,
      revision: 8,
      pinned: false,
      pinnedAt: null,
      createdAt: iso('2026-08-15T10:00:00+08:00'),
      updatedAt: iso('2026-10-26T09:12:00+08:00'),
      trashedAt: iso('2026-10-26T09:12:00+08:00'),
      trashExpiresAt: iso('2026-11-25T09:12:00+08:00'),
      deletedById: 'u-chen-02',
      current: {
        version: 4,
        sizeBytes: 23_500,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        checksumSha256: '3'.repeat(64),
        createdAt: iso('2026-10-20T10:00:00+08:00'),
        createdById: CURRENT_USER_ID,
        processing: 'indexed',
        confirmedAt: null,
        confirmedByUserId: null,
      },
    },
  ]
}

export function initialCapabilities(): PcCapabilitiesResponse {
  return {
    featureEnabled: true,
    role: 'manager',
    canManage: true,
    canShare: true,
    library: { status: 'ready' },
    limits: { maxUploadBytes: 52_428_800, downloadUrlTtlSeconds: 60 },
  }
}

/** Long-name row used by the de-locale overflow probe. */
export const LONG_NAME_ASSET_ID = 'as-long-name'

/* ── POO-196 追加轮：project-members fixture (D-C) ────────────────────── */

/** The enterprise space the create flow materializes after a successful
 * pmCreateEnterprise (id matching the pm fixture responses). */
export const CREATED_ENTERPRISE_SPACE_ID = 'ps-apollo-created'

/** Initial member roster — the viewer (林奕, manager) plus two teammates. */
export const initialPmRoster = () => ({
  productSpaceId: PRODUCT_SPACE_ID,
  enterpriseName: 'Apollo 项目空间',
  viewerRole: 'manager',
  members: [
    { membershipId: 'mb-lin', userId: CURRENT_USER_ID, displayName: '林奕', role: 'manager' },
    { membershipId: 'mb-chen', userId: 'u-chen-02', displayName: '陈晓', role: 'member' },
    { membershipId: 'mb-zhou', userId: 'u-zhou-03', displayName: '周然', role: 'member' },
  ],
  nextCursor: null,
})

/** One pending invitation, matching the roster's enterprise. */
/** Invitation entry shape: masked contacts are nullable (phone-only vs
 * email-only targets), so consumers pushing synthesized rows stay assignable. */
export interface FixtureInvitationEntry {
  invitationId: string
  status: string
  maskedPhone: string | null
  maskedEmail: string | null
  expiresAt: string
  createdAt: string
  acceptedAt: string | null
}

export const initialPmInvitations = (): FixtureInvitationEntry[] => [
  {
    invitationId: 'inv-seed-1',
    status: 'active',
    maskedPhone: '138****0000',
    maskedEmail: null,
    expiresAt: '2026-11-09T00:00:00+08:00',
    createdAt: '2026-11-02T09:00:00+08:00',
    acceptedAt: null,
  },
]

/** The space list the create dialog's refresh handover reads (D-B 7). The
 * created space appears only after the fixture records a successful create. */
export function fixtureSpaceList(created: { productSpaceId: string; enterpriseName: string } | null) {
  const list: Array<Record<string, unknown>> = [
    {
      id: PRODUCT_SPACE_ID,
      kind: 'enterprise',
      enterpriseId: 'ent-apollo-01',
      name: 'Apollo 项目空间',
      role: 'manager',
      accessMode: 'active',
      payer: { enterpriseId: 'ent-apollo-01', plan: 'enterprise' },
    },
    {
      id: PERSONAL_SPACE_ID,
      kind: 'personal',
      name: '我的空间',
      accessMode: 'active',
      payer: { userId: ACCOUNT_ID, plan: 'pro' },
    },
  ]
  if (created) {
    list.unshift({
      id: created.productSpaceId,
      kind: 'enterprise',
      enterpriseId: 'ent-created',
      name: created.enterpriseName,
      role: 'owner',
      accessMode: 'active',
      payer: { enterpriseId: 'ent-created', plan: 'enterprise' },
    })
  }
  return list
}

export function initialSearchIndex(assets: PcAssetDto[]): Map<string, string> {
  const index = new Map<string, string>()
  index.set('as-meeting-1030', '迭代对齐会：POO-196 项目共享上下文进入开发收尾；验收要点围绕三 tab、@ 引用与标签体系。')
  index.set('as-req-doc', '需求文档 v2.3：项目会话默认三 tab（消息/文件/Pin）；@ 结构化引用以 assetId+version 落快照。')
  index.set('as-api-doc', 'REST 接口：上传走 grant→PUT→complete 三段；下载短时授权 60 秒。')
  index.set('as-data-dict', '字段：asset_id, version, processing_state, confirmed_at, trash_expires_at。')
  for (const asset of assets) {
    if (!index.has(asset.id)) index.set(asset.id, '')
  }
  return index
}

export function searchAssets(assets: PcAssetDto[], index: Map<string, string>, q: string, degraded: boolean, limit = 20): PcSearchResponse {
  const needle = q.trim().toLowerCase()
  const hits = assets
    .filter((asset) => asset.status === 'active')
    .filter((asset) => {
      if (!needle) return true
      return asset.name.toLowerCase().includes(needle) || (index.get(asset.id) ?? '').includes(needle)
    })
    .slice(0, limit)
    .map((asset) => ({
      assetId: asset.id,
      version: asset.current.version,
      name: asset.name,
      tags: asset.tags,
      snippet: (index.get(asset.id) || '').slice(0, 160) || null,
      score: null,
    }))
  return { hits, degraded }
}

/** The project session: productSpaceId bound, transcript carries @ snapshots. */
const projectSessionFixture: FixtureSession & { messages: FixtureMessage[] } = {
  id: SESSION_PROJECT,
  workspaceId: WORKSPACE_ID,
  workspaceName: 'Apollo 项目空间',
  productSpaceId: PRODUCT_SPACE_ID,
  accountId: ACCOUNT_ID,
  name: 'Polo 2.4 迭代对齐',
  preview: '请基于会议纪要和需求文档，整理本次迭代的验收要点。',
  createdAt: Date.parse('2026-10-30T18:00:00+08:00'),
  lastMessageAt: Date.parse('2026-10-31T09:30:00+08:00'),
  lastUsedAt: Date.parse('2026-10-31T09:30:00+08:00'),
  isProcessing: false,
  messages: [
    {
      id: 'm-apollo-1',
      role: 'user',
      content: '请基于会议纪要和需求文档，整理本次迭代的验收要点。',
      timestamp: Date.parse('2026-10-30T18:25:00+08:00'),
      projectAssetRefs: [
        {
          assetId: 'as-req-doc',
          version: 3,
          name: '需求文档 v2.3.docx',
          status: 'ok',
          snippet: '项目会话默认三 tab（消息/文件/Pin）；@ 结构化引用以 assetId+version 落快照。',
        },
        {
          assetId: 'as-meeting-1030',
          version: 1,
          name: '会议纪要-1030.md',
          status: 'stale',
          snippet: null,
        },
        {
          assetId: 'as-design-home',
          version: 9,
          name: '设计稿-首页.fig',
          status: 'missing',
          snippet: null,
        },
      ],
    },
    {
      id: 'm-apollo-2',
      role: 'assistant',
      content: '根据需求文档 v2.3 与 1030 会议纪要，本次迭代的验收要点集中在三处：\n\n1. 项目会话默认呈现「消息 / 文件 / Pin」三个 tab，非项目会话不出现该结构。\n2. @ 引用以结构化引用（文件 + 版本）进入发送，发送后消息下方保留逐条解析结果快照。\n3. 标签体系支持预设与自定义标签；确认状态绑定具体版本，替换后新版本默认未确认。',
      timestamp: Date.parse('2026-10-30T18:25:31+08:00'),
    },
  ],
  messageCount: 2,
  isFlagged: false,
}

/** The non-project session: no productSpaceId — the tab strip must stay off. */
const personalSessionFixture: FixtureSession = {
  id: SESSION_PERSONAL,
  workspaceId: WORKSPACE_ID,
  workspaceName: 'Apollo 项目空间',
  accountId: ACCOUNT_ID,
  name: '个人笔记 · 周报',
  preview: '帮我起草本周周报。',
  createdAt: Date.parse('2026-10-31T08:00:00+08:00'),
  lastMessageAt: Date.parse('2026-10-31T08:05:00+08:00'),
  lastUsedAt: Date.parse('2026-10-31T08:05:00+08:00'),
  isProcessing: false,
  messages: [
    {
      id: 'm-pers-1',
      role: 'user',
      content: '帮我起草本周周报，重点是项目共享上下文的收尾。',
      timestamp: Date.parse('2026-10-31T08:04:40+08:00'),
    },
    {
      id: 'm-pers-2',
      role: 'assistant',
      content: '好的，本周周报草稿如下：完成项目共享上下文全链开发（团队云盘 + 项目知识库），typecheck 与测试全绿，待发布评审。',
      timestamp: Date.parse('2026-10-31T08:05:00+08:00'),
    },
  ],
  messageCount: 2,
  isFlagged: false,
}

/** R2 扩展: the empty project session — same committed enterprise space, zero
 * transcript. ChatPage renders its second assembly (empty state) there; the
 * tab strip + members button must exist on BOTH branches. */
export const projectEmptySession: FixtureSession = {
  id: SESSION_PROJECT_EMPTY,
  workspaceId: WORKSPACE_ID,
  workspaceName: 'Apollo 项目空间',
  productSpaceId: PRODUCT_SPACE_ID,
  accountId: ACCOUNT_ID,
  name: '新项目会话（空）',
  preview: '',
  createdAt: Date.parse('2026-10-31T10:00:00+08:00'),
  lastMessageAt: Date.parse('2026-10-31T10:00:00+08:00'),
  lastUsedAt: Date.parse('2026-10-31T10:00:00+08:00'),
  isProcessing: false,
  messages: [],
  messageCount: 0,
  isFlagged: false,
}

export const projectSession = projectSessionFixture as unknown as Session

export const personalSession = personalSessionFixture as unknown as Session

export const sessionsById: Record<string, Session> = {
  [SESSION_PROJECT]: projectSession,
  [SESSION_PERSONAL]: personalSession,
  [SESSION_PROJECT_EMPTY]: projectEmptySession as unknown as Session,
}

/* ── POO-196 R3 (adjudication D6/D12/D13): the negotiated project directory,
 * the collaboration roster and the project-entry session seeds ──────────── */

/** The negotiated R3 contract literal (client-enterprise-contract.ts). */
export const R3_CONTRACT_VERSION = 'poo196-client-enterprise-r3'

/** R3 directory ids. `ps-apollo` doubles as the organization home (its
 * summary carries enterpriseKind 'organization' — it must NEVER render a
 * home project card). */
export const R3_PROJECT_ALPHA_ID = 'ps-r3-alpha'
export const R3_PROJECT_BETA_ID = 'ps-r3-beta'
/** The verified-empty project: entry must land on the zero-write empty state. */
export const R3_PROJECT_EMPTY_ID = 'ps-r3-empty'
export const R3_PROJECT_READONLY_ID = 'ps-r3-readonly'
/** Same-name twins: disambiguation is by data-product-space-id, never name. */
export const R3_TWIN_A_ID = 'ps-r3-twin-a'
export const R3_TWIN_B_ID = 'ps-r3-twin-b'
export const R3_TWIN_NAME = '交付资料库'
/** A second account — the home visit ordering is per-account isolated. */
export const R3_ACCOUNT_B_ID = 'acct-zhao-03'

/** One v1 enterprise ProductSpace summary (strict v1 wire shape). */
const enterpriseSpace = (id: string, enterpriseId: string, name: string, role: string, accessMode: string) => ({
  id,
  kind: 'enterprise',
  enterpriseId,
  name,
  role,
  accessMode,
  payer: { kind: 'enterprise', enterpriseId },
})

/**
 * The R3 negotiated directory (pm:listProductSpacesR3 response shape): the
 * strict v1 list as `spaces` plus per-enterprise summaries. Summaries carry
 * `enterpriseKind` + `purpose` and — per the R3 fixture contract — NO
 * `activeMemberCount` (P4: an unknown count is omitted, never a fabricated 0;
 * the panel count comes from the D4 roster). Every enterprise space is covered
 * exactly once (schema superRefine); the organization aggregate is listed but
 * `enterpriseKind:'organization'` keeps it out of the card collection.
 */
export function initialR3Directory() {
  const productSpaces = [
    enterpriseSpace(PRODUCT_SPACE_ID, 'ent-apollo-01', 'Apollo 项目空间', 'manager', 'active'),
    {
      id: PERSONAL_SPACE_ID,
      kind: 'personal',
      name: '我的空间',
      accessMode: 'active',
      payer: { kind: 'account' },
    },
    enterpriseSpace(R3_PROJECT_ALPHA_ID, 'ent-r3-alpha', '华东区销售资料库', 'owner', 'active'),
    enterpriseSpace(R3_PROJECT_BETA_ID, 'ent-r3-beta', '北区交付资料库', 'manager', 'active'),
    enterpriseSpace(R3_PROJECT_EMPTY_ID, 'ent-r3-empty', '新项目·尚无对话', 'owner', 'active'),
    enterpriseSpace(R3_PROJECT_READONLY_ID, 'ent-r3-readonly', '只读归档区', 'member', 'read_only'),
    enterpriseSpace(R3_TWIN_A_ID, 'ent-r3-twin-a', R3_TWIN_NAME, 'member', 'active'),
    enterpriseSpace(R3_TWIN_B_ID, 'ent-r3-twin-b', R3_TWIN_NAME, 'member', 'active'),
  ]
  const summaryOf = (space: { id: string; enterpriseId: string }, enterpriseKind: 'organization' | 'project', purpose?: string) => ({
    productSpaceId: space.id,
    enterpriseId: space.enterpriseId,
    enterpriseKind,
    ...(purpose ? { purpose } : {}),
  })
  return {
    contractVersion: R3_CONTRACT_VERSION,
    spaces: {
      contractVersion: 1,
      personalProductSpaceId: PERSONAL_SPACE_ID,
      productSpaces,
    },
    enterpriseSummaries: [
      summaryOf(productSpaces[0] as { id: string; enterpriseId: string }, 'organization'),
      summaryOf(productSpaces[2] as { id: string; enterpriseId: string }, 'project', '集中管理华东区客户与销售过程资料'),
      summaryOf(productSpaces[3] as { id: string; enterpriseId: string }, 'project', '沉淀交付过程与验收记录'),
      summaryOf(productSpaces[4] as { id: string; enterpriseId: string }, 'project'),
      summaryOf(productSpaces[5] as { id: string; enterpriseId: string }, 'project', '历史归档（只读）'),
      summaryOf(productSpaces[6] as { id: string; enterpriseId: string }, 'project', '同名 twin A'),
      summaryOf(productSpaces[7] as { id: string; enterpriseId: string }, 'project', '同名 twin B'),
    ],
  }
}

/** Directory variants the scenarios reprogram: an EMPTY project collection
 * (organization+personal only — 「还没有项目」 face) and a ONE-project
 * capacity boundary face. */
export function r3DirectoryVariant(variant: 'empty' | 'one') {
  const full = initialR3Directory()
  if (variant === 'empty') {
    const kept = full.spaces.productSpaces.filter((space: { id: string; kind: string }) => space.kind === 'personal' || space.id === PRODUCT_SPACE_ID)
    return {
      ...full,
      spaces: { ...full.spaces, productSpaces: kept },
      enterpriseSummaries: full.enterpriseSummaries.filter((entry: { productSpaceId: string }) => entry.productSpaceId === PRODUCT_SPACE_ID),
    }
  }
  const keptIds = new Set([PRODUCT_SPACE_ID, PERSONAL_SPACE_ID, R3_PROJECT_ALPHA_ID])
  return {
    ...full,
    spaces: { ...full.spaces, productSpaces: full.spaces.productSpaces.filter((space: { id: string }) => keptIds.has(space.id)) },
    enterpriseSummaries: full.enterpriseSummaries.filter((entry: { productSpaceId: string }) => keptIds.has(entry.productSpaceId) && entry.productSpaceId !== PERSONAL_SPACE_ID),
  }
}

/* ── R3 project-entry session seeds (D13) ────────────────────────────────── */

export const SESSION_R3_ALPHA_RECENT = 'sess-r3-alpha-recent'
export const SESSION_R3_ALPHA_OLDER = 'sess-r3-alpha-older'
export const SESSION_R3_BETA_RECENT = 'sess-r3-beta-recent'
/** A decoy: NEWER than the alpha pair but bound to the apollo project space —
 * the committed-scope filter must never pick it when entering alpha. */
export const SESSION_R3_DECOY = 'sess-r3-decoy'

const r3Session = (id: string, productSpaceId: string, name: string, lastMessageAt: number): FixtureSession => ({
  id,
  workspaceId: WORKSPACE_ID,
  workspaceName: 'Apollo 项目空间',
  productSpaceId,
  accountId: ACCOUNT_ID,
  name,
  preview: `${name} 的第一条用户消息。`,
  createdAt: lastMessageAt - 60_000,
  lastMessageAt,
  lastUsedAt: lastMessageAt,
  isProcessing: false,
  messages: [
    {
      id: `${id}-m1`,
      role: 'user',
      content: `${name} 的第一条用户消息。`,
      timestamp: lastMessageAt - 60_000,
    },
    {
      id: `${id}-m2`,
      role: 'assistant',
      content: `${name} 的回复要点已整理。`,
      timestamp: lastMessageAt,
    },
  ],
  messageCount: 2,
  isFlagged: false,
})

/** The project sessions the fixture getSessions hands out (the full workspace
 * list — selection scopes by productSpaceId, never by workspaceId alone). */
export const r3Sessions: FixtureSession[] = [
  r3Session(SESSION_R3_ALPHA_RECENT, R3_PROJECT_ALPHA_ID, '华东区资料库 · 最近会话', Date.parse('2026-11-03T18:00:00+08:00')),
  r3Session(SESSION_R3_ALPHA_OLDER, R3_PROJECT_ALPHA_ID, '华东区资料库 · 早期会话', Date.parse('2026-11-01T10:00:00+08:00')),
  r3Session(SESSION_R3_BETA_RECENT, R3_PROJECT_BETA_ID, '北区交付 · 最近会话', Date.parse('2026-11-02T15:00:00+08:00')),
  r3Session(SESSION_R3_DECOY, PRODUCT_SPACE_ID, 'Apollo 组织空间 · 更新的会话', Date.parse('2026-11-03T20:00:00+08:00')),
]

export const r3SessionsById: Record<string, Session> = Object.fromEntries(r3Sessions.map(session => [session.id, session]))

/** The session the EMPTY state's first trusted send creates — bound to the
 * committed project scope so the D14 fence passes. */
export function createdSessionFixture(productSpaceId: string, sessionId: string): Session {
  return r3Session(sessionId, productSpaceId, '项目首个会话', Date.now()) as unknown as Session
}

/** The D4 collaboration roster (all-role minimal projection): no contact, no
 * governance fields, server-owned `totalActiveMembers`. */
export const initialCollaborationRoster = () => ({
  productSpaceId: PRODUCT_SPACE_ID,
  enterpriseName: 'Apollo 项目空间',
  viewerRole: 'manager',
  totalActiveMembers: 3,
  members: [
    { userId: CURRENT_USER_ID, displayName: '林奕', avatarUrl: null, role: 'manager', isSelf: true },
    { userId: 'u-chen-02', displayName: '陈晓', avatarUrl: null, role: 'member', isSelf: false },
    { userId: 'u-zhou-03', displayName: '周然', avatarUrl: null, role: 'member', isSelf: false },
  ],
  nextCursor: null,
})

/** The D3 restricted colleague directory of the caller's source organization,
 * projected into the committed project: avatarUrl always null, server-derived
 * projectState, no contact fields. */
export const initialColleaguesDirectory = () => ({
  sourceState: 'available',
  source: { enterpriseId: 'ent-apollo-01', name: 'Apollo 项目空间' },
  members: [
    { userId: 'u-chen-02', displayName: '陈晓', avatarUrl: null, projectState: 'available' },
    { userId: 'u-zhou-03', displayName: '周然', avatarUrl: null, projectState: 'pending' },
    { userId: 'u-sun-04', displayName: '孙启', avatarUrl: null, projectState: 'joined' },
    { userId: 'u-liu-05', displayName: '刘畅', avatarUrl: null, projectState: 'unavailable' },
  ],
  nextCursor: null as string | null,
})
