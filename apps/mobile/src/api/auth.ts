// Auth endpoint functions (POL-239).
//
// Thin wrappers around the admin endpoints that POL-239 depends on. Error
// codes surface as ApiError verbatim — rate limits, remaining verification
// attempts, lockouts and human-challenge requirements are NOT translated or
// swallowed here; the UI layer maps codes to copy.

import { apiClient } from './client';
import type { ApiClient } from './client';
import type { StoredUser } from '../auth/tokenStore';

export interface SendCodeResult {
  accepted: boolean;
  /** Code validity in seconds (admin: 5 minutes). */
  expiresInSec: number;
  /** Cooldown before the next send in seconds (local countdown baseline). */
  resendAfterSec: number;
}

export interface VerifyCodeResult {
  accessToken: string;
  refreshToken: string;
  user: StoredUser;
  isNewUser: boolean;
}

/** Admin human-challenge requirement (GET /api/auth/phone/challenge/config). */
export interface ChallengeRequirement {
  /** e.g. 'browser_redirect'; empty when the body carries no type. */
  type: string;
  issuerUrl: string;
}

export interface AuthApi {
  /**
   * Reads the admin human-challenge requirement. Admin errors
   * (phone_auth_disabled, configuration errors) pass through as ApiError.
   * sendCode probes this before posting so a missing challenge token never
   * masquerades as an invalid phone; the challenge UI itself stays out of
   * scope (card 不做 section) — the requirement surfaces as an error.
   */
  challengeConfig(): Promise<ChallengeRequirement>;
  sendCode(phone: string, challengeToken?: string): Promise<SendCodeResult>;
  verifyCode(phone: string, code: string): Promise<VerifyCodeResult>;
  /**
   * Best-effort server-side logout. The Authorization header comes from the
   * token cache (still populated — callers clear the store after this
   * resolves or fails); network errors are swallowed by the session layer.
   */
  logout(): Promise<void>;
}

interface SendCodeWire {
  accepted?: unknown;
  expiresIn?: unknown;
  resendAfter?: unknown;
}

interface ChallengeConfigWire {
  type?: unknown;
  issuerUrl?: unknown;
}

interface VerifyWire {
  accessToken?: unknown;
  refreshToken?: unknown;
  isNewUser?: unknown;
  user?: {
    id?: unknown;
    username?: unknown;
    displayName?: unknown;
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Admin response is missing ${field}`);
  }
  return value;
}

export function createAuthApi(
  client: Pick<ApiClient, 'post' | 'request'> = apiClient,
): AuthApi {
  return {
    async challengeConfig() {
      // Admin route: src/app/api/auth/phone/challenge/config — 200
      // { type: 'browser_redirect', issuerUrl } or 403 phone_auth_disabled.
      const data = await client.request<ChallengeConfigWire>(
        '/api/auth/phone/challenge/config',
        { auth: false },
      );
      return {
        type: typeof data.type === 'string' ? data.type : '',
        issuerUrl: typeof data.issuerUrl === 'string' ? data.issuerUrl : '',
      };
    },

    async sendCode(phone, challengeToken) {
      // Auth-less endpoints: no credentials exist before login, and admin
      // ignores Authorization here anyway. The wire body mirrors admin's
      // phoneSendCodeSchema ({ phone, challengeToken }, strict — the token is
      // a required field). The human-challenge token is only sent when the
      // admin flow provided one; challenge UI itself is out of scope (card
      // 不做 section) — admin's challenge requirements pass through as errors
      // (the session layer probes challengeConfig first so a missing token is
      // surfaced as the real requirement, not a bogus invalid_phone).
      const data = await client.post<SendCodeWire>(
        '/api/auth/phone/send-code',
        { phone, challengeToken },
        { auth: false },
      );
      return {
        accepted: data.accepted === true,
        expiresInSec: typeof data.expiresIn === 'number' ? data.expiresIn : 300,
        resendAfterSec: typeof data.resendAfter === 'number' ? data.resendAfter : 60,
      };
    },

    async verifyCode(phone, code) {
      const data = await client.post<VerifyWire>(
        '/api/auth/phone/verify',
        { phone, code },
        { auth: false },
      );
      const user = data.user ?? {};
      return {
        accessToken: requireString(data.accessToken, 'accessToken'),
        refreshToken: requireString(data.refreshToken, 'refreshToken'),
        user: {
          id: requireString(user.id, 'user.id'),
          phone,
          username: typeof user.username === 'string' ? user.username : phone,
          displayName: typeof user.displayName === 'string' ? user.displayName : null,
        },
        isNewUser: data.isNewUser === true,
      };
    },

    logout() {
      return client.post<void>('/api/auth/logout', {});
    },
  };
}

/** App-wide singleton on the shared api client. */
export const authApi = createAuthApi();
