import type { ShareAuditEvent, ShareRepository, SharedSession } from './types.ts';

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS shared_sessions (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  write_token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shared_sessions_expiry_idx ON shared_sessions (expires_at);
CREATE TABLE IF NOT EXISTS share_audit_log (
  id BIGSERIAL PRIMARY KEY,
  share_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  remote_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS share_audit_log_share_id_idx ON share_audit_log (share_id, created_at DESC);
CREATE TABLE IF NOT EXISTS oauth_relay_states (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  return_to TEXT NOT NULL,
  inner_state TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS oauth_relay_states_expiry_idx ON oauth_relay_states (expires_at);
`;

type SqlClient = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>>;
  unsafe(query: string): Promise<unknown>;
};

export class PostgresShareRepository implements ShareRepository {
  constructor(private readonly sql: SqlClient) {}

  async initialize(): Promise<void> {
    await this.sql.unsafe(CREATE_SCHEMA);
  }

  async create(session: SharedSession, audit: ShareAuditEvent): Promise<void> {
    await this.sql`INSERT INTO shared_sessions (id, payload, write_token_hash, expires_at)
      VALUES (${session.id}, ${JSON.stringify(session.payload)}::jsonb, ${session.writeTokenHash}, ${session.expiresAt})`;
    await this.writeAudit(audit);
  }

  async getActive(id: string): Promise<SharedSession | null> {
    const rows = await this.sql`SELECT id, payload, write_token_hash, expires_at
      FROM shared_sessions WHERE id = ${id} AND expires_at > NOW()`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      // Bun's PostgreSQL driver returns JSONB columns as JSON strings.
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      writeTokenHash: String(row.write_token_hash),
      expiresAt: new Date(String(row.expires_at)),
    };
  }

  async update(id: string, payload: unknown, audit: ShareAuditEvent): Promise<boolean> {
    const rows = await this.sql`UPDATE shared_sessions SET payload = ${JSON.stringify(payload)}::jsonb, updated_at = NOW()
      WHERE id = ${id} AND expires_at > NOW() RETURNING id`;
    if (rows.length === 0) return false;
    await this.writeAudit(audit);
    return true;
  }

  async delete(id: string, audit: ShareAuditEvent): Promise<boolean> {
    const rows = await this.sql`DELETE FROM shared_sessions WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) return false;
    await this.writeAudit(audit);
    return true;
  }

  async createOAuthRelayState(state: import('./types.ts').OAuthRelayState): Promise<void> {
    await this.sql`INSERT INTO oauth_relay_states (id, token_hash, return_to, inner_state, expires_at)
      VALUES (${state.id}, ${state.tokenHash}, ${state.returnTo}, ${state.innerState}, ${state.expiresAt})`;
  }

  async consumeOAuthRelayState(id: string, tokenHash: string): Promise<import('./types.ts').OAuthRelayState | null> {
    const rows = await this.sql`DELETE FROM oauth_relay_states
      WHERE id = ${id} AND token_hash = ${tokenHash} AND expires_at > NOW()
      RETURNING id, token_hash, return_to, inner_state, expires_at`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      tokenHash: String(row.token_hash),
      returnTo: String(row.return_to),
      innerState: String(row.inner_state),
      expiresAt: new Date(String(row.expires_at)),
    };
  }

  async purgeExpired(): Promise<void> {
    await this.sql`DELETE FROM oauth_relay_states WHERE expires_at <= NOW()`;
    await this.sql`DELETE FROM shared_sessions WHERE expires_at <= NOW()`;
  }

  private async writeAudit(audit: ShareAuditEvent): Promise<void> {
    await this.sql`INSERT INTO share_audit_log (share_id, action, remote_address)
      VALUES (${audit.shareId}, ${audit.action}, ${audit.remoteAddress})`;
  }
}
