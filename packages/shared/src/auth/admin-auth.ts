import type { OnForceLogout, SessionExpiredEvent } from './force-logout.ts';
import { getGlobalForceLogoutHandler } from './global-force-logout.ts';

const DEFAULT_VALIDATE_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_VALIDATE_READ_TIMEOUT_MS = 5_000;

export type { OnForceLogout, SessionExpiredEvent } from './force-logout.ts';

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AdminApiClientOptions {
  fetchFn?: FetchFn;
  token?: string;
  onForceLogout?: OnForceLogout;
  validateTimeoutMs?: number;
  validateConnectTimeoutMs?: number;
  validateReadTimeoutMs?: number;
}

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  groupIds: string[];
}

export interface LoginResult {
  token: string;
  user: AdminUser;
}

export interface ValidateTokenResult {
  valid: true;
  user: AdminUser;
  configVersion: string;
}

export interface AdminLlmConnection {
  slug: string;
  name?: string;
  providerType?: string;
  authType?: string;
  credential?: {
    alg: string;
    kid: string;
    iv: string;
    ciphertext: string;
    tag: string;
  };
  encryptedCredentials?: string;
  models?: unknown[];
  defaultModel?: string;
  [key: string]: unknown;
}

export interface LlmConnectionsResult {
  configVersion: string;
  connections: AdminLlmConnection[];
  defaultConnection: string | null;
}

export interface ErrorEnvelope {
  error: string;
  message?: string;
  details?: unknown;
  requestId?: string;
}

export class AdminAuthApiError extends Error {
  readonly statusCode: number;
  readonly error: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(
    name: string,
    statusCode: number,
    envelope: ErrorEnvelope,
    fallbackMessage: string,
  ) {
    super(envelope.message ?? fallbackMessage);
    this.name = name;
    this.statusCode = statusCode;
    this.error = envelope.error;
    this.details = envelope.details;
    this.requestId = envelope.requestId;
  }
}

export class InvalidCredentialsError extends AdminAuthApiError {
  constructor(statusCode: number, envelope: ErrorEnvelope) {
    super('InvalidCredentialsError', statusCode, envelope, 'Invalid username or password');
  }
}

export class AccountDisabledError extends AdminAuthApiError {
  constructor(statusCode: number, envelope: ErrorEnvelope) {
    super('AccountDisabledError', statusCode, envelope, 'Account disabled');
  }
}

export class RateLimitedError extends AdminAuthApiError {
  readonly retryAfterSeconds?: number;

