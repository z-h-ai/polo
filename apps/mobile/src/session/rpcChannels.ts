// Session RPC channel names (POL-243).
//
// Mirror of packages/shared/src/protocol/channels.ts values actually used by
// the phone session layer (values are the stable wire contract — handler
// references: packages/server-core/src/handlers/rpc/sessions.ts:189 CREATE,
// :214 SEND_MESSAGE; events pushed on sessions.EVENT per dto.ts SessionEvent).
//
// Runtime fidelity follows the repo convention (see types/shared-protocol.d.ts
// header and src/conn/relayChannel.ts): Metro bundles the REAL shared source,
// while bun test maps the specifier to the type-only shim — so the literal
// mirror is the fallback and the real RPC_CHANNELS the preferred source.

type ChannelsModule = {
  RPC_CHANNELS?: {
    sessions?: Record<string, string>;
    server?: Record<string, string>;
  };
};

function realChannels(): ChannelsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@polo-ai/shared/protocol') as ChannelsModule;
  } catch {
    return null;
  }
}

function pick(namespace: 'sessions' | 'server', key: string, literal: string): string {
  const mod = realChannels();
  const value = mod?.RPC_CHANNELS?.[namespace]?.[key];
  return typeof value === 'string' && value ? value : literal;
}

/** sessions namespace — create / send / event push + workspace bootstrap. */
export const SESSION_RPC = {
  /** sessions:create(workspaceId, options?) -> Session (phone reads .id). */
  CREATE: pick('sessions', 'CREATE', 'sessions:create'),
  /** sessions:sendMessage(sessionId, message, attachments?, stored?, options?) -> {accepted, messageId}. */
  SEND_MESSAGE: pick('sessions', 'SEND_MESSAGE', 'sessions:sendMessage'),
  /** Push channel for SessionEvent frames (protocol/events.ts BroadcastEventMap). */
  EVENT: pick('sessions', 'EVENT', 'session:event'),
  /** server:getWorkspaces() -> WorkspaceInfo[] — session bootstrap anchor. */
  GET_WORKSPACES: pick('server', 'GET_WORKSPACES', 'server:getWorkspaces'),
} as const;

/** Relay control receipt channels (mirror of src/conn/relayChannel.ts). */
export const RELAY_CONTROL = {
  peerDisconnected: 'relay:peerDisconnected',
  deliveryFailed: 'relay:deliveryFailed',
} as const;

/** Wire shape of the relay control receipts (packages/relay/src/envelope.ts). */
export interface PeerDisconnectedPayload {
  type: 'peer_disconnected';
  peer: string;
}

export type DeliveryFailureReason =
  | 'mac_offline'
  | 'phone_offline'
  | 'not_allowed'
  | 'access_check_failed'
  | 'queue_full';

export interface DeliveryFailedPayload {
  type: 'delivery_failed';
  reason: DeliveryFailureReason;
}
