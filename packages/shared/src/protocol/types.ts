/**
 * Wire protocol types for the WS-based RPC layer.
 *
 * Shared between server (main process / headless) and client (renderer / Node).
 */

import {
  LOCAL_APP_ERROR_CODES,
  LOCAL_APP_INSTALL_RPC_TIMEOUT_MS,
  type LocalAppErrorCode,
} from './local-apps'
import { PC_ERROR_CODES, PC_LOCAL_ERROR_CODES, type PcErrorCode } from './project-context'
import {
  CLIENT_ENTERPRISE_ERROR_CODES,
  PM_LOCAL_ERROR_CODES,
  PROJECT_ERROR_CODES,
  type ClientEnterpriseErrorCode,
  type PmLocalErrorCode,
  type ProjectErrorCode,
} from './project-members'
import { SESSION_PROJECT_ERROR_CODES, type SessionProjectErrorCode } from './session-project'

// ---------------------------------------------------------------------------
// Message envelope
// ---------------------------------------------------------------------------

export type MessageType =
  | 'handshake'
  | 'handshake_ack'
  | 'request'
  | 'response'
  | 'event'
  | 'error'
  | 'sequence_ack'

export interface MessageEnvelope {
  /** Correlation ID. UUIDv4 for requests; echoed in responses. */
  id: string
  type: MessageType
  /** Required for request / response / event / error. */
  channel?: string
  /** Request args or event payload. */
  args?: unknown[]
  /** Response payload. */
  result?: unknown
  /** Structured error. */
  error?: WireError
  /** Sent on handshake / handshake_ack. */
  protocolVersion?: string
  /** Sent on handshake by the client. */
  workspaceId?: string
  /** Sent on handshake for remote auth. */
  token?: string
  /** Assigned by server in handshake_ack. */
  clientId?: string
  /** Server identity stamp on outgoing events. For MultiClient source disambiguation. */
  serverId?: string
  /** Electron webContents.id, sent on handshake by local clients. */
  webContentsId?: number
  /** Client capabilities advertised on handshake. */
  clientCapabilities?: string[]
  /** Server-registered channels, sent in handshake_ack. Clients use this to avoid calling unavailable channels. */
  registeredChannels?: string[]

  // -- Reliable delivery fields --

  /** Per-client monotonic delivery sequence number, assigned when an event is targeted to that client. */
  seq?: number
  /** Client's last processed per-client seq — sent in sequence_ack and reconnect handshake. */
  lastSeq?: number
  /** Previous clientId — sent by client on reconnect handshake. */
  reconnectClientId?: string
  /** True when handshake_ack is for a reconnection (vs fresh connect). */
  reconnected?: boolean
  /** True when server buffer was evicted — client must do a full state refresh. */
  stale?: boolean
  /** Server app version, sent in handshake_ack. Clients can use this for compatibility checks. */
  serverVersion?: string
}

