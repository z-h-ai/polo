import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicApi } from './app.ts';
import type { OAuthRelayState, ShareAuditEvent, ShareRepository, SharedSession } from './types.ts';

class MemoryShareRepository implements ShareRepository {
  readonly sessions = new Map<string, SharedSession>();
  readonly oauthStates = new Map<string, OAuthRelayState>();
  readonly audit: ShareAuditEvent[] = [];
  purgeCalls = 0;

  async initialize(): Promise<void> {}

  async create(session: SharedSession, audit: ShareAuditEvent): Promise<void> {
    this.sessions.set(session.id, session);
    this.audit.push(audit);
  }

  async getActive(id: string): Promise<SharedSession | null> {
    const session = this.sessions.get(id);
    return session && session.expiresAt > new Date() ? session : null;
  }

  async update(id: string, payload: unknown, audit: ShareAuditEvent): Promise<boolean> {
    const session = await this.getActive(id);
    if (!session) return false;
    session.payload = payload;
    this.audit.push(audit);
    return true;
  }

  async delete(id: string, audit: ShareAuditEvent): Promise<boolean> {
    const removed = this.sessions.delete(id);
    if (removed) this.audit.push(audit);
    return removed;
  }

  async createOAuthRelayState(state: OAuthRelayState): Promise<void> {
    this.oauthStates.set(state.id, state);
  }

  async consumeOAuthRelayState(id: string, tokenHash: string): Promise<OAuthRelayState | null> {
    const state = this.oauthStates.get(id);
    if (!state || state.tokenHash !== tokenHash || state.expiresAt <= new Date()) return null;
    this.oauthStates.delete(id);
    return state;
  }

  async purgeExpired(): Promise<void> {
    this.purgeCalls += 1;
    const now = new Date();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
    for (const [id, state] of this.oauthStates) {
      if (state.expiresAt <= now) this.oauthStates.delete(id);
    }
  }
}

async function relayState(app: ReturnType<typeof createPublicApi>, returnTo: string, innerState = 'original-state'): Promise<string> {
  const response = await app.fetch(new Request('https://app.example.test/auth/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ returnTo, innerState }),
  }));
  expect(response.status).toBe(201);
  return (await response.json() as { state: string }).state;
}

function createTestApi(repository = new MemoryShareRepository()) {
  return {
    repository,
    app: createPublicApi({
      repository,
      allowedCallbacks: new Set(['https://webui.example.test/api/oauth/callback']),
      allowLoopbackCallbacks: true,
      writeRateLimit: 100,
    }),
  };
}

