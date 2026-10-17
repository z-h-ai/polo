/**
 * Envelope model for polo-relay (PRD v1.6 §⑥): `{v,from,to,kind,payload,queuedAt}`.
 * The relay is a dumb router — it never interprets WsRpc semantics inside `payload`.
 * Persona ids: `phone:<phoneDeviceId>` / `mac:<macDeviceId>`; control envelopes are
 * sent from the `relay` pseudo-persona.
 */

import { z } from 'zod'

export const ENVELOPE_VERSION = 1 as const

export const EnvelopeSchema = z.object({
  v: z.literal(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.string().min(1),
  payload: z.unknown(),
  queuedAt: z.number().optional(),
})

export type Envelope = {
  v: typeof ENVELOPE_VERSION
  from: string
  to: string
  kind: string
  payload: unknown
  queuedAt?: number
}

export type PersonaSide = 'phone' | 'mac'

export interface Persona {
  side: PersonaSide
  id: string
  /** Canonical persona id, e.g. `mac:abc123`. */
  persona: string
}

export function parsePersona(id: string): Persona | null {
  if (id.startsWith('phone:')) {
    const deviceId = id.slice('phone:'.length)
    return deviceId ? { side: 'phone', id: deviceId, persona: id } : null
  }
  if (id.startsWith('mac:')) {
    const deviceId = id.slice('mac:'.length)
    return deviceId ? { side: 'mac', id: deviceId, persona: id } : null
  }
  return null
}

// ---------------------------------------------------------------------------
// Control receipts (metadata only — never carry user payload)
// ---------------------------------------------------------------------------

export type DeliveryFailureReason =
  | 'mac_offline'
  | 'phone_offline'
  | 'not_allowed'
  | 'access_check_failed'
  | 'queue_full'

export type ControlPayload =
  | { type: 'delivery_failed'; reason: DeliveryFailureReason }
  | { type: 'peer_disconnected'; peer: string }

export function buildControlEnvelope(to: string, payload: ControlPayload, now: number = Date.now()): Envelope {
  return { v: ENVELOPE_VERSION, from: 'relay', to, kind: 'control', payload, queuedAt: now }
}

export function serializeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope)
}

/** App-level heartbeat frames (kept separate from envelopes; never routed). */
export const HeartbeatFrameSchema = z.object({ type: z.enum(['ping', 'pong']) })
