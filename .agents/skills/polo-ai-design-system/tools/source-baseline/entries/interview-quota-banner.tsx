import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChatDisplay } from '@/components/app-shell/ChatDisplay'
import { FocusProvider } from '@/context/FocusContext'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { decideChatAccessBanner, type ChatAccessBannerScope } from '@/lib/chat-access-banner'
import type { ChatAccessStatus } from '@/context/AppShellContext'
import type { Session } from '../../../../../../apps/electron/src/shared/types'

const noAction = () => {}
const timestamp = 1793160000000

const session: Session = {
  id: 'interview-quota-banner-session', workspaceId: 'playground-workspace', workspaceName: 'Playground',
  name: '工作记录', lastMessageAt: timestamp, isProcessing: false,
  messages: [{
    id: 'interview-quota-banner-message-1', role: 'assistant', content: '已保留当前工作记录。',
    timestamp, turnId: 'interview-quota-banner-turn-1',
  }],
}

interface QuotaBannerSceneProps {
  status: ChatAccessStatus
  scope: ChatAccessBannerScope
  ariaLabel: string
}

/**
 * Current-renderer billing banner baseline. The decision→banner mapping
 * mirrors pages/ChatPage.tsx (variant / translated message / recharge action
 * / U2 `recheck-billing` secondary action); the wired actions are local
 * no-ops — no GET, no latch recovery, no payment handoff is simulated.
 */
function QuotaBannerScene({ status, scope, ariaLabel }: QuotaBannerSceneProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('请继续整理这份工作记录')
  const decision = decideChatAccessBanner(status, scope)!
  return (
    <NavigationProvider workspaceId="playground-workspace" workspaceSlug="playground"
      onCreateSession={async () => { throw new Error('interview quota fixture: no server session creation') }}>
      <FocusProvider>
        <section className="flex h-screen min-h-0 flex-col" aria-label={ariaLabel}>
          <ChatDisplay session={session} currentModel="gpt-6.1-sol" inputValue={draft} onInputChange={setDraft}
            placeholder="输入消息" permissionMode="ask" disabled
            onSendMessage={() => { throw new Error('interview quota fixture: sending is blocked') }}
            onOpenFile={noAction} onOpenUrl={noAction} workspaceId="playground-workspace"
            inputStatusBanner={{
              variant: decision.variant,
              message: t(decision.messageKey),
              ...(decision.action === 'recharge'
                ? { actionLabel: t('chat.statusBanner.recharge'), onAction: noAction }
                : {}),
              ...(decision.secondaryAction === 'recheck-billing'
                ? { secondaryActionLabel: t('billingRecheck.action'), onSecondaryAction: noAction }
                : {}),
            }} />
        </section>
      </FocusProvider>
    </NavigationProvider>
  )
}

/** insufficient-credit without the payment handoff: member copy + U2 recheck only. */
export function InterviewQuotaMemberScene() {
  return <QuotaBannerScene status={{ issue: 'insufficient-credit', refreshable: true }}
    scope={{ canOpenPayment: false }} ariaLabel="额度提醒（成员）" />
}

/** insufficient-credit with the trusted payment handoff: recharge + U2 recheck. */
export function InterviewQuotaOwnerScene() {
  return <QuotaBannerScene status={{ issue: 'insufficient-credit', refreshable: true }}
    scope={{ canOpenPayment: true }} ariaLabel="额度提醒（所有者）" />
}
