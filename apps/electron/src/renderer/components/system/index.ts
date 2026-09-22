/**
 * POO-70 WS-LOGIN · login & exception-recovery surfaces.
 *
 * Mountable without props (demo adapter inside `useAuthFlow`) or driven via
 * the `flow` / props seams for the real admin RPC wiring.
 */
export { LoginScreen } from './LoginScreen'
export type { LoginScreenProps } from './LoginScreen'

export { PhoneCodeForm } from './PhoneCodeForm'
export type { PhoneCodeFormProps } from './PhoneCodeForm'

export { SystemStatePage } from './SystemStatePage'
export type { SystemStatePageProps } from './SystemStatePage'

export { HandoffPage } from './HandoffPage'
export type { HandoffPageProps } from './HandoffPage'

export { RecoveryScreen } from './RecoveryScreen'
export type { RecoveryScreenProps } from './RecoveryScreen'

export { BlockedStateCard } from './BlockedStateCard'
export type { BlockedStateCardProps } from './BlockedStateCard'

export {
  HifiActionButton,
  InlineAlert,
  SystemProgressBar,
} from './primitives'
export type {
  HifiButtonProps,
  HifiButtonVariant,
  InlineAlertProps,
  InlineAlertTone,
  SystemProgressBarProps,
} from './primitives'
