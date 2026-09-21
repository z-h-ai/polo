/**
 * POO-70 HiFi shared UI kit (WS-F).
 *
 * Presentational, props-driven components on top of the `--hifi-*` G4
 * product tokens in `./tokens.css`. No business dependencies — the five
 * parallel HiFi workflows compose these for their scenes.
 */
export { StatusPill } from './StatusPill'
export type { StatusPillProps, StatusPillTone } from './StatusPill'

export { SystemScreen } from './SystemScreen'
export type { SystemScreenProps } from './SystemScreen'

export { StateCard } from './StateCard'
export type { StateCardProps, StateCardFact, StateCardIconKind } from './StateCard'

export { HandoffCard } from './HandoffCard'
export type { HandoffCardProps, HandoffCardIconKind } from './HandoffCard'

export { StateIconTile } from './StateIconTile'
export type { StateIconTileProps, HifiStateIconKind } from './StateIconTile'
