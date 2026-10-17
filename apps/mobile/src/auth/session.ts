// Session state for the mobile app (POL-14).
//
// zustand store holding the auth lifecycle:
//   unauthenticated -> authenticating -> authenticated (and back).
// Also owns the send-code countdown: local clock, started on send success;
// when admin answers sms_rate_limited the server-provided wait seconds
// override the local countdown (server wins on disagreement).
// Login-error copy follows the P01 prototype wording.

import { create } from 'zustand';

import type { AuthApi } from '../api/auth';
import { authApi as defaultAuthApi } from '../api/auth';
import { apiClient, ApiError, AuthExpiredError, NetworkError } from '../api/client';
import type { StoredUser, TokenStore } from './tokenStore';
import { tokenStore as defaultTokenStore } from './tokenStore';

export type AuthStatus = 'unauthenticated' | 'authenticating' | 'authenticated';

export type CountdownKind = 'cooldown' | 'rate_limited';

export interface CountdownState {
  kind: CountdownKind;
  durationSec: number;
  /** Local-clock deadline (epoch ms). */
  endsAtMs: number;
}

export interface SessionState {
  status: AuthStatus;
  /** False until the persisted token read completes; AuthGate waits for it. */
  hydrated: boolean;
  token: string | null;
  user: StoredUser | null;
  isNewUser: boolean | null;
  /** Login error copy for the error bar (P01 错误态). */
  error: string | null;
  errorCode: string | null;
  /** 发码成功 toast 文案，P01 填写态。 */
  toast: string | null;
  countdown: CountdownState | null;
  remainingSec: number;

  restore(): Promise<void>;
  sendCode(phone: string, challengeToken?: string): Promise<void>;
  verify(phone: string, code: string): Promise<boolean>;
  signOut(): Promise<void>;
  tick(): void;
  clearError(): void;
  dismissToast(): void;
  /** api client auth-expired callback: session revoked server-side. */
  handleAuthExpired(): void;
}

export interface SessionDeps {
  tokens: TokenStore;
  api: AuthApi;
  now: () => number;
}

