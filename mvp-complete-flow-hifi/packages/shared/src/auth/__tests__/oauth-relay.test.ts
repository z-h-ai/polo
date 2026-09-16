import { describe, expect, it, mock } from 'bun:test';

import {
  OAUTH_RELAY_CALLBACK_URL,
  OAUTH_RELAY_STATE_URL,
  isOAuthRelayState,
  wrapPreparedOAuthFlowForRelay,
} from '../oauth-relay.ts';
import type { PreparedOAuthFlow } from '../oauth-flow-types.ts';

const RELAY_STATE = 'ca2.abcdefghijklmnopqrstuvwx.abcdefghijklmnopqrstuvwxyz123456';

describe('wrapPreparedOAuthFlowForRelay', () => {
  it('uses a server-minted opaque state and the stable redirect URI', async () => {
    let stateRequest: Record<string, string> | null = null;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === OAUTH_RELAY_STATE_URL) {
        stateRequest = JSON.parse(String(init?.body));
        return Response.json({ state: RELAY_STATE }, { status: 201 });
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const prepared: PreparedOAuthFlow = {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client&redirect_uri=https%3A%2F%2Fold.example%2Fcallback&response_type=code&state=inner-state-123',
      state: 'inner-state-123',
      codeVerifier: 'verifier',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      redirectUri: 'https://old.example/callback',
      provider: 'google',
    };

    const wrapped = await wrapPreparedOAuthFlowForRelay(
      prepared,
      'https://ghalmos.craftdocs-cf-t1.com/api/oauth/callback',
    );

    expect(stateRequest!).toEqual({
      returnTo: 'https://ghalmos.craftdocs-cf-t1.com/api/oauth/callback',
      innerState: 'inner-state-123',
    });
    expect(wrapped.state).toBe('inner-state-123');
    expect(wrapped.redirectUri).toBe(OAUTH_RELAY_CALLBACK_URL);

    const authUrl = new URL(wrapped.authUrl);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(OAUTH_RELAY_CALLBACK_URL);
    expect(authUrl.searchParams.get('state')).toBe(RELAY_STATE);
    expect(isOAuthRelayState(RELAY_STATE)).toBe(true);
    expect(isOAuthRelayState('ca1.untrusted')).toBe(false);
  });
});
