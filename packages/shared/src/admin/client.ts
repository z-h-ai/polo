import {
  AdminError,
  type AdminErrorCode,
  type AdminLlmConnectionsResponse,
  type AdminLoginResponse,
  type AdminRefreshResponse,
  type AdminValidateResponse,
} from './types.ts';

const ADMIN_ERROR_CODES = new Set<AdminErrorCode>([
  'INVALID_CREDENTIALS',
  'ACCOUNT_DISABLED',
  'TOKEN_EXPIRED',
  'INVALID_TOKEN',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'SERVER_ERROR',
  'NETWORK_ERROR',
  'UNKNOWN_ERROR',
]);

export interface AdminClientTokenStore {
  getRefreshToken(): string | null | Promise<string | null>;
  onTokensRefreshed?(tokens: AdminRefreshResponse): void | Promise<void>;
}

export class AdminClient {
  private readonly adminUrl: string;
  private readonly tokenStore?: AdminClientTokenStore;

  constructor(adminUrl: string, options?: { tokenStore?: AdminClientTokenStore }) {
    const normalized = adminUrl.trim().replace(/\/+$/, '');
    if (!normalized) {
      throw new AdminError('Admin URL is required', 'VALIDATION_ERROR');
    }
    this.adminUrl = normalized;
    this.tokenStore = options?.tokenStore;
  }

  login(username: string, password: string): Promise<AdminLoginResponse> {
    return this.request('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
  }

  refresh(refreshToken: string): Promise<AdminRefreshResponse> {
    return this.request('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
    });
  }

  validate(accessToken: string): Promise<AdminValidateResponse> {
    return this.request('/api/auth/validate', {
      method: 'POST',
      accessToken,
    });
  }

  async logout(refreshToken: string): Promise<void> {
    await this.request('/api/auth/logout', {
      method: 'POST',
      body: { refreshToken },
    });
  }

  getLlmConnections(accessToken: string): Promise<AdminLlmConnectionsResponse> {
    return this.request('/api/llm-connections', {
      method: 'GET',
      accessToken,
    });
  }

  private async request<T>(path: string, options: {
    method: 'GET' | 'POST';
    accessToken?: string;
    body?: unknown;
    retryingAfterRefresh?: boolean;
  }): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (options.accessToken) {
      headers.Authorization = `Bearer ${options.accessToken}`;
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(`${this.adminUrl}${path}`, {
        method: options.method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      throw new AdminError('Failed to reach admin server', 'NETWORK_ERROR', { cause: error });
    }

    const data = await this.readJson(response);

    if (
      response.status === 401 &&
      options.accessToken &&
      !options.retryingAfterRefresh &&
      path !== '/api/auth/refresh' &&
      this.tokenStore
    ) {
      const refreshToken = await this.tokenStore.getRefreshToken();
      if (refreshToken) {
        const refreshed = await this.refresh(refreshToken);
        await this.tokenStore.onTokensRefreshed?.(refreshed);
        return this.request<T>(path, {
          ...options,
          accessToken: refreshed.accessToken,
          retryingAfterRefresh: true,
        });
      }
    }

    if (!response.ok) {
      throw this.createError(response, data);
    }

    return data as T;
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return undefined;

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private createError(response: Response, data: unknown): AdminError {
    const statusCode = this.errorCodeForStatus(response.status);
    const errorCode = this.readAdminErrorCode(data) ?? statusCode;
    const bodyMessage =
      this.readString(data, 'message') ??
      this.readString(data, 'error_description') ??
      this.readString(data, 'error');
    const message = (bodyMessage ?? response.statusText) || 'Admin request failed';

    return new AdminError(message, errorCode, {
      status: response.status,
      details: data,
    });
  }

  private readAdminErrorCode(data: unknown): AdminErrorCode | null {
    const value =
      this.readString(data, 'errorCode') ??
      this.readString(data, 'code') ??
      this.readString(data, 'error');
    if (value && ADMIN_ERROR_CODES.has(value as AdminErrorCode)) {
      return value as AdminErrorCode;
    }
    return null;
  }

  private readString(data: unknown, key: string): string | null {
    if (!data || typeof data !== 'object') return null;
    const value = (data as Record<string, unknown>)[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private errorCodeForStatus(status: number): AdminErrorCode {
    if (status === 401) return 'UNAUTHORIZED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 404) return 'NOT_FOUND';
    if (status >= 400 && status < 500) return 'VALIDATION_ERROR';
    if (status >= 500) return 'SERVER_ERROR';
    return 'UNKNOWN_ERROR';
  }
}
