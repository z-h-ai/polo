// POL-244 unit tests for the root auth guard decision (bun test).
//
// Covers the AuthGate route matrix (hydration hold, authenticated bounce off
// /login to the tabs root, signed-out redirect) and its integration with the
// session store across a signOut: status flips -> guard target becomes
// /login and the persisted credentials are gone.

import { describe, expect, test } from 'bun:test';

import { authRouteTarget, LOGIN_ROUTE, TABS_ROOT_ROUTE } from '../authRoute';
import { createSessionStore } from '../session';
import { createTokenStore, createMemoryStorage } from '../tokenStore';
import type { AuthApi } from '../../api/auth';

function makeStore() {
  const tokens = createTokenStore({ storage: createMemoryStorage() });
  const api = {
    async logout() {},
  } as unknown as AuthApi;
  const store = createSessionStore({ tokens, api });
  return { tokens, store };
}

describe('authRouteTarget', () => {
  test('holds navigation while the session read has not settled', () => {
    expect(
      authRouteTarget({ hydrated: false, status: 'authenticated', pathname: '/' }),
    ).toBeNull();
    expect(
      authRouteTarget({ hydrated: false, status: 'unauthenticated', pathname: '/login' }),
    ).toBeNull();
  });

  test('authenticated users bounced off /login land on the tabs root', () => {
    expect(
      authRouteTarget({ hydrated: true, status: 'authenticated', pathname: LOGIN_ROUTE }),
    ).toBe(TABS_ROOT_ROUTE);
  });

  test('authenticated users elsewhere stay put', () => {
    expect(
      authRouteTarget({ hydrated: true, status: 'authenticated', pathname: '/scan-qr' }),
    ).toBeNull();
    expect(
      authRouteTarget({ hydrated: true, status: 'authenticated', pathname: '/(tabs)' }),
    ).toBeNull();
  });

  test('signed-out users on any non-login route are sent to /login', () => {
    expect(
      authRouteTarget({ hydrated: true, status: 'unauthenticated', pathname: TABS_ROOT_ROUTE }),
    ).toBe(LOGIN_ROUTE);
    expect(
      authRouteTarget({ hydrated: true, status: 'authenticating', pathname: '/scan-qr' }),
    ).toBe(LOGIN_ROUTE);
  });

  test('signed-out users on /login stay put', () => {
    expect(
      authRouteTarget({ hydrated: true, status: 'unauthenticated', pathname: LOGIN_ROUTE }),
    ).toBeNull();
  });
});

describe('authRouteTarget + session store integration', () => {
  test('after signOut the guard redirects the tabs back to /login and tokens are cleared', async () => {
    const { tokens, store } = makeStore();
    await tokens.save({
      accessToken: 'at1',
      refreshToken: 'rt1',
      user: { id: 'u1', phone: '13800008000' },
    });
    await store.getState().restore();
    expect(store.getState().status).toBe('authenticated');
    // Guard keeps the user on the tabs while authenticated.
    expect(
      authRouteTarget({ hydrated: true, status: store.getState().status, pathname: '/(tabs)' }),
    ).toBeNull();

    await store.getState().signOut();

    expect(
      authRouteTarget({ hydrated: true, status: store.getState().status, pathname: '/(tabs)' }),
    ).toBe(LOGIN_ROUTE);
    expect(await tokens.load()).toBeNull();
    expect(store.getState().token).toBeNull();
  });
});
