/**
 * Circles module (POO-70 M07, ws-circles-account).
 *
 * `CircleSourcedApp` / `CircleWorkSource` are the cross-workflow dedupe
 * contract with ws-home-apps — import the types from here.
 */

export type {
  CircleMembershipState,
  CircleSubscription,
  CircleSummary,
  CircleSourcedApp,
  CircleWorkSource,
  CircleWorkAvailability,
  CircleWorkRow,
  CircleWorksInput,
} from './types'

export {
  addMonths,
  applyRenewal,
  buildCircleWorkRows,
  isAppUsable,
  membershipState,
  MAX_PREPAID_MONTHS,
  maxPrepaidExpiry,
  renewalBaseDate,
  revokeCircleSources,
} from './circlesState'
export type { CircleWorkDetails } from './circlesState'

export { CirclesEntryCard } from './CirclesEntryCard'
export type { CirclesEntryCardProps } from './CirclesEntryCard'

export { CirclesListPage } from './CirclesListPage'
export type { CirclesListPageProps } from './CirclesListPage'

export { CircleDetailPage } from './CircleDetailPage'
export type { CircleDetailPageProps } from './CircleDetailPage'

export { SourcedWorksPanel } from './SourcedWorksPanel'
export type { SourcedWorksPanelProps } from './SourcedWorksPanel'

export { JoinFlow } from './JoinFlow'
export type { JoinFlowProps } from './JoinFlow'

export { SubscribeFlow } from './SubscribeFlow'
export type { SubscribeFlowProps } from './SubscribeFlow'

export { RenewFlow } from './RenewFlow'
export type { RenewFlowProps } from './RenewFlow'

export { LeaveFlow } from './LeaveFlow'
export type { LeaveFlowProps } from './LeaveFlow'

export { FlowButton } from './flowButtons'
export type { FlowButtonProps, FlowButtonVariant } from './flowButtons'
