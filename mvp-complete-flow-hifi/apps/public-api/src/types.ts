export interface SharedSession {
  id: string;
  payload: unknown;
  writeTokenHash: string;
  expiresAt: Date;
}

export interface ShareAuditEvent {
  shareId: string;
  action: 'create' | 'update' | 'delete';
  remoteAddress: string | null;
}

export interface OAuthRelayState {
  id: string;
  tokenHash: string;
  returnTo: string;
  innerState: string;
  expiresAt: Date;
}

export interface ShareRepository {
  initialize(): Promise<void>;
  create(session: SharedSession, audit: ShareAuditEvent): Promise<void>;
  getActive(id: string): Promise<SharedSession | null>;
  update(id: string, payload: unknown, audit: ShareAuditEvent): Promise<boolean>;
  delete(id: string, audit: ShareAuditEvent): Promise<boolean>;
  createOAuthRelayState(state: OAuthRelayState): Promise<void>;
  consumeOAuthRelayState(id: string, tokenHash: string): Promise<OAuthRelayState | null>;
  purgeExpired(): Promise<void>;
}
