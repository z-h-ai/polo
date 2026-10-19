// POL-239 unit tests for the auth/session layer (bun test).
//
// Covers: tokenStore fallback behavior (memory backend, corrupt/missing
// reads treated as signed out, throwing storage surviving in-memory),
// countdown state transitions (send success baseline, server rate-limit
// override, expiry), verify success/failure flows and signOut.

import { describe, expect, test } from 'bun:test';

import { ApiError } from '../../api/client';
import type {
  AuthApi,
  ChallengeRequirement,
  SendCodeResult,
  VerifyCodeResult,
} from '../../api/auth';
import {
  authErrorCopy,
  createSessionStore,
  formatPhone,
} from '../session';
import {
  createMemoryStorage,
  createTokenStore,
  resolveDefaultStorage,
  type KeyValueStorage,
  type StoredTokens,
} from '../tokenStore';

const USER: StoredTokens['user'] = { id: 'u1', phone: '13800008000' };
const TOKENS: StoredTokens = {
  accessToken: 'at1',
  refreshToken: 'rt1',
  user: USER,
};

function makeClock() {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    advanceMs: (ms: number) => {
      t += ms;
    },
    advanceSec: (sec: number) => {
      t += sec * 1000;
    },
  };
}

interface FakeAuthApi extends AuthApi {
  challengeConfigCalls: number;
  sendCodeCalls: Array<{ phone: string; challengeToken?: string }>;
  verifyCalls: Array<{ phone: string; code: string }>;
  logoutCalls: number;
  nextChallengeConfig: () => ChallengeRequirement | Promise<ChallengeRequirement>;
  nextSendCode: (phone: string) => SendCodeResult | Promise<SendCodeResult>;
  nextVerify: (phone: string, code: string) => VerifyCodeResult | Promise<VerifyCodeResult>;
}

function makeFakeApi(): FakeAuthApi {
  const api: FakeAuthApi = {
    challengeConfigCalls: 0,
    sendCodeCalls: [],
    verifyCalls: [],
    logoutCalls: 0,
    // Default admin deployment: no human challenge demanded of the client.
    nextChallengeConfig: () => ({ type: '', issuerUrl: '' }),
    nextSendCode: () => ({ accepted: true, expiresInSec: 300, resendAfterSec: 60 }),
    nextVerify: () => ({
      accessToken: 'at2',
      refreshToken: 'rt2',
      user: USER,
      isNewUser: false,
    }),
    async challengeConfig() {
      api.challengeConfigCalls += 1;
      return api.nextChallengeConfig();
    },
    async sendCode(phone, challengeToken) {
      api.sendCodeCalls.push({ phone, challengeToken });
      return api.nextSendCode(phone);
    },
    async verifyCode(phone, code) {
      api.verifyCalls.push({ phone, code });
      return api.nextVerify(phone, code);
    },
    async logout() {
      api.logoutCalls += 1;
    },
  };
  return api;
}

async function makeHarness(initial?: StoredTokens) {
  const clock = makeClock();
  const tokens = createTokenStore({ storage: createMemoryStorage() });
  if (initial) await tokens.save(initial);
  const api = makeFakeApi();
  const useStore = createSessionStore({ tokens, api, now: clock.now });
  return { clock, tokens, api, store: useStore };
}

describe('formatPhone', () => {
  test('formats 11 digits as 3-4-4 for the P01 toast', () => {
    expect(formatPhone('13800008000')).toBe('138 0000 8000');
  });

  test('leaves malformed input untouched', () => {
    expect(formatPhone('13800')).toBe('13800');
  });
});

describe('tokenStore fallback logic', () => {
  test('save updates the in-memory cache synchronously', async () => {
    const tokens = createTokenStore({ storage: createMemoryStorage() });
    expect(tokens.getCached()).toBeNull();
    await tokens.save(TOKENS);
    expect(tokens.getCached()?.accessToken).toBe('at1'); // sync read, non-React layers
    expect(await tokens.load()).toEqual(TOKENS);
  });

  test('corrupt or missing user summary reads as signed out', async () => {
    const storage = createMemoryStorage();
    await storage.setItem('polo.accessToken', 'at1');
    await storage.setItem('polo.refreshToken', 'rt1');
    await storage.setItem('polo.user', '{not-json');
    const tokens = createTokenStore({ storage });
    expect(await tokens.load()).toBeNull();
    expect(tokens.getCached()).toBeNull();
  });

  test('throwing storage degrades to cache-only session instead of crashing', async () => {
    const failing: KeyValueStorage = {
      getItem: async () => {
        throw new Error('keychain unavailable');
      },
      setItem: async () => {
        throw new Error('keychain unavailable');
      },
      deleteItem: async () => {
        throw new Error('keychain unavailable');
      },
    };
    const tokens = createTokenStore({ storage: failing });
    expect(await tokens.load()).toBeNull(); // read failure -> not signed in
    await tokens.save(TOKENS); // persist fails but must not throw
    expect(tokens.getCached()?.accessToken).toBe('at1'); // session stays alive in memory
    await expect(tokens.clear()).resolves.toBeUndefined();
    expect(tokens.getCached()).toBeNull();
  });

  test('clear empties cache and storage', async () => {
    const storage = createMemoryStorage();
    const tokens = createTokenStore({ storage });
    await tokens.save(TOKENS);
    await tokens.clear();
    expect(tokens.getCached()).toBeNull();
    expect(await storage.getItem('polo.accessToken')).toBeNull();
  });

  test('resolveDefaultStorage never picks a plaintext persistence in plain node', () => {
    const resolved = resolveDefaultStorage();
    // In bun test (no React Native runtime) SecureStore must not be loaded:
    // the safe fallback is the session-scoped memory backend.
    expect(resolved.backend).toBe('memory');
  });
});

