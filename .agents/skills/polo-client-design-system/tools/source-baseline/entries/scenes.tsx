/**
 * Baseline scene registry.
 *
 * Every scene renders REAL renderer components from this branch; fixtures
 * only supply backend data (see fixtures.tsx). Settings scenes are derived
 * from the typed SETTINGS_PAGE_COMPONENTS registry, so a subpage added in
 * pages/settings/settings-pages.ts automatically appears here.
 */
import { useEffect, useMemo, useRef, type ComponentType, type ReactNode } from 'react'
import { OnboardingWizard, type OnboardingState } from '@/components/onboarding'
import { HomePage } from '@/components/tab-browser/HomePage'
import { TabShell } from '@/components/tab-browser/TabShell'
import { MyCirclesPage } from '@/components/circles/MyCirclesPage'
import { CircleDetailPage } from '@/components/circles/CircleDetailPage'
import { ClientPageProvider, useClientPage } from '@/context/ClientPageContext'
import { AppShellProvider, useOptionalAppShellContext, type AppShellContextType } from '@/context/AppShellContext'
import { SETTINGS_PAGE_COMPONENTS } from '@/pages/settings/settings-pages'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { ActionRegistryProvider } from '@/actions/registry'
import { chatComponents } from '@/playground/registry/chat'
import { ComponentGallery } from './gallery'
import { productSpaceFixture } from './fixtures'

/**
 * Login scenes render through the REAL OnboardingWizard shell — the component
 * that owns `useClientWorkbenchStyle()` and `useClientMaterialScope()` in the
 * product (POO-105 material canvas root, centered layout geometry). Rendering
 * the bare AdminLoginStep here would drop the material scope and the actual
 * cascade, so these scenes deliberately mount the outer shell with a fixture
 * OnboardingState instead.
 */
function onboardingStateFixture(input: {
  phoneAuthEnabled?: boolean
  loginStatus?: 'idle' | 'waiting' | 'success' | 'error'
  errorMessage?: string
}): OnboardingState {
  return {
    step: 'admin-login',
    loginStatus: input.loginStatus ?? 'idle',
    credentialStatus: 'missing' as OnboardingState['credentialStatus'],
    completionStatus: 'saving',
    apiSetupMethod: null,
    isExistingUser: false,
    phoneAuthEnabled: input.phoneAuthEnabled,
    errorMessage: input.errorMessage,
  }
}

const wizardHandlers = {
  onContinue: () => {},
  onBack: () => {},
  onSelectApiSetupMethod: () => {},
  onSubmitCredential: () => {},
  onFinish: () => {},
  onAdminLogin: () => {},
  onAdminSendPhoneCode: () => Promise.resolve({ success: true } as never),
  onAdminVerifyPhoneCode: () => Promise.resolve(true),
  onAdminRelogin: () => {},
  onClearError: () => {},
}

export interface BaselineScene {
  id: string
  region: string
  title: string
  /** Fixture scope note — what is simulated, what is the real component. */
  note: string
  render: () => ReactNode
  /**
   * Full-bleed scenes keep the shell's own geometry at any viewport size:
   * no catalog padding/annotation bar, just a floating link back to the
   * catalog (full-page workbench shells own h-screen).
   */
  fullBleed?: boolean
}

/** playground props contract: entry prop defaults + entry mockData(). */
function entryProps(entry: { props: Array<{ name: string; defaultValue: unknown }>; mockData?: () => Record<string, unknown> }) {
  const defaults = Object.fromEntries(entry.props.map(p => [p.name, p.defaultValue]))
  return { ...defaults, ...(entry.mockData?.() ?? {}) }
}

function chatEntryScene(id: string, entryId: string, title: string, note: string): BaselineScene | null {
  const entry = chatComponents.find(c => c.id === entryId)
  if (!entry) return null
  const Component = entry.component
  const Wrapper = entry.wrapper
  const props = entryProps(entry)
  return {
    id,
    region: '助手',
    title,
    note,
    render: () => (Wrapper ? <Wrapper><Component {...props} /></Wrapper> : <Component {...props} />),
  }
}

type NodeWrapper = ComponentType<{ children: ReactNode }>

function passthrough({ children }: { children: ReactNode }) {
  return <>{children}</>
}

function messagingWrapper({ children }: { children: ReactNode }) {
  return (
    <NavigationProvider
      workspaceId="playground-workspace"
      workspaceSlug="playground"
      onCreateSession={async () => {
        throw new Error('baseline fixture: session creation not wired')
      }}
    >
      {children}
    </NavigationProvider>
  )
}