  constructor(statusCode: number, envelope: ErrorEnvelope, retryAfterSeconds?: number) {
    super('RateLimitedError', statusCode, envelope, 'Rate limited');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TokenRevokedError extends AdminAuthApiError {
  constructor(statusCode: number, envelope: ErrorEnvelope) {
    super('TokenRevokedError', statusCode, envelope, 'Token revoked');
  }
}

export class NetworkError extends Error {
  constructor(message = 'Admin API network error') {
    super(message);
    this.name = 'NetworkError';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type RequestOptions = {
  body?: unknown;
  token?: string;
  phaseTimeouts?: {
    connectMs: number;
    readMs: number;
  };
};

export class AdminApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly token?: string;
  private readonly onForceLogout?: OnForceLogout;
  private readonly validateConnectTimeoutMs: number;
  private readonly validateReadTimeoutMs: number;

  constructor(options: AdminApiClientOptions = {}) {
    this.baseUrl = resolveBaseUrl();
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.token = options.token;
    this.onForceLogout = options.onForceLogout;
    const legacyPhaseTimeoutMs =
      options.validateTimeoutMs === undefined ? undefined : Math.ceil(options.validateTimeoutMs / 2);
    this.validateConnectTimeoutMs =
      options.validateConnectTimeoutMs ?? legacyPhaseTimeoutMs ?? DEFAULT_VALIDATE_CONNECT_TIMEOUT_MS;
    this.validateReadTimeoutMs =
      options.validateReadTimeoutMs ?? legacyPhaseTimeoutMs ?? DEFAULT_VALIDATE_READ_TIMEOUT_MS;
  }

  async login(username: string, password: string): Promise<LoginResult> {
    return this.request<LoginResult>('POST', '/api/auth/login', {
      body: { username, password },
    });
  }

  async logout(): Promise<void> {
    await this.request<{ success: true }>('POST', '/api/auth/logout', {
      token: this.requiredToken(),
    });
  }

  async validateToken(): Promise<ValidateTokenResult> {
    return this.request<ValidateTokenResult>('POST', '/api/auth/validate', {
      token: this.requiredToken(),
      phaseTimeouts: {
        connectMs: this.validateConnectTimeoutMs,
        readMs: this.validateReadTimeoutMs,
      },
    });
  }

  async getLlmConnections(): Promise<LlmConnectionsResult> {
    return this.request<LlmConnectionsResult>('GET', '/api/llm-connections', {
      token: this.requiredToken(),
    });
  }

  private requiredToken(): string {
    if (!this.token) {
      throw new ConfigError('Admin API auth token is required');
    }
    return this.token;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    const controller = new AbortController();
    const requestUrl = this.url(path);

    let response: Response;
    try {
      response = await this.runWithTimeout(
        () => this.fetchFn(requestUrl, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        }),
        controller,
        options.phaseTimeouts?.connectMs,
        'Admin API validate connect timed out',
      );
    } catch (error) {
      throw toNetworkError(error);
    }

    if (!response.ok) {
      if (response.status === 401 && path !== '/api/auth/login' && options.token) {
        await this.notifyForceLogout({ reason: 'token_revoked', requestUrl });
      }
      throw await this.toHttpError(response, controller, options.phaseTimeouts?.readMs);
    }

    try {
      return (await this.readJson(response, controller, options.phaseTimeouts?.readMs)) as T;
    } catch (error) {
      if (error instanceof NetworkError) {
        throw error;
      }
      throw error;
    }
  }

  private async toHttpError(
    response: Response,
    controller: AbortController,
    readTimeoutMs?: number,
  ): Promise<Error> {
    const envelope = await readErrorEnvelope(response, responseToRead =>
      this.readJson(responseToRead, controller, readTimeoutMs)
    );
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('Retry-After'));

    switch (envelope.error) {
      case 'invalid_credentials':
        return new InvalidCredentialsError(response.status, envelope);
      case 'account_disabled':
        return new AccountDisabledError(response.status, envelope);
      case 'rate_limited':
        return new RateLimitedError(response.status, envelope, retryAfterSeconds);
      case 'token_revoked':
        return new TokenRevokedError(response.status, envelope);
      default:
        if (response.status === 429) {
          return new RateLimitedError(response.status, envelope, retryAfterSeconds);
        }
        if (response.status === 401) {
          return new TokenRevokedError(response.status, envelope);
        }
        return new AdminAuthApiError(
          'AdminAuthApiError',
          response.status,
          envelope,
          `Admin API returned HTTP ${response.status}`,
        );
    }
  }

  private async notifyForceLogout(event: SessionExpiredEvent): Promise<void> {
    const onForceLogout = this.onForceLogout ?? getGlobalForceLogoutHandler();
    if (!onForceLogout) {
      return;
    }

    try {
      await onForceLogout(event);
    } catch (error) {
      console.warn(
        '[AdminApiClient] Force logout hook failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async readJson(
    response: Response,
    controller: AbortController,
    timeoutMs?: number,
  ): Promise<unknown> {
    try {
      return await this.runWithTimeout(
        () => response.json() as Promise<unknown>,
        controller,
        timeoutMs,
        'Admin API validate read timed out',
      );
    } catch (error) {
      if (error instanceof NetworkError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new NetworkError('Admin API validate read timed out');
      }
      throw error;
    }
  }

  private async runWithTimeout<T>(
    operation: () => Promise<T>,
    controller: AbortController,
    timeoutMs: number | undefined,
    timeoutMessage: string,
  ): Promise<T> {
    if (timeoutMs === undefined) {
      return operation();
    }

    let timerId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    return new Promise<T>((resolve, reject) => {
      timerId = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new NetworkError(timeoutMessage);
        controller.abort(error);
        reject(error);
      }, timeoutMs);

      Promise.resolve()
        .then(operation)
        .then(
          result => {
            if (settled) return;
            settled = true;
            if (timerId !== undefined) {
              clearTimeout(timerId);
            }
            resolve(result);
          },
          error => {
            if (settled) return;
            settled = true;
            if (timerId !== undefined) {
              clearTimeout(timerId);
            }
            reject(error);
          },
        );
    });
  }
}

export function createAdminApiClient(options: AdminApiClientOptions = {}): AdminApiClient {
  return new AdminApiClient(options);
}

function resolveBaseUrl(): string {
  const raw = process.env.POLO_ADMIN_API_URL;
  if (!raw) {
    throw new ConfigError('POLO_ADMIN_API_URL environment variable is not set');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('POLO_ADMIN_API_URL must be a valid URL');
  }

  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new ConfigError('POLO_ADMIN_API_URL must use HTTPS in production');
  }

  return raw.replace(/\/+$/, '');
}

async function readErrorEnvelope(
  response: Response,
  readJson: (response: Response) => Promise<unknown> = responseToRead => responseToRead.json(),
): Promise<ErrorEnvelope> {
  try {
    const parsed = await readJson(response);
    if (isErrorEnvelope(parsed)) {
      return parsed;
    }
    const objectValue = isRecord(parsed) ? parsed : {};
    return {
      error: typeof objectValue.error === 'string' ? objectValue.error : `http_${response.status}`,
      message: typeof objectValue.message === 'string' ? objectValue.message : undefined,
      details: objectValue.details,
      requestId: typeof objectValue.requestId === 'string' ? objectValue.requestId : undefined,
    };
  } catch (error) {
    if (error instanceof NetworkError) {
      throw error;
    }
    return { error: `http_${response.status}` };
  }
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { error?: unknown }).error === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds));
  }

  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
}

function toNetworkError(error: unknown): NetworkError {
  if (error instanceof NetworkError) {
    return error;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new NetworkError('Admin API request timed out');
    }
    return new NetworkError(`Admin API network error: ${error.message}`);
  }
  return new NetworkError(`Admin API network error: ${String(error)}`);
}