describe('session countdown', () => {
  test('send success starts the local-clock cooldown and sets the P01 toast', async () => {
    const { store, api } = await makeHarness();
    await store.getState().sendCode('13800008000');

    expect(api.sendCodeCalls).toEqual([{ phone: '13800008000', challengeToken: undefined }]);
    const state = store.getState();
    expect(state.toast).toBe('验证码已发送至 138 0000 8000，5 分钟内有效');
    expect(state.error).toBeNull();
    expect(state.countdown?.kind).toBe('cooldown');
    expect(state.countdown?.durationSec).toBe(60);
    expect(state.remainingSec).toBe(60);
  });

  test('tick decrements from the local clock and expiry re-enables resend', async () => {
    const { store, clock } = await makeHarness();
    await store.getState().sendCode('13800008000');

    clock.advanceSec(17);
    store.getState().tick();
    expect(store.getState().remainingSec).toBe(43); // prototype: 43s 倒计时

    clock.advanceSec(43);
    store.getState().tick();
    const state = store.getState();
    expect(state.countdown).toBeNull();
    expect(state.remainingSec).toBe(0); // 到期可重发
  });

  test('rate limit overrides the running countdown with the server wait seconds', async () => {
    const { store, api, clock } = await makeHarness();
    await store.getState().sendCode('13800008000'); // cooldown 60s running

    api.nextSendCode = () => {
      throw new ApiError({
        status: 429,
        errorCode: 'sms_rate_limited',
        retryAfterSeconds: 58,
      });
    };
    clock.advanceSec(5);
    await store.getState().sendCode('13800008000');

    const state = store.getState();
    expect(state.error).toBe('短信发送过于频繁，请稍后再试。');
    expect(state.errorCode).toBe('sms_rate_limited');
    expect(state.countdown?.kind).toBe('rate_limited');
    expect(state.countdown?.durationSec).toBe(58); // 服务端等待秒数覆盖本地计时
    expect(state.remainingSec).toBe(58);
  });

  test('rate limit without retryAfter falls back to the default wait', async () => {
    const { store, api } = await makeHarness();
    api.nextSendCode = () => {
      throw new ApiError({ status: 429, errorCode: 'sms_rate_limited' });
    };
    await store.getState().sendCode('13800008000');
    expect(store.getState().countdown?.durationSec).toBe(60);
  });

  test('admin human-challenge requirement passes through and send-code is not attempted', async () => {
    const { store, api } = await makeHarness();
    api.nextChallengeConfig = () => ({ type: 'browser_redirect', issuerUrl: 'https://challenge.test' });

    await store.getState().sendCode('13800008000');

    // challengeToken 是 admin 必填字段；无凭据时要求原样浮出，绝不伪装成
    // invalid_phone，也不该真正发出 send-code。
    expect(api.challengeConfigCalls).toBe(1);
    expect(api.sendCodeCalls).toEqual([]);
    const state = store.getState();
    expect(state.errorCode).toBe('browser_redirect');
    expect(state.error).toBe('需要在浏览器中完成安全验证后再试。');
    expect(state.toast).toBeNull();
    expect(state.countdown).toBeNull();
  });

  test('challenge config endpoint errors pass through (phone_auth_disabled)', async () => {
    const { store, api } = await makeHarness();
    api.nextChallengeConfig = () => {
      throw new ApiError({ status: 403, errorCode: 'phone_auth_disabled' });
    };

    await store.getState().sendCode('13800008000');

    expect(api.challengeConfigCalls).toBe(1);
    expect(api.sendCodeCalls).toEqual([]);
    expect(store.getState().errorCode).toBe('phone_auth_disabled');
    expect(store.getState().error).toBe('手机号登录暂不可用，请联系管理员。');
  });

  test('provided challenge tokens skip the config probe and ride send-code', async () => {
    const { store, api } = await makeHarness();
    await store.getState().sendCode('13800008000', 'verified-challenge');

    expect(api.challengeConfigCalls).toBe(0);
    expect(api.sendCodeCalls).toEqual([{ phone: '13800008000', challengeToken: 'verified-challenge' }]);
    expect(store.getState().toast).not.toBeNull();
  });
});