/**
 * Account-security normal state (R11): the REAL page gates its password form
 * on useOptionalAppShellContext().currentAdminUser. This wrapper re-provides
 * the REAL AppShellProvider (nested over the playground shell value, which it
 * spreads unchanged) with a typed signed-in admin user. No production page or
 * context code is modified. The signed-out variant below renders the same
 * registry page WITHOUT this wrapper.
 */
const baselineAdminUser = {
  userId: 'baseline-admin',
  username: 'admin',
  displayName: 'Baseline Admin',
} satisfies NonNullable<AppShellContextType['currentAdminUser']>

function adminShellWrapper({ children }: { children: ReactNode }) {
  const shell = useOptionalAppShellContext()
  const value = useMemo(
    () => (shell ? { ...shell, currentAdminUser: baselineAdminUser } : null),
    [shell],
  )
  if (!value) {
    throw new Error('account-security baseline scene must sit inside the playground AppShell context')
  }
  return <AppShellProvider value={value}>{children}</AppShellProvider>
}

/** Per-subpage extra providers, matching what AppShell mounts for each page. */
const settingsPageWrapper: Partial<Record<keyof typeof SETTINGS_PAGE_COMPONENTS, NodeWrapper>> = {
  messaging: messagingWrapper,
  shortcuts: ActionRegistryProvider,
  'account-security': adminShellWrapper,
}

function settingsScenes(): BaselineScene[] {
  const scenes = (Object.keys(SETTINGS_PAGE_COMPONENTS) as Array<keyof typeof SETTINGS_PAGE_COMPONENTS>).map((subpage) => {
    const Page = SETTINGS_PAGE_COMPONENTS[subpage]
    const Wrapper = settingsPageWrapper[subpage] ?? passthrough
    return {
      id: `settings-${subpage}`,
      region: '设置',
      title: `Settings · ${subpage}（pages/settings 注册表）`,
      note: '真实页面组件；后端调用由 playground mock + baseline fixture 提供。',
      render: () => <Wrapper><Page /></Wrapper>,
    }
  })
  // Explicit signed-out state of the SAME real page (R11): no admin shell
  // fixture, so the page itself renders its not-signed-in message.
  const signedOutIndex = scenes.findIndex(s => s.id === 'settings-account-security')
  if (signedOutIndex >= 0) {
    const Page = SETTINGS_PAGE_COMPONENTS['account-security']
    scenes.splice(signedOutIndex + 1, 0, {
      id: 'settings-account-security-signed-out',
      region: '设置',
      title: 'Settings · account-security（未登录独立态）',
      note: '同一真实页面组件，无管理员 shell fixture——页面自身渲染未登录提示；正常态表单见 settings-account-security。',
      render: () => <Page />,
    })
  }
  return scenes
}

// ---------------------------------------------------------------------------
// Workbench full-page scenes: the REAL shell composition in App.tsx order —
// ClientPageProvider (outside) → TabShell (TopBar + TabContent → home branch:
// MemberCircleResourceProvider + ClientHomeRouter). Home→circles→detail is the
// product's own navigate/back stack, same fixture data context as the regional
// scenes above; nothing about the shell or the router is re-implemented here.
// ---------------------------------------------------------------------------

/** The Polo tab placeholder: assistant surfaces live in the chat-* scenes. */
function workspacePoloPlaceholder() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center text-sm text-muted-foreground">
      Polo 助手标签页（本场景聚焦工作台 home 分支；助手素材见 chat-* 场景）
    </div>
  )
}

/** Baseline-only deep-route helper: navigates ONCE on mount, then is inert. */
function NavigateOnceToCircleDetail(props: { circleId: string; section: 'content' | 'updates' | 'subscription' }) {
  const { navigate } = useClientPage()
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    navigate({ kind: 'circle-detail', circleId: props.circleId, section: props.section })
  }, [navigate, props.circleId, props.section])
  return null
}

function workspaceShellScene(
  id: string,
  title: string,
  note: string,
  deepRoute?: { circleId: string; section: 'content' | 'updates' | 'subscription' },
): BaselineScene {
  return {
    id,
    region: '工作台整页',
    title,
    note,
    fullBleed: true,
    render: () => (
      <div className="h-screen">
        <ClientPageProvider
          scope={{
            accountId: productSpaceFixture.accountId,
            productSpaceId: productSpaceFixture.activeProductSpaceId,
            epoch: 1,
          }}
        >
          {deepRoute ? <NavigateOnceToCircleDetail {...deepRoute} /> : null}
          <TabShell renderPolo={workspacePoloPlaceholder} />
        </ClientPageProvider>
      </div>
    ),
  }
}

