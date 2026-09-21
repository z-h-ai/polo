/**
 * Playground registry for the skills manager (POO-70 HiFi
 * WS-ASSISTANT-SKILLS, M06).
 *
 * Variants sample the prototype scene matrix: the local list in both
 * spaces across state-bit combos (`-100-0-0` … `110-1-0`, builtin-off,
 * restricted), both discover channels, the install sheet (review /
 * installing / failed), the detail sheet across state bits and both
 * uninstall confirmations, the share-to-org flow, and the enable-denied
 * dialog.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry } from './types'
import { SkillsManagerPanel } from '@/components/app-shell/skills/SkillsManagerPanel'
import { SkillInstallSheet } from '@/components/app-shell/skills/SkillInstallSheet'
import { SkillDetailSheet } from '@/components/app-shell/skills/SkillDetailSheet'
import { SkillDeniedDialog } from '@/components/app-shell/skills/SkillDeniedDialog'
import { ShareToOrgDialog } from '@/components/app-shell/skills/share/ShareToOrgDialog'
import {
  decodeSkillSceneBits,
  type DiscoverableSkill,
  type ManagedSkill,
  type SkillSpaceKind,
} from '@/components/app-shell/skills/types'
import { DemoFixedContainer } from '../mocks/DemoFixedContainer'
import { MockOrganizationProvider, makeOrganizationSummary } from '../mocks/MockOrganization'

// ============================================================================
// Scene-matrix sample data
// ============================================================================

/** Builtin 资料研究 row; `suffix` drives the state bits (e.g. '100-0-1'). */
function builtinSkill(suffix: string): ManagedSkill {
  const bits = decodeSkillSceneBits(suffix)
  return {
    slug: 'research',
    name: '资料研究',
    description: '查找资料、梳理重点并保留来源。',
    origin: 'builtin',
    originLabel: 'builtin',
    enabled: bits.enabled,
    restricted: false,
  }
}

/** Distributed 增长案例检索 / 销售周报 row built from scene bits. */
function distributedSkill(
  suffix: string,
  space: SkillSpaceKind,
  overrides: Partial<ManagedSkill> = {},
): ManagedSkill {
  const bits = decodeSkillSceneBits(suffix)
  return {
    slug: space === 'personal' ? 'growth-cases' : 'sales-weekly',
    name: space === 'personal' ? '增长案例检索' : '销售周报',
    description: space === 'personal'
      ? '根据提问检索增长方法，整理可参考的案例。'
      : '按团队格式汇总本周进展、风险和下周计划。',
    origin: space === 'personal' ? 'circle' : 'org',
    originLabel: suffix,
    provider: space === 'personal'
      ? '晨星增长工作室 · 晨星增长圈 / 晨星设计圈'
      : '晨星科技 · 林晓共享',
    installedVersion: bits.version === 'none' || bits.version === 'revoked'
      ? '1.0.0'
      : bits.version,
    availableVersion: bits.version === '1.1.0' ? '1.1.0' : undefined,
    enabled: bits.enabled,
    restricted: bits.version === 'revoked',
    restrictedReason: bits.version === 'revoked' ? 'revoked' : undefined,
    ...overrides,
  }
}

function restrictedSkill(space: SkillSpaceKind): ManagedSkill {
  return {
    ...distributedSkill('revoked', space),
    installedVersion: '1.0.0',
    availableVersion: undefined,
  }
}

const entDiscoverItems: DiscoverableSkill[] = [
  {
    slug: 'sales-weekly',
    name: '销售周报',
    description: '按团队格式汇总本周进展、风险和下周计划。',
    provider: '晨星科技 · 林晓共享',
    version: '1.0.0',
    glyph: '✧',
  },
]

const circleDiscoverItems: DiscoverableSkill[] = [
  {
    slug: 'growth-cases',
    name: '增长案例检索',
    description: '根据提问检索增长方法，整理可参考的案例。',
    provider: '晨星增长工作室 · 晨星增长圈 / 晨星设计圈',
    version: '1.0.0',
    glyph: '✧',
  },
]

// ============================================================================
// Preview wrappers
// ============================================================================

interface PanelPreviewProps {
  spaceKind?: SkillSpaceKind
  initialTab?: 'local' | 'discover'
  sceneBits?: string
  builtinBits?: string
  restricted?: boolean
  installFails?: boolean
}