describe('session login flow', () => {
  test('verify success saves rotated tokens and flips to authenticated', async () => {
    const { store, tokens, api } = await makeHarness();
    await store.getState().sendCode('13800008000');

    const ok = await store.getState().verify('13800008000', '826419');

    expect(ok).toBe(true);
    expect(api.verifyCalls).toEqual([{ phone: '13800008000', code: '826419' }]);
    const state = store.getState();
    expect(state.status).toBe('authenticated');
    expect(state.token).toBe('at2');
    expect(state.user?.phone).toBe('13800008000');
    expect(state.isNewUser).toBe(false);
    expect(state.countdown).toBeNull(); // login closes the countdown
    expect(state.toast).toBeNull();
    expect(tokens.getCached()?.refreshToken).toBe('rt2');
  });

  test('verify failure surfaces the P01 copy with remaining attempts', async () => {
    const { store, api, tokens } = await makeHarness();
    api.nextVerify = () => {
      throw new ApiError({
        status: 400,
        errorCode: 'verification_code_invalid',
        attemptsRemaining: 4,
      });
    };

    const ok = await store.getState().verify('13800008000', '826410');

    expect(ok).toBe(false);
    const state = store.getState();
    expect(state.status).toBe('unauthenticated');
    expect(state.error).toBe('验证码错误，请重新输入（剩余尝试 4 次，连续失败将锁定 10 分钟）。');
    expect(state.token).toBeNull();
    expect(tokens.getCached()).toBeNull(); // nothing persisted on failure
  });

  test('restore hydrates a stored session; missing storage means signed out', async () => {
    const seeded = await makeHarness(TOKENS);
    await seeded.store.getState().restore();
    expect(seeded.store.getState().status).toBe('authenticated');
    expect(seeded.store.getState().hydrated).toBe(true);

    const fresh = await makeHarness();
    await fresh.store.getState().restore();
    expect(fresh.store.getState().status).toBe('unauthenticated');
    expect(fresh.store.getState().hydrated).toBe(true);
  });

  test('signOut calls the endpoint, clears credentials and resets state', async () => {
    const { store, api, tokens } = await makeHarness(TOKENS);
    await store.getState().restore();
    expect(store.getState().status).toBe('authenticated');

    await store.getState().signOut();

    expect(api.logoutCalls).toBe(1);
    expect(tokens.getCached()).toBeNull();
    const state = store.getState();
    expect(state.status).toBe('unauthenticated');
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
  });

  test('signOut clears even when the endpoint fails', async () => {
    const { store, api, tokens } = await makeHarness(TOKENS);
    await store.getState().restore();
    api.logout = async () => {
      throw new ApiError({ status: 500, errorCode: 'SERVER_ERROR' });
    };

    await store.getState().signOut();

    expect(store.getState().status).toBe('unauthenticated');
    expect(tokens.getCached()).toBeNull();
  });

  test('handleAuthExpired drops credentials and flags the session expired', async () => {
    const { store } = await makeHarness(TOKENS);
    store.getState().handleAuthExpired();
    const state = store.getState();
    expect(state.status).toBe('unauthenticated');
    expect(state.error).toBe('登录已过期，请重新登录。');
  });
});

describe('authErrorCopy mapping', () => {
  test('maps known admin codes to P01 copy', () => {
    expect(
      authErrorCopy(new ApiError({ status: 429, errorCode: 'sms_rate_limited' })).message,
    ).toBe('短信发送过于频繁，请稍后再试。');
    expect(
      authErrorCopy(new ApiError({ status: 400, errorCode: 'verification_code_expired' })).message,
    ).toBe('验证码已过期，请重新获取。');
    expect(
      authErrorCopy(new ApiError({ status: 400, errorCode: 'verification_attempts_exceeded' })).message,
    ).toContain('已锁定');
  });

  test('maps challenge and account-state codes admin actually returns', () => {
    expect(
      authErrorCopy(new ApiError({ status: 401, errorCode: 'invalid_credentials' })).message,
    ).toBe('安全验证未通过，请稍后再试。');
    expect(
      authErrorCopy(new ApiError({ status: 403, errorCode: 'account_disabled' })).message,
    ).toContain('禁用');
    expect(
      authErrorCopy(new ApiError({ status: 423, errorCode: 'account_locked' })).message,
    ).toContain('锁定');
    expect(
      authErrorCopy(new ApiError({ status: 500, errorCode: 'internal_error' })).message,
    ).toBe('网络异常，请稍后再试。');
  });

  test('passes unknown codes through untranslated', () => {
    const mapped = authErrorCopy(
      new ApiError({ status: 400, errorCode: 'captcha_required' }),
    );
    expect(mapped.code).toBe('captcha_required');
    expect(mapped.message).toContain('captcha_required');
  });
});
