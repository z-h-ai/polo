import * as React from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry } from './types'
import { AccountMenu } from '@/components/organization/AccountMenu'
import { AdminConsoleHandoff } from '@/components/organization/AdminConsoleHandoff'
import { TopupHandoff } from '@/components/credits'
import { ThemeProvider } from '@/context/ThemeContext'
import { AppShellProvider, useAppShellContext } from '@/context/AppShellContext'
import AccountSecuritySettingsPage from '@/pages/settings/AccountSecuritySettingsPage'
import AppearanceSettingsPage from '@/pages/settings/AppearanceSettingsPage'
import { DemoFixedContainer, MockOrganizationProvider, makeOrganizationSummary } from '../mocks'
import { PlaygroundAppShellProvider } from '../PlaygroundAppShellProvider'

// =============================================================================
// Account Settings Playground (POO-70 M10 verification)
// - MENU / MENU-ENT / MENU-NOPRIV: billing + management entries gated by
//   qualification (owner/manager see them; unqualified accounts omit them)
// - ADMIN-BROWSER: enterprise console handoff; billing handoff reuses
//   TopupHandoff (充值与账单)
// - ADMIN-RETURN: qualification re-checked toast on return
// - SETTINGS / SETTINGS-APPEARANCE: the real settings pages
// =============================================================================

const NO_OP = () => {}

const PERSONAL_SPACE = makeOrganizationSummary({
  id: 'org-personal',
  name: '我的空间',
  type: 'creator_space',
  membership: { role: 'owner', status: 'active' },
})

const ENTERPRISE_SPACE = makeOrganizationSummary({
  id: 'org-chenxing',
  name: '晨星科技',
  type: 'enterprise_workspace',
  membership: { role: 'owner', status: 'active' },
})

const ENTERPRISE_MEMBER_SPACE = makeOrganizationSummary({
  id: 'org-chenxing',
  name: '晨星科技',
  type: 'enterprise_workspace',
  membership: { role: 'member', status: 'active' },
})

interface AccountMenuDemoProps {
  qualified?: boolean
  enterprise?: boolean
}

function AccountMenuDemo({ qualified = true, enterprise = false }: AccountMenuDemoProps) {
  const enterpriseOrg = qualified ? ENTERPRISE_SPACE : ENTERPRISE_MEMBER_SPACE
  const organizations = enterprise
    ? [PERSONAL_SPACE, enterpriseOrg]
    : [enterpriseOrg, PERSONAL_SPACE]
  const activeId = enterprise ? enterpriseOrg.id : PERSONAL_SPACE.id
  return (
    <div className="relative h-64 w-[560px] rounded-lg border border-border bg-background">
      <div className="absolute top-3 right-3">
        <MockOrganizationProvider organizations={organizations} activeId={activeId}>
          <AccountMenu
            user={{ username: 'wang', displayName: '小王' }}
            onLogout={async () => {}}
            onOpenSettings={NO_OP}
            defaultOpen
            billing={{ scope: enterprise ? 'enterprise' : 'personal' }}
            onOpenBilling={NO_OP}
            admin={qualified ? { enterprise: { organizationName: '北方贸易' }, creatorConsole: true } : undefined}
            onOpenEnterpriseAdmin={NO_OP}
            onOpenCreatorConsole={NO_OP}
          />
        </MockOrganizationProvider>
      </div>
    </div>
  )
}

interface AccountHandoffDemoProps {
  variant?: 'billing' | 'admin'
}

function AccountHandoffDemo({ variant = 'billing' }: AccountHandoffDemoProps) {
  const { t } = useTranslation()
  if (variant === 'admin') {
    return (
      <DemoFixedContainer width={880} height={560}>
        <AdminConsoleHandoff
          organizationName="北方贸易"
          roleLabel={t('organization.role.owner')}
          onCancel={NO_OP}
          onOpenInBrowser={NO_OP}
        />
      </DemoFixedContainer>
    )
  }
  return (
    <DemoFixedContainer width={880} height={560}>
      <TopupHandoff
        variant="billing"
        balance={12}
        onCancel={NO_OP}
        onContinueInBrowser={NO_OP}
      />
    </DemoFixedContainer>
  )
}

function AdminReturnDemo() {
  const { t } = useTranslation()
  React.useEffect(() => {
    // 原型 P-M10-ADMIN-RETURN：toast 固定右下角、深色底浅字（.toast 覆写仅限本 demo）
    toast.success(t('accountSettings.adminReturnToast'), {
      position: 'bottom-right',
      style: {
        '--normal-bg': 'var(--foreground)',
        '--normal-text': 'var(--background)',
        '--normal-border': 'transparent',
        borderLeft: '3px solid var(--accent)',
      } as React.CSSProperties,
    })
  }, [t])
  return (
    <div className="w-[560px] rounded-lg border border-border bg-background p-6">
      <p className="m-0 text-[15px] font-semibold text-foreground">下午好，小王</p>
      <p className="m-0 mt-1 text-[13px] text-muted-foreground">继续 晨星科技 的工作</p>
      <p className="m-0 mt-4 text-[11px] text-muted-foreground">
        从企业管理后台返回后，右下角出现「已重新核对管理资格」toast
      </p>
    </div>
  )
}