function PanelPreview({
  spaceKind = 'enterprise',
  initialTab = 'local',
  sceneBits,
  builtinBits,
  restricted = false,
  installFails = false,
}: PanelPreviewProps) {
  const isEnterprise = spaceKind === 'enterprise'
  const skills: ManagedSkill[] = [
    builtinSkill(builtinBits ?? '100-0-1'),
  ]
  if (sceneBits) skills.push(distributedSkill(sceneBits, spaceKind))
  if (restricted) skills.push(restrictedSkill(spaceKind))

  return (
    <DemoFixedContainer width={420} height={520}>
      <MockOrganizationProvider
        organizations={[
          makeOrganizationSummary({
            id: isEnterprise ? 'org-chenxing' : 'org-demo',
            type: isEnterprise ? 'enterprise_workspace' : 'creator_space',
            name: isEnterprise ? '晨星科技' : '我的空间',
          }),
        ]}
        activeId={isEnterprise ? 'org-chenxing' : 'org-demo'}
      >
        <SkillsManagerPanel
          managedSkills={skills}
          discoverItems={isEnterprise ? entDiscoverItems : circleDiscoverItems}
          spaceKind={spaceKind}
          spaceName={isEnterprise ? '晨星科技' : '我的空间'}
          initialTab={initialTab}
          installFails={installFails}
          onBackToChat={() => {}}
          className="h-full"
        />
      </MockOrganizationProvider>
    </DemoFixedContainer>
  )
}

function InstallSheetPreview({ phase }: { phase?: 'review' | 'installing' | 'failed' }) {
  const { t } = useTranslation()
  return (
    <DemoFixedContainer width={420} height={480}>
      <div className="h-full bg-hifi-background p-3">
        <SkillInstallSheet
          name="增长案例检索"
          description="根据提问检索增长方法，整理可参考的案例。"
          provider="晨星增长工作室 · 晨星增长圈 / 晨星设计圈"
          version="1.0.0"
          spaceKind="personal"
          spaceName={t('skillsManager.space.personal')}
          phase={phase}
          onInstall={() => {}}
          onRetry={() => {}}
          onBack={() => {}}
        />
      </div>
    </DemoFixedContainer>
  )
}

function DetailSheetPreview({
  sceneBits = '100-0-0',
  mode = 'manage',
  updateAvailable = false,
}: {
  sceneBits?: string
  mode?: 'manage' | 'confirm-uninstall' | 'confirm-uninstall-restricted'
  updateAvailable?: boolean
}) {
  const space: SkillSpaceKind = sceneBits.startsWith('ent') ? 'enterprise' : 'personal'
  const bits = sceneBits.replace(/^ent-/, '')
  const skill = distributedSkill(bits, space, updateAvailable
    ? { installedVersion: '1.0.0', availableVersion: '1.1.0' }
    : {})
  return (
    <DemoFixedContainer width={420} height={520}>
      <div className="h-full bg-hifi-background p-3">
        <SkillDetailSheet
          skill={skill}
          spaceName={space === 'enterprise' ? '晨星科技' : '我的空间'}
          mode={mode}
          onToggleEnabled={() => {}}
          onUpdate={() => {}}
          onReauthorize={() => {}}
          onViewRestrictedReason={() => {}}
          onRequestUninstall={() => {}}
          onConfirmUninstall={() => {}}
          onCancelUninstall={() => {}}
          onBack={() => {}}
        />
      </div>
    </DemoFixedContainer>
  )
}

function ShareDialogPreview({ phase }: { phase?: 'compose' | 'submitted' }) {
  return (
    <DemoFixedContainer width={420} height={420}>
      <div className="h-full bg-hifi-background p-3">
        <ShareToOrgDialog
          orgName="晨星科技"
          skillName="客户回访摘要"
          skillVersion="1.0.0"
          phase={phase}
          defaultNote="帮助销售同事整理回访记录和下一步行动。"
          onSubmit={() => {}}
          onCancel={() => {}}
          onBack={() => {}}
        />
      </div>
    </DemoFixedContainer>
  )
}

function DeniedDialogPreview() {
  const [open, setOpen] = React.useState(true)
  return (
    <DemoFixedContainer width={420} height={360}>
      <div className="h-full bg-hifi-background p-3">
        <SkillDeniedDialog
          open={open}
          onOpenChange={setOpen}
          skillName="销售周报"
          sourceName="晨星科技"
          onUseEnabled={() => setOpen(false)}
          onViewShared={() => setOpen(false)}
        />
      </div>
    </DemoFixedContainer>
  )
}

// ============================================================================
// Registry entries
// ============================================================================