describe('public sharing API', () => {
  it('creates public shares and requires the write token for updates and deletion', async () => {
    const { app, repository } = createTestApi();
    const created = await app.fetch(new Request('https://app.example.test/s/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'session-1', name: 'A session' }),
    }));
    expect(created.status).toBe(201);
    expect(repository.purgeCalls).toBe(1);
    const data = await created.json() as { id: string; url: string; writeToken: string };
    expect(data.url).toBe(`https://app.example.test/s/${data.id}`);
    expect(data.writeToken.length).toBeGreaterThan(32);

    const readable = await app.fetch(new Request(`https://app.example.test/s/api/${data.id}`));
    expect(readable.status).toBe(200);
    expect(await readable.json()).toEqual({ id: 'session-1', name: 'A session' });

    const deniedUpdate = await app.fetch(new Request(`https://app.example.test/s/api/${data.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'changed' }),
    }));
    expect(deniedUpdate.status).toBe(401);

    const updated = await app.fetch(new Request(`https://app.example.test/s/api/${data.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-polo-share-token': data.writeToken },
      body: JSON.stringify({ id: 'session-1', name: 'changed' }),
    }));
    expect(updated.status).toBe(204);

    const deniedDelete = await app.fetch(new Request(`https://app.example.test/s/api/${data.id}`, { method: 'DELETE' }));
    expect(deniedDelete.status).toBe(401);
    const deleted = await app.fetch(new Request(`https://app.example.test/s/api/${data.id}`, {
      method: 'DELETE', headers: { 'x-polo-share-token': data.writeToken },
    }));
    expect(deleted.status).toBe(204);
    expect((await app.fetch(new Request(`https://app.example.test/s/api/${data.id}`))).status).toBe(404);
  });

  it('rejects malformed and oversized payloads', async () => {
    const { app } = createTestApi();
    const invalid = await app.fetch(new Request('https://app.example.test/s/api', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    }));
    expect(invalid.status).toBe(400);

    const oversized = await app.fetch(new Request('https://app.example.test/s/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(11 * 1024 * 1024) },
      body: '{}',
    }));
    expect(oversized.status).toBe(413);
  });

  it('serves the API before Viewer assets and the Viewer SPA fallback', async () => {
    const viewerDir = await mkdtemp(join(tmpdir(), 'polo-viewer-'));
    await mkdir(join(viewerDir, 'assets'));
    await writeFile(join(viewerDir, 'index.html'), '<html>viewer</html>');
    await writeFile(join(viewerDir, 'assets', 'app.js'), 'console.log("asset")');
    try {
      const repository = new MemoryShareRepository();
      const app = createPublicApi({
        repository,
        allowedCallbacks: new Set(),
        allowLoopbackCallbacks: false,
        viewerDistDir: viewerDir,
      });
      const created = await app.fetch(new Request('https://app.example.test/s/api', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'session' }),
      }));
      const { id } = await created.json() as { id: string };
      expect(await (await app.fetch(new Request(`https://app.example.test/s/api/${id}`))).json()).toEqual({ id: 'session' });
      expect(await (await app.fetch(new Request('https://app.example.test/s/assets/app.js'))).text()).toBe('console.log("asset")');
      expect(await (await app.fetch(new Request(`https://app.example.test/s/${id}`))).text()).toBe('<html>viewer</html>');
    } finally {
      await rm(viewerDir, { recursive: true, force: true });
    }
  });
});

describe('OAuth relays', () => {
  it('only redirects to registered callbacks and preserves success and denial results', async () => {
    const { app } = createTestApi();
    const state = await relayState(app, 'https://webui.example.test/api/oauth/callback?existing=value', 'inner-state');
    const response = await app.fetch(new Request(`https://app.example.test/auth/callback?code=grant&state=${encodeURIComponent(state)}`));
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get('location')!);
    expect(target.origin + target.pathname).toBe('https://webui.example.test/api/oauth/callback');
    expect(target.searchParams.get('code')).toBe('grant');
    expect(target.searchParams.get('state')).toBe('inner-state');

    const deniedState = await relayState(app, 'https://webui.example.test/api/oauth/callback', 'inner-state');
    const denied = await app.fetch(new Request(`https://app.example.test/auth/callback?error=access_denied&state=${encodeURIComponent(deniedState)}`));
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');

    const rejected = await app.fetch(new Request('https://app.example.test/auth/state', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: 'https://attacker.example.test/callback', innerState: 'state' }),
    }));
    expect(rejected.status).toBe(400);

    const stateToTamper = await relayState(app, 'https://webui.example.test/api/oauth/callback', 'inner-state');
    const tampered = `${stateToTamper.slice(0, -1)}${stateToTamper.endsWith('a') ? 'b' : 'a'}`;
    const tamperedResponse = await app.fetch(new Request(`https://app.example.test/auth/callback?code=grant&state=${encodeURIComponent(tampered)}`));
    expect(tamperedResponse.status).toBe(400);
  });

  it('only permits valid Slack loopback ports', async () => {
    const { app } = createTestApi();
    const valid = await app.fetch(new Request('https://app.example.test/auth/slack/callback?port=6477&code=grant&state=state'));
    expect(valid.status).toBe(302);
    expect(valid.headers.get('location')).toBe('http://127.0.0.1:6477/callback?code=grant&state=state');
    const invalid = await app.fetch(new Request('https://app.example.test/auth/slack/callback?port=80&code=grant'));
    expect(invalid.status).toBe(400);
  });
});
