/**
 * Credits module (POO-70 M09, ws-circles-account).
 *
 * CreditsGate mounts above the composer (via `HomeSurfaceSlots.
 * creditsBlockingBanner` in demos; real wiring goes through app-shell
 * integration). The remaining components are self-contained surfaces.
 */

export {
  blockedTopup,
  beginCheck,
  settleCheck,
  isSendBlocked,
  requiresUserSendAfterArrival,
  stopReasonIsCreditsShortage,
} from './creditsRules'
export type {
  TopupCheckPhase as TopupCheckRulePhase,
  TopupCheckState,
  GenerationStopReason,
} from './creditsRules'

export { CreditsGate } from './CreditsGate'
export type { CreditsGateProps } from './CreditsGate'

export { StreamCutNotice } from './StreamCutNotice'
export type { StreamCutNoticeProps } from './StreamCutNotice'

export { AppCreditsBanner } from './AppCreditsBanner'
export type { AppCreditsBannerProps } from './AppCreditsBanner'

export { EntCreditsNotify } from './EntCreditsNotify'
export type { EntCreditsNotifyProps } from './EntCreditsNotify'

export { TopupHandoff } from './TopupHandoff'
export type { TopupHandoffProps, TopupHandoffVariant } from './TopupHandoff'

export { TopupCheckFlow } from './TopupCheckFlow'
export type { TopupCheckFlowProps, TopupCheckPhase } from './TopupCheckFlow'

export { UserStopNotice } from './UserStopNotice'
export type { UserStopNoticeProps } from './UserStopNotice'
