// Admin HTTP client for the mobile app (POL-239).
//
// Mirrors the wire contract of packages/shared/src/admin/client.ts without
// importing it (App side checks against apps/mobile/types/shared-protocol.d.ts
// per repo convention). Responsibilities:
//  - attach the Authorization header from the token store cache;
//  - on 401, rotate tokens via POST /api/auth/refresh and replay the original
//    request exactly once;
//  - share a single in-flight refresh across concurrent requests (single
//    flight);
//  - when refresh fails, clear local credentials, notify global subscribers
//    (the session store routes back to login) and throw AuthExpiredError;
//  - pass admin error codes through verbatim (rate limits, verification
//    failures, human-challenge requirements) — no swallowing, no translation.

import { apiBaseUrl } from './config';
import type { StoredTokens, TokenStore } from '../auth/tokenStore';
import { tokenStore as defaultTokenStore } from '../auth/tokenStore';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_SECONDS = 86_400;

/**
 * 401 codes that mean the credential itself failed. Admin also returns
 * business 401s with other codes (qr confirm: qr_login_expired,
 * invalid_credentials) — those must NOT enter the refresh/replay chain: the
 * token is fine, replaying cannot help, and treating them as auth failures
 * would wipe a perfectly good session and log the user out (POL-240).
 * Lowercase = admin wire codes (lib/auth), uppercase = client fallbacks.
 */
const AUTH_401_CODES = new Set([
  'unauthorized',
  'token_revoked',
  'UNAUTHORIZED',
  'TOKEN_REVOKED',
  'TOKEN_EXPIRED',
  'AUTH_EXPIRED',
]);

export class ApiError extends Error {
  readonly status: number;
  /** Admin error code, passed through verbatim (e.g. 'sms_rate_limited'). */
  readonly errorCode: string;
  /** Server-provided wait seconds (rate limits), when present. */
  readonly retryAfterSeconds?: number;
  /** Remaining verification attempts, when admin returns it. */
  readonly attemptsRemaining?: number;
  readonly body?: unknown;

  constructor(options: {
    status: number;
    errorCode: string;
    message?: string;
    retryAfterSeconds?: number;
    attemptsRemaining?: number;
    body?: unknown;
  }) {
    super(options.message ?? `Request failed (${options.errorCode})`);
    this.name = 'ApiError';
    this.status = options.status;
    this.errorCode = options.errorCode;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.attemptsRemaining = options.attemptsRemaining;
    this.body = options.body;
  }
}

/** Thrown when credentials are missing or a refresh rotation was rejected. */
export class AuthExpiredError extends Error {
  constructor(message = 'Authentication expired', cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AuthExpiredError';
  }
}

export class NetworkError extends Error {
  constructor(message = 'Failed to reach admin server', cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NetworkError';
  }
}

/** Minimal fetch surface so tests can inject doubles (global fetch fits). */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Attach the Authorization header (default true). */
  auth?: boolean;
}

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
  /** Registers a listener invoked when refresh fails and local state is cleared. */
  onAuthExpired(listener: () => void): () => void;
}

interface RawResponse {
  response: Response;
  data: unknown;
}