/** 13800008000 -> '138 0000 8000' (P01 toast formatting). */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 11) return phone;
  return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`;
}

export function remainingSeconds(endsAtMs: number, now: () => number): number {
  return Math.max(0, Math.ceil((endsAtMs - now()) / 1000));
}

/** Maps admin errors to P01 copy; unknown codes pass through transparently. */
export function authErrorCopy(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) {
    const attempts = error.attemptsRemaining;
    switch (error.errorCode) {
      case 'sms_rate_limited':
        return { code: error.errorCode, message: '短信发送过于频繁，请稍后再试。' };
      case 'verification_code_invalid':
        return {
          code: error.errorCode,
          message: attempts !== undefined
            ? `验证码错误，请重新输入（剩余尝试 ${attempts} 次，连续失败将锁定 10 分钟）。`
            : '验证码错误，请重新输入。',
        };
      case 'verification_code_expired':
        return { code: error.errorCode, message: '验证码已过期，请重新获取。' };
      case 'verification_attempts_exceeded':
        return { code: error.errorCode, message: '尝试次数过多，账号已锁定，请 10 分钟后再试。' };
      case 'invalid_phone':
        return { code: error.errorCode, message: '手机号格式不正确，请检查后重试。' };
      case 'invalid_credentials':
        return { code: error.errorCode, message: '安全验证未通过，请稍后再试。' };
      case 'browser_redirect':
        return { code: error.errorCode, message: '需要在浏览器中完成安全验证后再试。' };
      case 'account_disabled':
        return { code: error.errorCode, message: '账号已被禁用，请联系管理员。' };
      case 'account_locked':
        return { code: error.errorCode, message: '账号已被锁定，请稍后再试。' };
      case 'phone_auth_disabled':
      case 'phone_auth_configuration_error':
        return { code: error.errorCode, message: '手机号登录暂不可用，请联系管理员。' };
      case 'sms_send_failed':
        return { code: error.errorCode, message: '短信发送失败，请稍后再试。' };
      case 'phone_not_registered':
        return { code: error.errorCode, message: '该手机号尚未注册。' };
      case 'internal_error':
      case 'SERVER_ERROR':
      case 'TIMEOUT':
      case 'NETWORK_ERROR':
        return { code: error.errorCode, message: '网络异常，请稍后再试。' };
      default:
        // 人机验证要求等未知错误码：透传码值，不翻译语义。
        return { code: error.errorCode, message: `请求失败（${error.errorCode}），请稍后再试。` };
    }
  }
  if (error instanceof AuthExpiredError) {
    return { code: 'auth_expired', message: '登录已过期，请重新登录。' };
  }
  if (error instanceof NetworkError) {
    return { code: 'NETWORK_ERROR', message: '网络异常，请稍后再试。' };
  }
  return { code: 'unknown', message: '请求失败，请稍后再试。' };
}

export function createSessionStore(deps?: Partial<SessionDeps>) {
  const tokens = deps?.tokens ?? defaultTokenStore;
  const api = deps?.api ?? defaultAuthApi;
  const now = deps?.now ?? Date.now;

  return create<SessionState>((set, get) => {
    function startCountdown(kind: CountdownKind, seconds: number) {
      const durationSec = Math.max(1, Math.ceil(seconds));
      set({
        countdown: { kind, durationSec, endsAtMs: now() + durationSec * 1000 },
        remainingSec: durationSec,
      });
    }

    return {
      status: 'unauthenticated',
      hydrated: false,
      token: null,
      user: null,
      isNewUser: null,
      error: null,
      errorCode: null,
      toast: null,
      countdown: null,
      remainingSec: 0,

      async restore() {
        if (get().hydrated) return;
        const stored = await tokens.load(); // unreadable/missing -> signed out
        if (stored) {
          set({
            hydrated: true,
            status: 'authenticated',
            token: stored.accessToken,
            user: stored.user,
          });
        } else {
          set({ hydrated: true, status: 'unauthenticated' });
        }
      },

      async sendCode(phone, challengeToken) {
        set({ error: null, errorCode: null, toast: null });
        try {
          // Admin 的人机验证要求透传：send-code 的 challengeToken 是必填字段，
          // 没有凭据时先探测 challenge config。admin 要求验证（如
          // browser_redirect）则原样作为错误浮出，绝不伪装成 invalid_phone；
          // 验证 UI 本身是后续卡的范围（card 不做 section）。
          if (challengeToken === undefined) {
            const requirement = await api.challengeConfig();
            if (requirement.type) {
              throw new ApiError({ status: 403, errorCode: requirement.type });
            }
          }
          const result = await api.sendCode(phone, challengeToken);
          const minutes = Math.max(1, Math.round(result.expiresInSec / 60));
          set({
            toast: `验证码已发送至 ${formatPhone(phone)}，${minutes} 分钟内有效`,
          });
          // 本地时钟计时，发码成功即起点。
          startCountdown('cooldown', result.resendAfterSec);
        } catch (error) {
          const copy = authErrorCopy(error);
          if (error instanceof ApiError && error.errorCode === 'sms_rate_limited') {
            // 限流：服务端等待秒数覆盖本地计时，两端不一致以服务端为准。
            const wait = error.retryAfterSeconds ?? 60;
            set({ error: copy.message, errorCode: copy.code });
            startCountdown('rate_limited', wait);
            return;
          }
          set({ error: copy.message, errorCode: copy.code });
        }
      },

      async verify(phone, code) {
        set({ status: 'authenticating', error: null, errorCode: null, toast: null });
        try {
          const result = await api.verifyCode(phone, code);
          await tokens.save({
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            user: result.user,
          });
          set({
            status: 'authenticated',
            token: result.accessToken,
            user: result.user,
            isNewUser: result.isNewUser,
            countdown: null,
            remainingSec: 0,
          });
          return true;
        } catch (error) {
          const copy = authErrorCopy(error);
          set({
            status: 'unauthenticated',
            error: copy.message,
            errorCode: copy.code,
          });
          return false;
        }
      },

      async signOut() {
        try {
          await api.logout(); // best-effort; store clears regardless
        } catch {
          // Server-side revocation failed — local credentials are dropped anyway.
        }
        await tokens.clear();
        set({
          status: 'unauthenticated',
          token: null,
          user: null,
          isNewUser: null,
          error: null,
          errorCode: null,
          toast: null,
          countdown: null,
          remainingSec: 0,
        });
      },

      tick() {
        const countdown = get().countdown;
        if (!countdown) return;
        const remaining = remainingSeconds(countdown.endsAtMs, now);
        if (remaining <= 0) {
          set({ countdown: null, remainingSec: 0 }); // 到期可重发
        } else if (remaining !== get().remainingSec) {
          set({ remainingSec: remaining });
        }
      },

      clearError() {
        set({ error: null, errorCode: null });
      },

      dismissToast() {
        set({ toast: null });
      },

      handleAuthExpired() {
        // api client already cleared persisted credentials.
        const copy = authErrorCopy(new AuthExpiredError());
        set({
          status: 'unauthenticated',
          token: null,
          user: null,
          isNewUser: null,
          error: copy.message,
          errorCode: copy.code,
        });
      },
    };
  });
}

/** App-wide singleton. */
export const useSessionStore = createSessionStore();

// 全局订阅者：api client 刷新失败清态时，把会话打回未登录
// （AuthGate 订阅 status 并路由回登录页）。
apiClient.onAuthExpired(() => useSessionStore.getState().handleAuthExpired());