const chatScenes = [
  chatEntryScene('chat-input-container', 'input-container', 'InputContainer（聊天输入区）', '整体复用 playground chat 注册（wrapper/mockData 协议同源）。'),
  chatEntryScene('chat-turn-card', 'turn-card-flat', 'TurnCard（平铺任务卡）', '整体复用 playground chat 注册。'),
  chatEntryScene('chat-turn-card-tasks', 'turn-card-multi-task', 'TurnCard（多任务嵌套）', '整体复用 playground chat 注册。'),
].filter((s): s is BaselineScene => s !== null)

export const baselineScenes: BaselineScene[] = [
  {
    id: 'components-gallery',
    region: '组件画廊',
    title: '组件画廊（第二层：组件与变体浏览）',
    note: '生产组件逐条浏览（settings 12 项 + 聊天/TurnCard/输入区 + onboarding 步骤件），渲染协议与 playground 注册同源；变体切换为真实受控交互，卡片标注生产落点。',
    render: () => <ComponentGallery />,
  },
  {
    id: 'login-phone',
    region: '登录',
    title: 'OnboardingWizard · 管理员登录（手机验证码）',
    note: '真实外层壳 OnboardingWizard（含 useClientMaterialScope 材质画布与居中布局）；fixture 仅提供 state 与回调。',
    render: () => <OnboardingWizard state={onboardingStateFixture({ phoneAuthEnabled: true })} {...wizardHandlers} />,
  },
  {
    id: 'login-password',
    region: '登录',
    title: 'OnboardingWizard · 管理员登录（密码模式）',
    note: '同上，phoneAuthEnabled=false。',
    render: () => <OnboardingWizard state={onboardingStateFixture({ phoneAuthEnabled: false })} {...wizardHandlers} />,
  },
  {
    id: 'login-error',
    region: '登录',
    title: 'OnboardingWizard · 登录错误 + 提交中',
    note: '同上，loginStatus=waiting + errorMessage。',
    render: () => <OnboardingWizard state={onboardingStateFixture({ phoneAuthEnabled: true, loginStatus: 'waiting', errorMessage: '密码不正确，请重试。' })} {...wizardHandlers} />,
  },
  {
    id: 'home-page',
    region: '工作台首页',
    title: 'HomePage（tab-browser，POO-70 C9 home 分支）',
    note: '真实组件；应用目录数据来自 memberCircles/catalog fixture。',
    render: () => (
      <HomePage />
    ),
  },
  {
    id: 'circles-list',
    region: '圈子',
    title: 'MyCirclesPage（我的圈子列表）',
    note: '真实组件；memberCircles.list fixture 返回两条样例（月度+免费）。',
    render: () => <MyCirclesPage />,
  },
  {
    id: 'circle-detail-content',
    region: '圈子',
    title: 'CircleDetailPage · 应用（content）',
    note: '真实组件；fixture circleId，section=content。',
    render: () => <CircleDetailPage circleId="circle-baseline-monthly" section="content" />,
  },
  {
    id: 'circle-detail-updates',
    region: '圈子',
    title: 'CircleDetailPage · 更新（updates）',
    note: '真实组件；section=updates，fixture 返回 upstream_pending 状态。',
    render: () => <CircleDetailPage circleId="circle-baseline-monthly" section="updates" />,
  },
  {
    id: 'circle-detail-subscription',
    region: '圈子',
    title: 'CircleDetailPage · 订阅（subscription）',
    note: '真实组件；section=subscription，fixture 返回可退订的月度订阅。',
    render: () => <CircleDetailPage circleId="circle-baseline-monthly" section="subscription" />,
  },
  ...chatScenes,
  workspaceShellScene(
    'workspace-home',
    'TabShell 工作台整页 · 首页路由',
    '真实 TabShell（TopBar+TabContent）+ ClientPageProvider + ClientHomeRouter；首页→我的圈子→详情为产品自身 navigate/back。Polo 标签页为占位（助手见 chat-*）。',
  ),
  workspaceShellScene(
    'workspace-circle-detail',
    'TabShell 工作台整页 · 圈子详情深路由',
    '同一壳组合，mount 后经 useClientPage().navigate 定位到晨星增长圈详情；顶栏返回/面包屑为真实路由栈。',
    { circleId: 'circle-baseline-monthly', section: 'content' },
  ),
  ...settingsScenes(),
]

/** Layer 2 (组件画廊) first, then layer-3 page/region scenes in product order. */
export const sceneRegions = ['组件画廊', '登录', '工作台整页', '工作台首页', '圈子', '助手', '设置']

export { productSpaceFixture }
