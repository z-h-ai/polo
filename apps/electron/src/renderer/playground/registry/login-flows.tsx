import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry } from './types'
import { StatusPill } from '@/components/hifi'
import {
  BlockedStateCard,
  HandoffPage,
  HifiActionButton,
  LoginScreen,
  RecoveryScreen,
  SystemStatePage,
} from '@/components/system'
import { useAuthFlow, type UseAuthFlowReturn } from '@/hooks/useAuthFlow'
import { DemoFixedContainer } from '../mocks'

// =============================================================================
// Login & Recovery Flows Playground (POO-70 HiFi, WS-LOGIN)
// One variant per prototype scene — pick a variant to review that screen:
// - M01 login split (password / phone / code / cancelled / expired reopen)
// - personal space preparation + failure, cold-start revalidation
// - browser handoff cards (invite / mismatch / pending / download / create)
// - M11 system states (reauth / revoke / restricted / contract ×3 / offline ×2)
// - blocked app workspace cards + reopen recovery card
// Full-screen surfaces are fixed-positioned, so they render inside
// DemoFixedContainer (the transformed layer clips them to the preview box).
// =============================================================================

const DEMO_ACCOUNT = '小王'
const DEMO_ORG = '晨星科技'
const DEMO_CIRCLE = '晨星增长圈'
const DEMO_APP = '客户资料核验'

/** Mounts LoginScreen with its own flow, pre-walked by `prepare`. */
function DemoLoginFlow({ prepare }: { prepare?: (flow: UseAuthFlowReturn) => void }) {
  const flow = useAuthFlow()
  const initialized = React.useRef(false)
  React.useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    flow.start()
    prepare?.(flow)
  }, [flow, prepare])
  return <LoginScreen flow={flow} />
}

function preparePhoneEntry(flow: UseAuthFlowReturn) {
  flow.switchMode('phone')
}

function prepareCodeEntry(flow: UseAuthFlowReturn) {
  flow.switchMode('phone')
  flow.setPhone('13800138000')
  flow.setConsented(true)
  // The demo adapter resolves immediately; the code entry arms its countdown.
  void flow.sendCode('13800138000')
}

function prepareCancelled(flow: UseAuthFlowReturn) {
  flow.setPhone('13800138000')
  flow.cancel()
}

function prepareExpired(flow: UseAuthFlowReturn) {
  flow.setPhone('13800138000')
  flow.markSessionExpired()
}