export function createApiClient(deps: {
  tokens: Pick<
    TokenStore,
    'getCached' | 'save' | 'updateAccessToken' | 'clear' | 'load'
  >;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}): ApiClient {
  // 惰性解析全局 fetch：预览/测试夹具在模块求值后替换 globalThis.fetch 也能生效。
  const doFetch: FetchLike = deps.fetch ?? ((input, init) => globalThis.fetch(input as Parameters<FetchLike>[0], init));
  const baseUrl = (deps.baseUrl ?? apiBaseUrl).replace(/\/+$/, '');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authExpiredListeners = new Set<() => void>();

  function notifyAuthExpired() {
    for (const listener of authExpiredListeners) listener();
  }

  function buildHeaders(body: unknown, auth: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      const accessToken = deps.tokens.getCached()?.accessToken;
      if (!accessToken) throw new AuthExpiredError('Not signed in');
      headers.Authorization = `Bearer ${accessToken}`;
    }
    return headers;
  }

  async function send(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    auth: boolean,
  ): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: buildHeaders(body, auth),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await readJson(response);
      return { response, data };
    } catch (error) {
      if (error instanceof AuthExpiredError) throw error;
      throw new NetworkError(undefined, error);
    } finally {
      clearTimeout(timer);
    }
  }

  // Single flight: concurrent 401s share this one refresh promise.
  let refreshInFlight: Promise<StoredTokens> | null = null;

  /**
   * Drops credentials and notifies subscribers, but only while `refreshToken`
   * is still the stored session. A login that completed while a failed refresh
   * or a rejected replay was in flight must survive — never wipe the newer
   * session. Callers sharing one flight therefore clear/notify exactly once:
   * the first invocation clears, the rest see a mismatched (or absent) session.
   */
  async function clearIfCurrentSession(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    if (deps.tokens.getCached()?.refreshToken !== refreshToken) return;
    await deps.tokens.clear();
    notifyAuthExpired();
  }

  /** Rotates tokens once; on failure clears credentials and notifies once. */
  function refreshRotation(): Promise<StoredTokens> {
    const current = deps.tokens.getCached();
    const refreshToken = current?.refreshToken;
    if (!refreshToken) return Promise.reject(new AuthExpiredError());
    if (refreshInFlight) return refreshInFlight;
    const attempt = (async () => {
      try {
        const { response, data } = await send('/api/auth/refresh', 'POST', { refreshToken }, false);
        if (!response.ok) throw toApiError(response.status, data);
        const payload = data as { accessToken?: unknown; refreshToken?: unknown };
        if (typeof payload.accessToken !== 'string' || typeof payload.refreshToken !== 'string') {
          throw new ApiError({ status: response.status, errorCode: 'INVALID_TOKEN' });
        }
        const next: StoredTokens = {
          accessToken: payload.accessToken,
          refreshToken: payload.refreshToken,
          user: current.user,
        };
        await deps.tokens.save(next);
        return next;
      } catch (error) {
        // Refresh rejected: drop credentials once and let subscribers route
        // to login — every request sharing this flight observes the same
        // AuthExpiredError. Guarded so a mid-flight re-login is not wiped.
        await clearIfCurrentSession(refreshToken);
        throw error instanceof ApiError
          ? new AuthExpiredError(undefined, error)
          : new AuthExpiredError();
      } finally {
        refreshInFlight = null;
      }
    })();
    refreshInFlight = attempt;
    return attempt;
  }

  async function request<T>(
    path: string,
    options: RequestOptions & { replayed?: boolean } = {},
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const auth = options.auth !== false;

    const { response, data } = await send(path, method, options.body, auth);

    if (response.status === 401 && auth && !options.replayed && path !== '/api/auth/refresh') {
      // A business 401 (recognizable non-auth code, e.g. qr_login_expired on
      // the qr confirm route) is terminal for the request: the credential is
      // valid, so neither the refresh rotation nor the replay can change the
      // outcome. Surface it verbatim and keep the session (POL-240).
      const firstCode = readErrorCode(data);
      if (firstCode !== null && !AUTH_401_CODES.has(firstCode)) {
        throw toApiError(response.status, data);
      }
      const rotated = await refreshRotation();
      try {
        return await request<T>(path, { ...options, replayed: true });
      } catch (replayError) {
        // A replay that still 401s means the fresh session itself is unusable
        // (auth code or unreadable body). Clear only while that rotated
        // session is still the stored one — concurrent replays clear/notify
        // exactly once, and a racing re-login is left alone. Either way no
        // further refresh happens (replayed flag prevents a refresh loop).
        // A replay 401 carrying a business code means the new token WORKS —
        // surface the ApiError without touching the session.
        if (replayError instanceof ApiError && replayError.status === 401) {
          if (!AUTH_401_CODES.has(replayError.errorCode)) throw replayError;
          await clearIfCurrentSession(rotated.refreshToken);
          throw new AuthExpiredError(undefined, replayError);
        }
        throw replayError;
      }
    }

    if (!response.ok) throw toApiError(response.status, data);
    return data as T;
  }

  return {
    request,
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
      request<T>(path, { ...options, method: 'POST', body }),
    onAuthExpired(listener) {
      authExpiredListeners.add(listener);
      return () => {
        authExpiredListeners.delete(listener);
      };
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readErrorCode(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  for (const key of ['errorCode', 'code', 'error'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function readNumberField(data: unknown, keys: string[]): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const details = record.details;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.ceil(value);
  }
  if (details && typeof details === 'object') {
    for (const key of keys) {
      const value = (details as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value)) return Math.ceil(value);
    }
  }
  return undefined;
}

function statusFallbackCode(status: number): string {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 400 && status < 500) return 'VALIDATION_ERROR';
  if (status >= 500) return 'SERVER_ERROR';
  return 'UNKNOWN_ERROR';
}

function toApiError(status: number, data: unknown): ApiError {
  const retryAfter = readNumberField(data, ['retryAfter', 'retryAfterSeconds']);
  return new ApiError({
    status,
    errorCode: readErrorCode(data) ?? statusFallbackCode(status),
    retryAfterSeconds:
      retryAfter !== undefined && retryAfter > 0 && retryAfter <= MAX_RETRY_AFTER_SECONDS
        ? retryAfter
        : undefined,
    attemptsRemaining: readNumberField(data, ['attemptsRemaining', 'remainingAttempts']),
    body: data,
  });
}

/** App-wide singleton wired to the SecureStore-backed token store. */
export const apiClient = createApiClient({ tokens: defaultTokenStore });