/** Nests an admin user into the playground app-shell value for the security page. */
function WithAdminUser({ children }: { children: React.ReactNode }) {
  const value = useAppShellContext()
  const enriched = React.useMemo(
    () => ({
      ...value,
      currentAdminUser: { userId: 'admin-1', username: 'wang', displayName: '小王' },
    }),
    [value],
  )
  return <AppShellProvider value={enriched}>{children}</AppShellProvider>
}

function SecurityPageDemo({ signedIn = true }: { signedIn?: boolean }) {
  return (
    <div className="h-[560px] w-full overflow-hidden rounded-lg border border-border">
      <PlaygroundAppShellProvider>
        {signedIn ? (
          <WithAdminUser>
            <AccountSecuritySettingsPage />
          </WithAdminUser>
        ) : (
          <AccountSecuritySettingsPage />
        )}
      </PlaygroundAppShellProvider>
    </div>
  )
}

function AppearancePageDemo() {
  return (
    <div className="h-[620px] w-full overflow-auto rounded-lg border border-border">
      <ThemeProvider>
        <PlaygroundAppShellProvider>
          <AppearanceSettingsPage />
        </PlaygroundAppShellProvider>
      </ThemeProvider>
    </div>
  )
}

export const accountSettingsComponents: ComponentEntry[] = [
  {
    id: 'account-menu-variants',
    name: 'Account Menu · Qualification Variants',
    category: 'Browser',
    description:
      '账号菜单有/无管理资格（P-M10-MENU / MENU-ENT / MENU-NOPRIV）：充值与账单常驻；企业管理后台/创作者工作台按 owner/manager 资格出现，无资格不显示不灰置',
    component: AccountMenuDemo,
    props: [
      {
        name: 'qualified',
        description: '有管理资格（owner/manager）',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'enterprise',
        description: '当前空间为企业空间（晨星科技）',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'P-M10-MENU · qualified personal',
        description: '我的空间 owner：充值与账单 + 管理入口（企业管理后台/创作者工作台）',
        props: { qualified: true, enterprise: false },
      },
      {
        name: 'P-M10-MENU-ENT · qualified enterprise',
        description: '晨星科技 owner：同上管理入口',
        props: { qualified: true, enterprise: true },
      },
      {
        name: 'P-M10-MENU-NOPRIV · no qualification',
        description: '晨星科技 member：不显示管理入口（不灰置），充值与账单保留',
        props: { qualified: false, enterprise: true },
      },
    ],
  },
  {
    id: 'account-handoff',
    name: 'Account · Browser Handoff',
    category: 'Browser',
    description:
      '充值与账单 / 企业管理后台的浏览器交接（P-M09-BROWSER-MENU / P-M10-ADMIN-BROWSER）：复用 HandoffCard',
    component: AccountHandoffDemo,
    layout: 'top',
    props: [
      {
        name: 'variant',
        description: '交接卡',
        control: {
          type: 'select',
          options: [
            { label: 'billing (充值与账单)', value: 'billing' },
            { label: 'admin console (企业管理后台)', value: 'admin' },
          ],
        },
        defaultValue: 'billing',
      },
    ],
    variants: [
      { name: 'P-M09-BROWSER-MENU · billing handoff', description: '个人空间充值与账单交接卡', props: { variant: 'billing' } },
      { name: 'P-M10-ADMIN-BROWSER · admin console', description: '北方贸易管理后台交接卡（角色/管理范围）', props: { variant: 'admin' } },
    ],
  },
  {
    id: 'account-admin-return',
    name: 'Account · Admin Return',
    category: 'Browser',
    description: '返回后资格刷新（P-M10-ADMIN-RETURN）：企业管理后台返回后出现「已重新核对管理资格」toast',
    component: AdminReturnDemo,
    props: [],
    variants: [{ name: 'P-M10-ADMIN-RETURN · toast', description: '进入 demo 即触发 toast', props: {} }],
  },
  {
    id: 'account-settings-security',
    name: 'Settings · Account Security',
    category: 'Agent Setup',
    description:
      '设置 · 账号安全（P-M10-SETTINGS / SETTINGS-ENT）：复用既有 AccountSecuritySettingsPage；偏好随账号展示',
    component: SecurityPageDemo,
    layout: 'top',
    props: [
      {
        name: 'signedIn',
        description: '已登录管理员（显示密码表单）',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
    variants: [
      { name: 'P-M10-SETTINGS · signed in', description: '账号安全页（表单态）', props: { signedIn: true } },
      { name: 'P-M10-SETTINGS · signed out note', description: '未登录管理员时的说明态', props: { signedIn: false } },
    ],
  },
  {
    id: 'account-settings-appearance',
    name: 'Settings · Appearance',
    category: 'Agent Setup',
    description:
      '设置 · 外观（P-M10-SETTINGS-APPEARANCE / -ENT）：复用既有 AppearanceSettingsPage（主题模式/颜色/字体）',
    component: AppearancePageDemo,
    props: [],
    layout: 'top',
    variants: [{ name: 'P-M10-SETTINGS-APPEARANCE · real page', description: '真实外观设置页', props: {} }],
  },
]
