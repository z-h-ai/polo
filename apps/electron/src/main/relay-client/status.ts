/**
 * Relay link status machine (POL-12, PRD v1.6 §⑥).
 *
 * Three states, per the card:
 *   - `online-relay`: the outbound relay link (WSS to polo-relay) is usable.
 *   - `online-lan`  : the embedded WsRpcServer has at least one
 *                     handshake-completed client that is neither a local
 *                     renderer window nor a relay-bridge socket — i.e. a phone
 *                     or CLI over the network / LAN channel (链路④, future).
 *                     (Verified during implementation: local renderer windows
 *                     are always connected in UI mode, so counting them would
 *                     make this state permanently true and meaningless.)
 *   - `offline`     : neither.
 *
 * Precedence: online-relay > online-lan > offline — the relay path is the
 * primary phone link; LAN is the future direct channel (out of scope here).
 * Status is display-only (settings page / menu, M1-6) and never drives
 * business retries.
 */

import type { RelayLinkStatus } from '../../shared/types'

export interface RelayStatusInputs {
  /** Outbound relay WebSocket is open (post-upgrade). */
  relayConnected: boolean
  /** Handshake-completed embedded-server clients excluding renderers and bridge sockets. */
  externalClientCount: number
}

/** Pure state derivation — same inputs always yield the same status. */
export function computeRelayStatus(inputs: RelayStatusInputs): RelayLinkStatus {
  if (inputs.relayConnected) return 'online-relay'
  if (inputs.externalClientCount > 0) return 'online-lan'
  return 'offline'
}

/**
 * Trailing-edge debounce for status broadcasts: rapid flapping (e.g. reconnect
 * churn) coalesces into one emission per quiet window. The first change still
 * waits the full window — status is cosmetic, so the delay is acceptable and
 * keeps the renderer free of transient intermediate states.
 */
export class DebouncedEmitter<T> {
  private pendingValue: T | null = null
  private hasPending = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly emit: (value: T) => void,
    private readonly quietMs: number,
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    private readonly cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  ) {}

  push(value: T): void {
    if (this.disposed) return
    this.pendingValue = value
    this.hasPending = true
    if (this.timer !== null) return // already waiting — trailing value replaces pending
    this.timer = this.schedule(() => {
      this.timer = null
      this.flush()
    }, this.quietMs) as ReturnType<typeof setTimeout>
  }

  /** Emit the pending value immediately (used by dispose and tests). */
  flush(): void {
    if (this.timer !== null) {
      this.cancel(this.timer)
      this.timer = null
    }
    if (!this.hasPending || this.disposed) return
    const value = this.pendingValue
    this.hasPending = false
    this.pendingValue = null
    if (value !== null) this.emit(value)
  }

  dispose(): void {
    if (this.timer !== null) {
      this.cancel(this.timer)
      this.timer = null
    }
    this.disposed = true
    this.hasPending = false
    this.pendingValue = null
  }
}