export function LoginFlowsDemo({ scene }: { scene: string }) {
  const { t } = useTranslation()

  switch (scene) {
    // ---- M01 · login split -------------------------------------------------
    case 'P-M01-LOGIN-PASSWORD':
      return (
        <DemoFixedContainer width={1040} height={680}>
          <DemoLoginFlow />
        </DemoFixedContainer>
      )
    case 'P-M01-LOGIN-PHONE':
      return (
        <DemoFixedContainer width={1040} height={680}>
          <DemoLoginFlow prepare={preparePhoneEntry} />
        </DemoFixedContainer>
      )
    case 'P-M01-LOGIN-CODE':
      return (
        <DemoFixedContainer width={1040} height={680}>
          <DemoLoginFlow prepare={prepareCodeEntry} />
        </DemoFixedContainer>
      )
    case 'P-M01-LOGIN-CANCEL':
      return (
        <DemoFixedContainer width={1040} height={680}>
          <DemoLoginFlow prepare={prepareCancelled} />
        </DemoFixedContainer>
      )
    case 'P-M01-REOPEN':
      return (
        <DemoFixedContainer width={1040} height={680}>
          <DemoLoginFlow prepare={prepareExpired} />
        </DemoFixedContainer>
      )

    // ---- M01 · personal space bootstrap ------------------------------------
    case 'P-M01-PERSONAL-PREP':
      return (
        <DemoFixedContainer width={720} height={540}>
          <SystemStatePage
            icon={{ kind: 'spinning' }}
            eyebrow={t('login.prep.eyebrow')}
            title={t('login.prep.title')}
            facts={[
              { label: t('login.prep.fact.account'), value: DEMO_ACCOUNT },
              {
                label: t('login.prep.fact.progress'),
                value: t('login.prep.fact.progressValue'),
              },
            ]}
            actions={
              <HifiActionButton variant="primary">
                {t('login.prep.action.enterHome')}
              </HifiActionButton>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M01-PERSONAL-PREP-FAIL':
      return (
        <DemoFixedContainer width={720} height={540}>
          <SystemStatePage
            icon={{ kind: 'destructive' }}
            eyebrow={t('login.prepFail.eyebrow')}
            title={t('login.prepFail.title')}
            description={t('login.prepFail.description')}
            facts={[
              { label: t('login.prepFail.fact.account'), value: DEMO_ACCOUNT },
              {
                label: t('login.prepFail.fact.data'),
                value: t('login.prepFail.fact.dataValue'),
              },
            ]}
            actions={
              <>
                <HifiActionButton>{t('login.prepFail.action.relogin')}</HifiActionButton>
                <HifiActionButton variant="primary">
                  {t('login.prepFail.action.retry')}
                </HifiActionButton>
              </>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M01-REFRESH-FAIL':
      return (
        <DemoFixedContainer width={720} height={540}>
          <SystemStatePage
            icon={{ kind: 'destructive' }}
            eyebrow={t('login.refreshFail.eyebrow')}
            title={t('login.refreshFail.title')}
            description={t('login.refreshFail.description')}
            facts={[
              {
                label: t('login.refreshFail.fact.membership'),
                value: t('login.refreshFail.fact.membershipValue'),
              },
              {
                label: t('login.refreshFail.fact.list'),
                value: t('login.refreshFail.fact.listValue'),
              },
              {
                label: t('login.refreshFail.fact.page'),
                value: t('login.refreshFail.fact.pageValue'),
              },
            ]}
            actions={
              <>
                <HifiActionButton>{t('login.refreshFail.action.stay')}</HifiActionButton>
                <HifiActionButton variant="primary">{t('common.reload')}</HifiActionButton>
              </>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M01-COLD-START':
      return (
        <DemoFixedContainer width={720} height={540}>
          <SystemStatePage
            icon={{ kind: 'spinning' }}
            eyebrow={t('login.coldStart.eyebrow')}
            title={t('login.coldStart.title')}
            description={t('login.coldStart.description')}
            facts={[
              {
                label: t('login.coldStart.fact.account'),
                value: t('login.coldStart.fact.accountValue'),
              },
              {
                label: t('login.coldStart.fact.invites'),
                value: t('login.coldStart.fact.invitesValue', { count: 1 }),
              },
              {
                label: t('login.coldStart.fact.spaces'),
                value: t('login.coldStart.fact.spacesValue', { count: 3 }),
              },
            ]}
            actions={
              <HifiActionButton variant="primary">{t('login.coldStart.action')}</HifiActionButton>
            }
          />
        </DemoFixedContainer>
      )

    // ---- M01 · browser handoff ---------------------------------------------
    case 'P-M01-INVITE-BROWSER':
      return (
        <DemoFixedContainer width={780} height={560}>
          <HandoffPage
            eyebrow={t('login.invite.eyebrow')}
            title={t('login.invite.title', { circle: DEMO_CIRCLE })}
            description={t('login.invite.description')}
            browserLabel={t('login.handoff.browserLabel')}
            desktopLabel={t('login.handoff.desktopLabel')}
            browserResponsibilities={[
              t('login.invite.browser1'),
              t('login.invite.browser2'),
            ]}
            desktopResponsibilities={[
              t('login.invite.desktop1'),
              t('login.invite.desktop2'),
            ]}
            actions={
              <>
                <HifiActionButton>{t('login.invite.action.decline')}</HifiActionButton>
                <HifiActionButton variant="primary">
                  {t('login.invite.action.accept')}
                </HifiActionButton>
              </>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M01-INVITE-MISMATCH':
      return (
        <DemoFixedContainer width={780} height={560}>
          <HandoffPage
            layout="facts"
            icon={{ kind: 'destructive' }}
            eyebrow={t('login.mismatch.eyebrow')}
            title={t('login.mismatch.title')}
            description={t('login.mismatch.description')}
            facts={[
              { label: t('login.mismatch.fact.currentAccount'), value: '+86 138 •••• 8000' },
              { label: t('login.mismatch.fact.invitedAccount'), value: 'xiaowang@chenxing.com' },
              {
                label: t('login.mismatch.fact.workspace'),
                value: t('login.mismatch.fact.workspaceValue'),
              },
            ]}
            actions={
              <>
                <HifiActionButton>{t('common.back')}</HifiActionButton>
                <HifiActionButton variant="primary">
                  {t('login.mismatch.action.switchAccount')}
                </HifiActionButton>
              </>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M01-INVITE-PENDING':
      return (
        <DemoFixedContainer width={780} height={560}>
          <HandoffPage
            layout="facts"
            eyebrow={t('login.pending.eyebrow')}
            title={t('login.pending.title')}
            description={t('login.pending.description')}
            facts={[
              {
                label: t('login.pending.fact.status'),
                value: t('login.pending.fact.statusValue'),
              },
              {
                label: t('login.pending.fact.mySpace'),
                value: t('login.pending.fact.mySpaceValue'),
              },
              {
                label: t('login.pending.fact.workspace'),
                value: t('login.pending.fact.workspaceValue'),
              },
            ]}
            actions={
              <HifiActionButton variant="primary">
                {t('login.pending.action.enterMySpace')}
              </HifiActionButton>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M01-NOT-INSTALLED':
      return (
        <DemoFixedContainer width={780} height={560}>
          <HandoffPage
            eyebrow={t('login.notInstalled.eyebrow')}
            title={t('login.notInstalled.title')}
            description={t('login.notInstalled.description')}
            browserLabel={t('login.handoff.browserLabel')}
            desktopLabel={t('login.handoff.desktopLabel')}
            browserResponsibilities={[
              t('login.notInstalled.browser1'),
              t('login.notInstalled.browser2'),
            ]}
            desktopResponsibilities={[
              t('login.notInstalled.desktop1'),
              t('login.notInstalled.desktop2'),
            ]}
            actions={
              <HifiActionButton variant="primary">
                {t('login.notInstalled.action.download')}
              </HifiActionButton>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M01-CREATE-ENT':
      return (
        <DemoFixedContainer width={780} height={560}>
          <HandoffPage
            eyebrow={t('login.createEnt.eyebrow')}
            title={t('login.createEnt.title')}
            description={t('login.createEnt.description')}
            browserLabel={t('login.handoff.browserLabel')}
            desktopLabel={t('login.handoff.desktopLabel')}
            browserResponsibilities={[
              t('login.createEnt.browser1'),
              t('login.createEnt.browser2'),
            ]}
            desktopResponsibilities={[
              t('login.createEnt.desktop1'),
              t('login.createEnt.desktop2'),
            ]}
            actions={
              <>
                <HifiActionButton>{t('common.cancel')}</HifiActionButton>
                <HifiActionButton variant="primary">
                  {t('login.createEnt.action.openAdmin')}
                </HifiActionButton>
              </>
            }
          />
        </DemoFixedContainer>
      )

    // ---- M11 · system states -----------------------------------------------
    case 'P-M11-REAUTH':
      return (
        <DemoFixedContainer width={720} height={540}>
          <SystemStatePage
            icon={{ kind: 'spinning' }}
            eyebrow={t('recovery.reauth.eyebrow')}
            title={t('recovery.reauth.title')}
            description={t('recovery.reauth.description')}
            facts={[
              { label: t('recovery.reauth.fact.lastSpace'), value: t('login.refreshFail.fact.pageValue') },
              {
                label: t('recovery.reauth.fact.lastTabs'),
                value: t('recovery.reauth.fact.lastTabsValue'),
              },
            ]}
            actions={
              <HifiActionButton variant="primary">{t('common.continue')}</HifiActionButton>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M11-REVOKE':
      return (
        <DemoFixedContainer width={720} height={560}>
          <SystemStatePage
            icon={{ kind: 'destructive' }}
            eyebrow={t('recovery.revoke.eyebrow')}
            title={t('recovery.revoke.title', { org: DEMO_ORG })}
            description={t('recovery.revoke.description')}
            note={t('recovery.revoke.note')}
            facts={[
              {
                label: '报价整理',
                value: <StatusPill tone="info">{t('recovery.revoke.status.stopping')}</StatusPill>,
              },
              {
                label: '助手 · Q2 报价汇总',
                value: <StatusPill tone="info">{t('recovery.revoke.status.stopping')}</StatusPill>,
              },
              {
                label: '数据报表生成器',
                value: <StatusPill tone="success">{t('recovery.revoke.status.stopped')}</StatusPill>,
              },
            ]}
            actions={
              <>
                <HifiActionButton>{t('recovery.revoke.backToMySpace')}</HifiActionButton>
                <HifiActionButton variant="primary">
                  {t('recovery.revoke.backToSwitcher')}
                </HifiActionButton>
              </>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M11-PERSONAL-RESTRICTED':
      return (
        <DemoFixedContainer width={720} height={540}>
          <SystemStatePage
            icon={{ kind: 'destructive' }}
            eyebrow={t('recovery.restricted.eyebrow')}
            title={t('recovery.restricted.title')}
            description={t('recovery.restricted.description')}
            facts={[
              { label: t('recovery.restricted.fact.account'), value: DEMO_ACCOUNT },
              {
                label: t('recovery.restricted.fact.status'),
                value: t('recovery.restricted.fact.statusValue'),
              },
              { label: t('recovery.restricted.fact.reference'), value: 'ACC-0182' },
            ]}
            actions={
              <>
                <HifiActionButton>{t('recovery.restricted.action.logout')}</HifiActionButton>
                <HifiActionButton variant="primary">
                  {t('recovery.restricted.action.contactAdmin')}
                </HifiActionButton>
              </>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M11-CONTRACT':
      return (
        <DemoFixedContainer width={720} height={540}>
          <SystemStatePage
            icon={{ kind: 'info' }}
            eyebrow={t('recovery.contract.eyebrow')}
            title={t('recovery.contract.title')}
            description={t('recovery.contract.description')}
            facts={[
              { label: t('recovery.contract.fact.current'), value: 'v0.16' },
              { label: t('recovery.contract.fact.target'), value: 'v0.17' },
              {
                label: t('recovery.contract.fact.personal'),
                value: t('recovery.contract.fact.personalValue'),
              },
            ]}
            actions={
              <>
                <HifiActionButton>{t('recovery.contract.usePersonal')}</HifiActionButton>
                <HifiActionButton variant="primary">{t('recovery.contract.download')}</HifiActionButton>
              </>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M11-CONTRACT-DL':
      return (
        <DemoFixedContainer width={720} height={540}>
          <SystemStatePage
            icon={{ kind: 'spinning' }}
            eyebrow={t('recovery.contractDl.eyebrow')}
            title={t('recovery.contractDl.title')}
            description={t('recovery.contractDl.description')}
            progress={{
              value: 68,
              label: t('recovery.contractDl.progressLabel', { percent: 68 }),
            }}
            facts={[
              { label: t('recovery.contract.fact.current'), value: 'v0.16' },
              { label: t('recovery.contract.fact.target'), value: 'v0.17' },
            ]}
            actions={
              <>
                <HifiActionButton>{t('recovery.contract.usePersonal')}</HifiActionButton>
                <HifiActionButton variant="primary" disabled>
                  {t('recovery.contractDl.downloading')}
                </HifiActionButton>
              </>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M11-CONTRACT-FAIL':
      return (
        <DemoFixedContainer width={720} height={540}>
          <SystemStatePage
            icon={{ kind: 'destructive' }}
            eyebrow={t('recovery.contractFail.eyebrow')}
            title={t('recovery.contractFail.title')}
            description={t('recovery.contractFail.description', { version: 'v0.16' })}
            facts={[
              {
                label: t('recovery.contractFail.fact.downloaded'),
                value: t('recovery.contractFail.fact.downloadedValue'),
              },
              {
                label: t('recovery.contractFail.fact.local'),
                value: t('recovery.contractFail.fact.localValue', { version: 'v0.16' }),
              },
            ]}
            actions={
              <>
                <HifiActionButton>{t('recovery.contractFail.useCurrent')}</HifiActionButton>
                <HifiActionButton variant="primary">
                  {t('recovery.contractFail.retry')}
                </HifiActionButton>
              </>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M11-SPACE-ERROR':
      return (
        <DemoFixedContainer width={720} height={540}>
          <SystemStatePage
            icon={{ kind: 'destructive' }}
            eyebrow={t('recovery.spaceError.eyebrow')}
            title={t('recovery.spaceError.title')}
            description={t('recovery.spaceError.description')}
            facts={[
              {
                label: t('recovery.spaceError.fact.saved'),
                value: t('recovery.spaceError.fact.savedValue', {
                  count: 3,
                  time: `09:12`,
                }),
              },
              {
                label: t('recovery.spaceError.fact.online'),
                value: t('recovery.spaceError.fact.onlineValue'),
              },
            ]}
            actions={
              <>
                <HifiActionButton>{t('recovery.spaceError.offline')}</HifiActionButton>
                <HifiActionButton variant="primary">{t('common.retry')}</HifiActionButton>
              </>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M11-OFFLINE-HOME':
      return (
        <DemoFixedContainer width={720} height={540}>
          <SystemStatePage
            icon={{ kind: 'info' }}
            eyebrow={t('recovery.offline.eyebrow')}
            title={t('recovery.offline.title')}
            description={t('recovery.offline.description')}
            facts={[
              {
                label: t('recovery.offline.fact.installedApps'),
                value: t('recovery.offline.fact.installedAppsValue'),
              },
            ]}
            actions={
              <HifiActionButton variant="primary">{t('recovery.offline.retry')}</HifiActionButton>
            }
          />
        </DemoFixedContainer>
      )
    case 'P-M11-REOPEN-RECOVERY':
      return (
        <DemoFixedContainer width={700} height={520}>
          <div className="grid h-full place-items-center overflow-y-auto bg-hifi-background p-6">
            <RecoveryScreen
              eyebrow={t('recovery.reopen.eyebrow')}
              title={t('recovery.reopen.title')}
              description={t('recovery.reopen.description')}
              facts={[
                {
                  label: t('recovery.reopen.fact.sessions'),
                  value: t('recovery.reopen.fact.sessionsValue', { count: 3 }),
                },
                {
                  label: t('recovery.reopen.fact.tabs'),
                  value: t('recovery.reopen.fact.tabsValue', { count: 2 }),
                },
                {
                  label: '数据报表生成器',
                  value: <StatusPill tone="info">{t('recovery.reopen.status.running')}</StatusPill>,
                },
                {
                  label: '报价整理',
                  value: <StatusPill tone="neutral">{t('recovery.reopen.status.pending')}</StatusPill>,
                },
              ]}
              actions={
                <HifiActionButton variant="primary">{t('login.coldStart.action')}</HifiActionButton>
              }
            />
          </div>
        </DemoFixedContainer>
      )

    // ---- M11 · blocked app workspace cards ---------------------------------
    case 'P-M11-BLOCKED-WITHDRAWN':
      return (
        <DemoFixedContainer width={780} height={560}>
          <div className="grid h-full place-items-center overflow-y-auto bg-hifi-background p-6">
            <BlockedStateCard
              className="w-full max-w-[720px]"
              eyebrow={`${DEMO_ORG} · App`}
              title={t('recovery.blocked.withdrawn.title', { app: DEMO_APP })}
              description={t('recovery.blocked.withdrawn.description', { org: DEMO_ORG })}
              actions={
                <>
                  <HifiActionButton>{t('recovery.blocked.viewRuns')}</HifiActionButton>
                  <HifiActionButton variant="primary">
                    {t('recovery.blocked.backToApps')}
                  </HifiActionButton>
                </>
              }
            />
          </div>
        </DemoFixedContainer>
      )
    case 'P-M11-BLOCKED-EXPIRED':
      return (
        <DemoFixedContainer width={780} height={560}>
          <div className="grid h-full place-items-center overflow-y-auto bg-hifi-background p-6">
            <BlockedStateCard
              className="w-full max-w-[720px]"
              eyebrow={`来源：${DEMO_CIRCLE}、晨星设计圈`}
              title={t('recovery.blocked.expired.title')}
              description={t('recovery.blocked.expired.description', {
                sources: '晨星增长圈来源已撤销，晨星设计圈来源也已到期。',
              })}
              actions={
                <>
                  <HifiActionButton>{t('recovery.blocked.viewRuns')}</HifiActionButton>
                  <HifiActionButton>{t('recovery.blocked.rejoin', { circle: DEMO_CIRCLE })}</HifiActionButton>
                  <HifiActionButton variant="primary">{t('recovery.blocked.renew')}</HifiActionButton>
                </>
              }
            />
          </div>
        </DemoFixedContainer>
      )
    case 'P-M11-BLOCKED-VERSION':
      return (
        <DemoFixedContainer width={780} height={560}>
          <div className="grid h-full place-items-center overflow-y-auto bg-hifi-background p-6">
            <BlockedStateCard
              className="w-full max-w-[720px]"
              eyebrow={`${DEMO_ORG} · App`}
              title={t('recovery.blocked.version.title', { version: 'v0.9.4' })}
              description={t('recovery.blocked.version.description')}
              actions={
                <>
                  <HifiActionButton>{t('recovery.blocked.viewRuns')}</HifiActionButton>
                  <HifiActionButton variant="primary">
                    {t('recovery.blocked.contactAdmin')}
                  </HifiActionButton>
                </>
              }
            />
          </div>
        </DemoFixedContainer>
      )
    case 'P-M11-OFFLINE-RUNNING':
      return (
        <DemoFixedContainer width={780} height={560}>
          <div className="grid h-full place-items-center overflow-y-auto bg-hifi-background p-6">
            <BlockedStateCard
              className="w-full max-w-[720px]"
              icon={{ kind: 'accent' }}
              eyebrow={`${DEMO_ORG} · App`}
              title={t('recovery.offlineRunning.title')}
              description={t('recovery.offlineRunning.description')}
              actions={
                <>
                  <HifiActionButton>{t('recovery.offline.retry')}</HifiActionButton>
                  <HifiActionButton>{t('recovery.offlineRunning.viewProgress')}</HifiActionButton>
                  <HifiActionButton variant="primary">
                    {t('recovery.offlineRunning.stop')}
                  </HifiActionButton>
                </>
              }
            />
          </div>
        </DemoFixedContainer>
      )
    case 'P-M11-SUPPORT-BROWSER':
      return (
        <DemoFixedContainer width={780} height={560}>
          <HandoffPage
            eyebrow={t('recovery.support.eyebrow')}
            title={t('recovery.support.title')}
            description={t('recovery.support.description')}
            browserLabel={t('login.handoff.browserLabel')}
            desktopLabel={t('login.handoff.desktopLabel')}
            browserResponsibilities={[
              t('recovery.support.browser1'),
              t('recovery.support.browser2'),
            ]}
            desktopResponsibilities={[
              t('recovery.support.desktop1'),
              t('recovery.support.desktop2'),
            ]}
            actions={
              <>
                <HifiActionButton>{t('recovery.support.action.backToVersion')}</HifiActionButton>
                <HifiActionButton>{t('common.back')}</HifiActionButton>
                <HifiActionButton variant="primary">
                  {t('recovery.support.action.copyRef')}
                </HifiActionButton>
              </>
            }
          />
        </DemoFixedContainer>
      )
    default:
      return (
        <div className="p-4 text-sm text-muted-foreground">
          Unknown scene: {scene}
        </div>
      )
  }
}

const SCENES = [
  'P-M01-LOGIN-PASSWORD',
  'P-M01-LOGIN-PHONE',
  'P-M01-LOGIN-CODE',
  'P-M01-LOGIN-CANCEL',
  'P-M01-PERSONAL-PREP',
  'P-M01-PERSONAL-PREP-FAIL',
  'P-M01-REOPEN',
  'P-M01-INVITE-BROWSER',
  'P-M01-INVITE-MISMATCH',
  'P-M01-INVITE-PENDING',
  'P-M01-REFRESH-FAIL',
  'P-M01-NOT-INSTALLED',
  'P-M01-CREATE-ENT',
  'P-M01-COLD-START',
  'P-M11-REAUTH',
  'P-M11-REVOKE',
  'P-M11-PERSONAL-RESTRICTED',
  'P-M11-BLOCKED-WITHDRAWN',
  'P-M11-BLOCKED-EXPIRED',
  'P-M11-BLOCKED-VERSION',
  'P-M11-OFFLINE-HOME',
  'P-M11-OFFLINE-RUNNING',
  'P-M11-CONTRACT',
  'P-M11-CONTRACT-DL',
  'P-M11-CONTRACT-FAIL',
  'P-M11-SPACE-ERROR',
  'P-M11-REOPEN-RECOVERY',
  'P-M11-SUPPORT-BROWSER',
]

export const loginFlowsComponents: ComponentEntry[] = [
  {
    id: 'login-flows',
    name: 'Login & Recovery Flows',
    category: 'Fullscreen',
    description:
      'WS-LOGIN 28 屏：登录三态 + 取消/过期、我的空间准备中/失败、冷启动重验、邀请/账号不匹配/待审批/下载指引/创建企业交接卡、重登回位、被移除、账号受限、作品阻断三态、离线两态、升级契约三态、空间列表失败、重开恢复、支持请求交接（截图命名 <WS>-<scene>-<variant>.png）',
    component: LoginFlowsDemo,
    layout: 'top',
    previewOverflow: 'visible',
    props: [
      {
        name: 'scene',
        description: '原型 scene ID（与截图命名一致）',
        control: {
          type: 'select',
          options: SCENES.map((scene) => ({ label: scene, value: scene })),
        },
        defaultValue: 'P-M01-LOGIN-PASSWORD',
      },
    ],
    variants: SCENES.map((scene) => ({
      name: scene,
      description: `scene ${scene}`,
      props: { scene },
    })),
  },
]
