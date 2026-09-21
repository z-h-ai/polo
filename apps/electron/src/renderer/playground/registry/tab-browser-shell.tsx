import * as React from 'react'
import type { ComponentEntry } from './types'
import { TabBar } from '@/components/tab-browser/TabBar'
import { OrganizationProvider, type OrganizationContextValue } from '@/context/OrganizationContext'
import { TabShellContext, type TabShellContextValue } from '@/context/TabShellContext'
import {
  HOME_TAB_ID,
  POLO_APP_ID,
  POLO_TAB_ID,
  type TabInstance,
} from '../../../shared/tab-browser-types'
import type { OrganizationSummary } from '../../../shared/types'

// =============================================================================
// Tab Browser Shell Playground (prototype R8/R9/R10 verification)
// Renders the real TabBar with mocked tab + organization contexts:
// - R9: passive space indicator + avatar account menu with 「切换空间」 submenu
// - R10: the space list excludes the suspended/removed organization
// - R8: tab close glyph as two centered lines in a 24×24 hit area
// =============================================================================

const POLO_TAB: TabInstance = {
  id: POLO_TAB_ID,
  appId: POLO_APP_ID,
  type: 'polo',
  title: 'Polo 助手',
}

const DEMO_TABS: TabInstance[] = [
  POLO_TAB,
  {
    id: 'tab-quote',
    appId: 'app-quote',
    type: 'webapp',
    title: '报价整理',
    url: 'https://quote.example.com',
  },
  {
    id: 'tab-notes',
    appId: 'app-notes',
    type: 'webapp',
    title: '会议纪要整理',
    url: 'https://notes.example.com',
  },
]

const ACTIVE_WEBAPP_TAB_ID = 'tab-quote'

function organizationSummary(
  id: string,
  name: string,
  type: 'creator_space' | 'enterprise_workspace',
  role: 'owner' | 'manager' | 'member',
): OrganizationSummary {
  return {
    id,
    type,
    name,
    purpose: `${name} demo purpose`,
    membership: { id: `membership-${id}`, role, status: 'active' },
    memberCount: 6,
  }
}

const PERSONAL_SPACE = organizationSummary('org-personal', '我的空间', 'creator_space', 'owner')
const ENTERPRISE_SPACE = organizationSummary('org-enterprise', '晨星科技', 'enterprise_workspace', 'member')
const REVOKED_SPACE: OrganizationSummary = {
  ...organizationSummary('org-revoked', '已失权企业', 'enterprise_workspace', 'member'),
  status: 'suspended',
  membership: { id: 'membership-org-revoked', role: 'member', status: 'removed' },
}

function buildTabShellValue(activeTabId: string): TabShellContextValue {
  return {
    installedApps: [],
    openTabs: DEMO_TABS,
    activeTab: DEMO_TABS.find(tab => tab.id === activeTabId) ?? DEMO_TABS[0]!,
    activeTabId,
    isReady: true,
    activeWebAppNavigation: {
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
      goBack: () => {},
      goForward: () => {},
      reloadOrStop: () => {},
    },
    activateHome: () => {},
    activateTab: () => {},
    openApp: () => {},
    closeTab: () => {},
    reorderTabs: () => {},
    addApp: async () => {},
    removeApp: async () => {},
    updateTabInfo: () => {},
    registerWebAppNavigation: () => {},
  }
}

function buildOrganizationValue(personalSpaceActive: boolean): OrganizationContextValue {
  const active = personalSpaceActive ? PERSONAL_SPACE : ENTERPRISE_SPACE
  return {
    accountId: 'account-demo',
    activeOrganizationId: active.id,
    organizationSummaries: [PERSONAL_SPACE, ENTERPRISE_SPACE, REVOKED_SPACE],
    organizationMembershipRole: active.membership.role,
    organizationContextKey: `account-demo:${active.id}`,
    contextVersion: 1,
    onSelectOrganization: () => {},
    onManageOrganization: () => {},
    onCreateOrganization: () => {},
  }
}

interface TabBarShellDemoProps {
  menuOpen?: boolean
  zoom?: boolean
  personalSpace?: boolean
}

function TabBarShellDemo({ menuOpen = false, zoom = false, personalSpace = false }: TabBarShellDemoProps) {
  const tabShellValue = React.useMemo(
    () => buildTabShellValue(zoom ? HOME_TAB_ID : ACTIVE_WEBAPP_TAB_ID),
    [zoom],
  )
  const organizationValue = React.useMemo(
    () => buildOrganizationValue(personalSpace),
    [personalSpace],
  )

  return (
    <OrganizationProvider value={organizationValue}>
      <TabShellContext.Provider value={tabShellValue}>
        <div className="relative w-[880px] overflow-hidden rounded-lg border border-border bg-background">
          {/* The transform turns this box into the containing block for the
              TabBar's `fixed` positioning, so the bar is clipped to the demo. */}
          <div
            className="relative h-[220px] w-full"
            style={zoom ? { transform: 'scale(2.2)', transformOrigin: 'top left' } : { transform: 'translateZ(0)' }}
          >
            <TabBar
              account={{
                user: { username: 'wang', displayName: '小王' },
                onLogout: () => {},
                defaultOpen: menuOpen,
              }}
            />
            <div
              className="flex items-center justify-center bg-foreground/2 text-xs text-muted-foreground"
              style={{ height: 'var(--tabbar-height)', marginTop: 'var(--tabbar-height)' }}
            >
              (home / app content area)
            </div>
          </div>
        </div>
      </TabShellContext.Provider>
    </OrganizationProvider>
  )
}

export const tabBrowserShellComponents: ComponentEntry[] = [
  {
    id: 'tab-browser-shell',
    name: 'Tab Browser Shell',
    category: 'Browser',
    description:
      '产品壳顶栏：标签条（R8 关闭图标 24×24 居中双线）+ 被动空间指示器 + 头像账号菜单（R9 切换空间入口；R10 失权空间不出现在列表）',
    component: TabBarShellDemo,
    layout: 'top',
    previewOverflow: 'visible',
    props: [
      {
        name: 'menuOpen',
        description: '账号菜单默认展开（含切换空间子菜单）',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'zoom',
        description: '放大顶栏检查关闭图标对齐',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'personalSpace',
        description: '当前空间切换为「我的空间」',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'Enterprise space · tabs · closed menu',
        description: '企业空间激活，WebApp 标签激活（含前进后退控件）',
        props: {},
      },
      {
        name: 'Account menu open',
        description: '账号菜单 + 切换空间子菜单展开：列表只有有效空间，失权企业不出现',
        props: { menuOpen: true },
      },
      {
        name: 'Personal space · zoom close glyph',
        description: '我的空间激活 + 顶栏放大 2.2×，检查关闭 × 两条线居中对齐',
        props: { zoom: true, personalSpace: true },
      },
    ],
  },
]
