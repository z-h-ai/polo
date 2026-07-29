import {
  AdminError,
  type AdminAuthConfig,
  type AdminErrorCode,
  type AdminLlmConnectionsResponse,
  type AdminLoginResponse,
  type AdminPhoneAuthResponse,
  type AdminRefreshResponse,
  type SendPhoneAuthCodeInput,
  type SendPhoneAuthCodeResponse,
  type SetAdminPasswordInput,
  type SetAdminPasswordResponse,
  type AdminValidateResponse,
  type VerifyPhoneAuthCodeInput,
} from './types.ts';

const ADMIN_ERROR_CODES = new Set<AdminErrorCode>([
  'INVALID_CREDENTIALS',
  'ACCOUNT_DISABLED',
  'TOKEN_REVOKED',
  'TOKEN_EXPIRED',
  'INVALID_TOKEN',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'SERVER_ERROR',
  'NETWORK_ERROR',
  'UNKNOWN_ERROR',
  'phone_auth_disabled',
  'invalid_phone',
  'verification_code_invalid',
  'verification_code_expired',
  'verification_attempts_exceeded',
  'phone_not_registered',
  'sms_rate_limited',
  'sms_send_failed',
  'phone_auth_configuration_error',
  'invalid_credentials',
]);

const ADMIN_ERROR_CODE_ALIASES: Record<string, AdminErrorCode> = {
  account_disabled: 'ACCOUNT_DISABLED',
  forbidden: 'FORBIDDEN',
  invalid_token: 'INVALID_TOKEN',
  not_found: 'NOT_FOUND',
  token_expired: 'TOKEN_EXPIRED',
  token_revoked: 'TOKEN_REVOKED',
  unauthorized: 'UNAUTHORIZED',
  validation_error: 'VALIDATION_ERROR',
};

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

  login(identifier: string, password: string): Promise<AdminLoginResponse> {
    return this.request('/api/auth/login', {
      method: 'POST',
      body: { identifier, password },
    });
  }

  async getAuthConfig(): Promise<AdminAuthConfig> {
    const response = await this.request<AdminAuthConfig>('/api/auth/config', {
      method: 'GET',
    });
    return { phoneAuthEnabled: response.phoneAuthEnabled === true };
  }

  async sendPhoneAuthCode(input: SendPhoneAuthCodeInput): Promise<SendPhoneAuthCodeResponse> {
    const response = await this.request<SendPhoneAuthCodeResponse>('/api/auth/phone/send-code', {
      method: 'POST',
      body: {
        phone: input.phone,
        challengeToken: input.challengeToken,
      },
    });
    return {
      accepted: response.accepted === true,
      expiresIn: response.expiresIn,
      resendAfter: response.resendAfter,
    };
  }

  async verifyPhoneAuthCode(input: VerifyPhoneAuthCodeInput): Promise<AdminPhoneAuthResponse> {
    const response = await this.request<AdminPhoneAuthResponse>('/api/auth/phone/verify', {
      method: 'POST',
      body: {
        phone: input.phone,
        code: input.code,
      },
    });
    return {
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiresIn: response.expiresIn,
      user: response.user,
      isNewUser: response.isNewUser === true,
    };
  }

  async setPassword(accessToken: string, input: SetAdminPasswordInput): Promise<SetAdminPasswordResponse> {
    const response = await this.request<SetAdminPasswordResponse>('/api/auth/password', {
      method: 'POST',
      accessToken,
      body: { password: input.password },
    });
    return { success: response.success === true };
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
    const message = this.safeErrorMessage(response.status, errorCode, bodyMessage, response.statusText);

    return new AdminError(message, errorCode, {
      status: response.status,
      details: this.readSafeErrorDetails(data),
    });
  }

  private safeErrorMessage(
    status: number,
    errorCode: AdminErrorCode,
    bodyMessage: string | null,
    statusText: string,
  ): string {
    if (status >= 500 || errorCode === 'sms_send_failed' || errorCode === 'phone_auth_configuration_error') {
      return 'Admin service is temporarily unavailable';
    }
    if (errorCode === 'NETWORK_ERROR') {
      return 'Failed to reach admin server';
    }
    return (bodyMessage ?? statusText) || 'Admin request failed';
  }

  private readSafeErrorDetails(data: unknown): { retryAfter?: number } | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const record = data as Record<string, unknown>;
    const nested = record.details && typeof record.details === 'object'
      ? (record.details as Record<string, unknown>).retryAfter
      : undefined;
    const value = record.retryAfter ?? nested;
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? { retryAfter: Math.ceil(value) }
      : undefined;
  }

  private readAdminErrorCode(data: unknown): AdminErrorCode | null {
    const value =
      this.readString(data, 'errorCode') ??
      this.readString(data, 'code') ??
      this.readString(data, 'error');
    if (value && ADMIN_ERROR_CODE_ALIASES[value]) {
      return ADMIN_ERROR_CODE_ALIASES[value];
    }
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