export interface WireError {
  code: ErrorCode
  message: string
  data?: unknown
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'HANDLER_ERROR'
  | 'CHANNEL_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'SESSION_NOT_IDLE'
  | 'SESSION_ID_CONFLICT'
  // POO-205 C5 (X2): sendMessage refused because the session's persisted
  // content exists on disk but could not be loaded into memory — sending
  // would risk persisting over the unreadable history with an empty one.
  | 'SESSION_CONTENT_UNAVAILABLE'
  | 'ARTIFACT_NOT_PORTABLE'
  | 'TRANSFER_TOO_LARGE'
  | 'TRANSFER_TIMEOUT'
  | 'TRANSFER_VERIFICATION_FAILED'
  | 'REQUEST_TIMEOUT'
  | 'CAPABILITY_UNAVAILABLE'
  | 'CLIENT_DISCONNECTED'
  | 'CLIENT_REQUEST_TIMEOUT'
  | 'BROWSER_NO_CAPABLE_CLIENT'
  | 'BROWSER_INSTANCE_NOT_OWNED'
  | 'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED'
  | 'BROWSER_REMOTE_EVALUATE_BLOCKED'
  | LocalAppErrorCode
  | PcErrorCode
  | ClientEnterpriseErrorCode
  | PmLocalErrorCode
  | ProjectErrorCode
  | SessionProjectErrorCode

/**
 * Every code the transport preserves across the wire. This set MUST stay in
 * lock-step with the `ErrorCode` union above: a union member missing here is
 * silently rewritten to `HANDLER_ERROR` on the wire, which erases exactly the
 * distinction the receiver's error mapping branches on (POO-108 review fix
 * round B9 — the previously missing LocalApp members are the live example).
 * Domain unions (`LocalAppErrorCode`,
 * `PcErrorCode`) are spread in so the two can never drift apart again.
 */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  'HANDLER_ERROR',
  'CHANNEL_NOT_FOUND',
  'AUTH_FAILED',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'SESSION_NOT_IDLE',
  'SESSION_ID_CONFLICT',
  // POO-205 C5 (X2): the session's on-disk content exists but failed to
  // load; sends are refused rather than risking an empty-history overwrite.
  'SESSION_CONTENT_UNAVAILABLE',
  'ARTIFACT_NOT_PORTABLE',
  'TRANSFER_TOO_LARGE',
  'TRANSFER_TIMEOUT',
  'TRANSFER_VERIFICATION_FAILED',
  'REQUEST_TIMEOUT',
  'CAPABILITY_UNAVAILABLE',
  'CLIENT_DISCONNECTED',
  'CLIENT_REQUEST_TIMEOUT',
  'BROWSER_NO_CAPABLE_CLIENT',
  'BROWSER_INSTANCE_NOT_OWNED',
  'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
  'BROWSER_REMOTE_EVALUATE_BLOCKED',
  // LocalAppErrorCode, spelled out for the pre-union members the set carried
  // before it; the union-only members follow via the spread below.
  ...LOCAL_APP_ERROR_CODES,
  // PcErrorCode (POO-196): the project-context channels carry these pc_* codes
  // to the renderer; without the spread the transport would rewrite them all
  // to HANDLER_ERROR.
  ...PC_ERROR_CODES,
  // PcLocalErrorCode (POO-196): raised client-side at the workspace scope
  // gate, so it never rides the admin wire — but the transport still must not
  // rewrite it to HANDLER_ERROR or the renderer's recovery copy loses the
  // "enterprise project required" distinction.
  ...PC_LOCAL_ERROR_CODES,
  // ClientEnterpriseErrorCode (POO-196 追加轮): the project-members channels
  // surface the generated contract's stable codes (phone_verification_required,
  // account_enterprise_exists, target_already_member, …). The admin client's
  // alias table still normalizes seven of them to legacy uppercase spellings
  // and server-core maps those back — both spellings must survive the
  // transport, or the renderer's recovery copy collapses to a generic failure.
  ...CLIENT_ENTERPRISE_ERROR_CODES,
  // PmLocalErrorCode (POO-196 追加轮): raised at the trusted side's own gate
  // (personal space, signed out, scope moved mid-command) so the renderer can
  // tell "no project here" and "switching accounts" apart from a down service.
  ...PM_LOCAL_ERROR_CODES,
  // ProjectErrorCode (POO-205, poo205-contract-r1): the project & my-apps
  // channels answer with these prj_*/myapps_* codes; without the spread the
  // transport rewrites every one of them to HANDLER_ERROR and the renderer's
  // per-code recovery copy (prj_last_owner, prj_member_not_in_organization…)
  // can never branch.
  ...PROJECT_ERROR_CODES,
  // SessionProjectErrorCode (POO-205 C6): the session layer raises these at
  // its own project-binding gate (create/branch/import). Without the spread
  // the transport rewrites every one of them to HANDLER_ERROR and the
  // renderer's per-code recovery copy (project required in enterprise,
  // project rejected in personal, branch across projects) can never branch.
  ...SESSION_PROJECT_ERROR_CODES,
])

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value)
}

/**
 * Sender-side helper for throwing transport errors with a typed `code`.
 *
 * Class identity is lost across the wire — the transport reconstructs a plain
 * `Error` with `.code` on the receiving side. Receivers MUST branch on
 * `err.code === 'X'`, never `err instanceof CodedError`.
 */
export class CodedError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'CodedError'
  }
}

// ---------------------------------------------------------------------------
// Push target (server → clients)
// ---------------------------------------------------------------------------

export type PushTarget =
  | { to: 'all'; exclude?: string }
  | { to: 'workspace'; workspaceId: string; exclude?: string }
  | { to: 'client'; clientId: string }

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = '1.0'

/** Heartbeat interval in ms. Server pings every 30s. */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** Client that misses this many pongs gets terminated. */
export const HEARTBEAT_MAX_MISSED = 2

/** Default request timeout in ms. */
export const REQUEST_TIMEOUT_MS = 30_000
export const LONG_RUNNING_REQUEST_TIMEOUT_MS = LOCAL_APP_INSTALL_RPC_TIMEOUT_MS

/** Runtime installation may include a large download and dependency preparation. */
export function getRpcRequestTimeoutMs(channel: string, defaultTimeoutMs: number): number {
  return channel === 'local-apps:install'
    ? Math.max(defaultTimeoutMs, LONG_RUNNING_REQUEST_TIMEOUT_MS)
    : defaultTimeoutMs
}

// -- Reliable delivery constants --

/** Max events to retain per client in the ring buffer. */
export const EVENT_BUFFER_MAX_SIZE = 500

/** Events older than this are evicted from the buffer. */
export const EVENT_BUFFER_TTL_MS = 30_000

/** How long to retain a disconnected client's buffer for potential reconnect. */
export const DISCONNECTED_CLIENT_TTL_MS = 60_000

/** Client sends a sequence_ack every N ms. */
export const SEQUENCE_ACK_INTERVAL_MS = 5_000