export const skillsManagerComponents: ComponentEntry[] = [
  {
    id: 'skills-manager',
    name: 'Skills Manager Panel',
    category: 'Entity Lists',
    description:
      '本机/获取 tab 导航 + 本机列表（内置/分发/失效状态位组合）— P-M06-SKILLS · LOCAL-* · RESTRICTED-* · DISCOVER-*',
    component: PanelPreview,
    layout: 'centered',
    props: [
      {
        name: 'spaceKind',
        description: 'Space context (discover channel + copy)',
        control: {
          type: 'select',
          options: [
            { label: 'Enterprise', value: 'enterprise' },
            { label: 'Personal', value: 'personal' },
          ],
        },
        defaultValue: 'enterprise',
      },
      {
        name: 'initialTab',
        description: 'Initially active tab',
        control: {
          type: 'select',
          options: [
            { label: 'Local', value: 'local' },
            { label: 'Discover', value: 'discover' },
          ],
        },
        defaultValue: 'local',
      },
      {
        name: 'sceneBits',
        description: 'Distributed skill state bits (scene suffix)',
        control: {
          type: 'select',
          options: [
            { label: 'None (builtin only)', value: '' },
            { label: '100-0-0 installed·disabled', value: '100-0-0' },
            { label: '100-1-0 enabled', value: '100-1-0' },
            { label: '110-0-0 update·disabled', value: '110-0-0' },
            { label: '110-1-0 updated·enabled', value: '110-1-0' },
          ],
        },
        defaultValue: '100-0-0',
      },
      {
        name: 'builtinBits',
        description: 'Built-in 资料研究 state bits',
        control: {
          type: 'select',
          options: [
            { label: 'Enabled', value: '100-0-1' },
            { label: 'Disabled', value: '100-1-1' },
          ],
        },
        defaultValue: '100-0-1',
      },
      { name: 'restricted', description: 'Add a source-restricted row', control: { type: 'boolean' }, defaultValue: false },
      { name: 'installFails', description: 'Install sheet fails instead of succeeding', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [
      {
        name: 'P-M06-SKILLS local · enterprise · builtin enabled',
        description: '企业空间本机列表：内置已启用 + 空态卡（查看并安装）',
        props: { spaceKind: 'enterprise', sceneBits: '' },
      },
      {
        name: 'P-M06-SKILLS-PERSONAL local · personal',
        description: '个人空间本机列表（圈子文案空态卡）',
        props: { spaceKind: 'personal', sceneBits: '' },
      },
      {
        name: 'P-M06-LOCAL-PERSONAL-100-0-0 installed·disabled',
        description: '安装后默认停用，行操作=启用',
        props: { spaceKind: 'personal', sceneBits: '100-0-0' },
      },
      {
        name: 'P-M06-LOCAL-PERSONAL-100-1-0 enabled',
        description: '已启用，行操作=停用',
        props: { spaceKind: 'personal', sceneBits: '100-1-0' },
      },
      {
        name: 'P-M06-LOCAL-ENT-110-0-0 update available·disabled',
        description: '可更新徽标 + 停用态',
        props: { spaceKind: 'enterprise', sceneBits: '110-0-0' },
      },
      {
        name: 'P-M06-LOCAL-ENT-110-1-0 updated·enabled',
        description: '已更新徽标 + 启用态',
        props: { spaceKind: 'enterprise', sceneBits: '110-1-0' },
      },
      {
        name: 'P-M06-BUILTIN-OFF-ENT builtin disabled',
        description: '内置已停用，仅可重新启用，无卸载入口',
        props: { spaceKind: 'enterprise', sceneBits: '', builtinBits: '100-1-1' },
      },
      {
        name: 'P-M06-RESTRICTED-PERSONAL source revoked',
        description: '来源失效：副本保留 + 停用 + 重新验证/查看原因/卸载',
        props: { spaceKind: 'personal', sceneBits: '100-0-0', restricted: true },
      },
      {
        name: 'P-M06-DISCOVER-ENT shared library',
        description: '获取 tab：企业共享库 + 共享我的 Skill 卡',
        props: { spaceKind: 'enterprise', initialTab: 'discover' },
      },
      {
        name: 'P-M06-DISCOVER-PERSONAL circles',
        description: '获取 tab：从圈子获取 + 查看我的圈子卡',
        props: { spaceKind: 'personal', initialTab: 'discover' },
      },
    ],
  },

  {
    id: 'skills-install-sheet',
    name: 'Skill Install Sheet',
    category: 'Entity Lists',
    description: '安装详情（默认停用说明 / 安装失败重试）— P-M06-INSTALL-* / INSTALL-FAILED',
    component: InstallSheetPreview,
    layout: 'centered',
    props: [
      {
        name: 'phase',
        description: 'Install phase',
        control: {
          type: 'select',
          options: [
            { label: 'Review', value: 'review' },
            { label: 'Installing', value: 'installing' },
            { label: 'Failed', value: 'failed' },
          ],
        },
        defaultValue: 'review',
      },
    ],
    variants: [
      {
        name: 'P-M06-INSTALL-PERSONAL review',
        description: '来源/版本/范围 facts + 安装后由用户启用的说明',
        props: { phase: 'review' },
      },
      { name: 'Installing', description: '安装中（按钮禁用）', props: { phase: 'installing' } },
      {
        name: 'P-M06-INSTALL-FAILED',
        description: '安装未完成，可返回或重试',
        props: { phase: 'failed' },
      },
    ],
  },

  {
    id: 'skills-detail-sheet',
    name: 'Skill Detail Sheet',
    category: 'Entity Lists',
    description: '管理版本（状态位组合）与内嵌卸载确认 — P-M06-DETAIL-* / REMOVE-*',
    component: DetailSheetPreview,
    layout: 'centered',
    props: [
      {
        name: 'sceneBits',
        description: 'State bits of the managed copy',
        control: {
          type: 'select',
          options: [
            { label: '100-0-0', value: '100-0-0' },
            { label: '100-1-0', value: '100-1-0' },
            { label: '110-1-1', value: '110-1-1' },
            { label: 'ent 110-0-0', value: 'ent-110-0-0' },
          ],
        },
        defaultValue: '100-0-0',
      },
      {
        name: 'mode',
        description: 'Sheet view',
        control: {
          type: 'select',
          options: [
            { label: 'Manage', value: 'manage' },
            { label: 'Confirm uninstall', value: 'confirm-uninstall' },
            { label: 'Confirm uninstall (restricted)', value: 'confirm-uninstall-restricted' },
          ],
        },
        defaultValue: 'manage',
      },
      {
        name: 'updateAvailable',
        description: 'Show the v1.1.0 update card (installed stays v1.0.0)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'P-M06-DETAIL-PERSONAL-100-0-0 manage',
        description: 'v1.0.0 已停用：启用 + 卸载入口',
        props: { sceneBits: '100-0-0', mode: 'manage' },
      },
      {
        name: 'P-M06-DETAIL-PERSONAL-100-1-0 manage',
        description: 'v1.0.0 已启用：停用 + 卸载入口',
        props: { sceneBits: '100-1-0', mode: 'manage' },
      },
      {
        name: 'P-M06-DETAIL-PERSONAL-110-1-1 manage (boundary)',
        description: '边界组合：启用中 + 更新卡 v1.1.0',
        props: { sceneBits: '110-1-1', mode: 'manage', updateAvailable: true },
      },
      {
        name: 'P-M06-DETAIL-ENT-110-0-0 manage',
        description: '企业空间：更新卡 + 停用',
        props: { sceneBits: 'ent-110-0-0', mode: 'manage' },
      },
      {
        name: 'P-M06-REMOVE-PERSONAL confirm',
        description: '卸载确认：只移除本机副本',
        props: { sceneBits: '100-0-0', mode: 'confirm-uninstall' },
      },
      {
        name: 'P-M06-REMOVE-RESTRICTED-PERSONAL confirm',
        description: '失效来源的专用卸载确认文案',
        props: { sceneBits: '100-0-0', mode: 'confirm-uninstall-restricted' },
      },
    ],
  },

  {
    id: 'skills-share-dialog',
    name: 'Share To Org Dialog',
    category: 'Entity Lists',
    description: '提交企业审核（提交≠发布）— P-M06-SHARE-ENT / SHARE-SUBMITTED',
    component: ShareDialogPreview,
    layout: 'centered',
    props: [
      {
        name: 'phase',
        description: 'Share flow phase',
        control: {
          type: 'select',
          options: [
            { label: 'Compose', value: 'compose' },
            { label: 'Submitted', value: 'submitted' },
          ],
        },
        defaultValue: 'compose',
      },
    ],
    variants: [
      {
        name: 'P-M06-SHARE-ENT compose',
        description: '包含/不包含 facts + 给审核人的说明',
        props: { phase: 'compose' },
      },
      {
        name: 'P-M06-SHARE-SUBMITTED',
        description: '已提交企业审核：审核通过并分发后同事才能获取',
        props: { phase: 'submitted' },
      },
    ],
  },

  {
    id: 'skills-denied-dialog',
    name: 'Skill Denied Dialog',
    category: 'Entity Lists',
    description: '启用失败（无授权）联系作者/管理员路径 — P-M06-SKILL-DENIED',
    component: DeniedDialogPreview,
    layout: 'centered',
    props: [],
    variants: [
      {
        name: 'P-M06-SKILL-DENIED',
        description: '无法开启：授权不足 + 先用已开启的 / 查看企业共享',
        props: {},
      },
    ],
  },
]
