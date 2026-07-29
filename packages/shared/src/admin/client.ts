import {
  AdminError,
  type AdminAuthConfig,
  type AdminErrorCode,
  type AdminLlmConnectionsResponse,
  type AdminLoginResponse,
  type AdminPhoneAuthResponse,
  type AdminPhoneAuthChallengeConfig,
  type AdminRefreshResponse,
  type SendPhoneAuthCodeInput,
  type SendPhoneAuthCodeResponse,
  type SetAdminPasswordInput,
  type SetAdminPasswordResponse,
  type AdminValidateResponse,
  type VerifyPhoneAuthCodeInput,
  type AcceptOrganizationJoinResponse,
  type CreateOrganizationInput,
  type CreateOrganizationInvitationInput,
  type CreateOrganizationInvitationResponse,
  type CreateOrganizationJoinLinkInput,
  type CreateOrganizationJoinLinkResponse,
  type CreateOrganizationResponse,
  type ListOrganizationsResponse,
  type OrganizationInvitation,
  type OrganizationJoinLink,
  type OrganizationJoinPreview,
  type OrganizationMember,
  type OrganizationMembership,
  type UpdateOrganizationMemberInput,
} from './types.ts';
import type { ZodType } from 'zod';
import {
  AdminLoginResponseSchema,
  AdminPhoneAuthResponseSchema,
  AdminRefreshResponseSchema,
  AdminValidateResponseSchema,
  SendPhoneAuthCodeResponseSchema,
  SetAdminPasswordResponseSchema,
  AcceptOrganizationJoinResponseSchema,
  CreateOrganizationInvitationResponseSchema,
  CreateOrganizationJoinLinkResponseSchema,
  CreateOrganizationResponseSchema,
  ListOrganizationInvitationsResponseSchema,
  ListOrganizationMembersResponseSchema,
  ListOrganizationsResponseSchema,
  OrganizationInvitationMutationResponseSchema,
  OrganizationJoinLinkMutationResponseSchema,
  OrganizationJoinPreviewSchema,
  OrganizationMemberMutationResponseSchema,
} from './schemas.ts';

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
  'idempotency_conflict',
  'join_link_not_allowed',
  'join_token_invalid',
  'join_token_cancelled',
  'join_token_expired',
  'join_token_exhausted',
  'phone_mismatch',
  'last_owner_required',
  'duplicate_request',
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

const SAFE_ADMIN_ERROR_MESSAGES: Record<AdminErrorCode, string> = {
  INVALID_CREDENTIALS: 'Invalid username or password',
  ACCOUNT_DISABLED: 'Admin account is disabled',
  TOKEN_REVOKED: 'Admin session is no longer valid',
  TOKEN_EXPIRED: 'Admin session is no longer valid',
  INVALID_TOKEN: 'Admin session is no longer valid',
  UNAUTHORIZED: 'Admin session is no longer valid',
  FORBIDDEN: 'Admin request is not permitted',
  NOT_FOUND: 'Admin resource was not found',
  VALIDATION_ERROR: 'Admin request was rejected',
  SERVER_ERROR: 'Admin service is temporarily unavailable',
  NETWORK_ERROR: 'Failed to reach admin server',
  UNKNOWN_ERROR: 'Admin request failed',
  phone_auth_disabled: 'Phone authentication is unavailable',
  invalid_phone: 'Phone number is invalid',
  verification_code_invalid: 'Verification code is invalid',
  verification_code_expired: 'Verification code has expired',
  verification_attempts_exceeded: 'Verification attempts exceeded',
  phone_not_registered: 'Phone number is not registered',
  sms_rate_limited: 'Phone authentication request was rate limited',
  sms_send_failed: 'Admin service is temporarily unavailable',
  phone_auth_configuration_error: 'Admin service is temporarily unavailable',
  invalid_credentials: 'Invalid username or password',
  idempotency_conflict: 'This organization request conflicts with an earlier submission',
  join_link_not_allowed: 'Public join links are only available for creator spaces',
  join_token_invalid: 'This invitation link is invalid',
  join_token_cancelled: 'This invitation link has been cancelled',
  join_token_expired: 'This invitation link has expired',
  join_token_exhausted: 'This invitation link has no uses remaining',
  phone_mismatch: 'This invitation is assigned to a different phone number',
  last_owner_required: 'The only active owner cannot be changed or removed',
  duplicate_request: 'This request is already being processed',
};

const MAX_RETRY_AFTER_SECONDS = 86_400;

export function getSafeAdminErrorMessage(
  errorCode: AdminErrorCode,
  status?: number,
): string {
  if (typeof status === 'number' && status >= 500) {
    return 'Admin service is temporarily unavailable';
  }
  return SAFE_ADMIN_ERROR_MESSAGES[errorCode] ?? 'Admin request failed';
}

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

  async login(identifier: string, password: string): Promise<AdminLoginResponse> {
    const response = await this.request<unknown>('/api/auth/login', {
      method: 'POST',
      body: { identifier, password },
    });
    return this.readSuccessResponse(response, AdminLoginResponseSchema);
  }

  async getAuthConfig(): Promise<AdminAuthConfig> {
    const response = await this.request<AdminAuthConfig>('/api/auth/config', {
      method: 'GET',
    });
    return { phoneAuthEnabled: response.phoneAuthEnabled === true };
  }

  async getPhoneAuthChallengeConfig(): Promise<AdminPhoneAuthChallengeConfig> {
    const response = await this.request<unknown>('/api/auth/phone/challenge/config', {
      method: 'GET',
    });
    const issuerUrl = response && typeof response === 'object'
      ? (response as Record<string, unknown>).issuerUrl
      : undefined;
    if (
      !response
      || typeof response !== 'object'
      || (response as Record<string, unknown>).type !== 'browser_redirect'
      || typeof issuerUrl !== 'string'
      || !issuerUrl
    ) {
      throw new AdminError(
        'Phone auth challenge configuration is invalid',
        'phone_auth_configuration_error',
      );
    }
    return {
      type: 'browser_redirect',
      issuerUrl,
    };
  }

  async sendPhoneAuthCode(input: SendPhoneAuthCodeInput): Promise<SendPhoneAuthCodeResponse> {
    const response = await this.request<unknown>('/api/auth/phone/send-code', {
      method: 'POST',
      body: {
        phone: input.phone,
        challengeToken: input.challengeToken,
      },
    });
    return this.readSuccessResponse(response, SendPhoneAuthCodeResponseSchema);
  }

  async verifyPhoneAuthCode(input: VerifyPhoneAuthCodeInput): Promise<AdminPhoneAuthResponse> {
    const response = await this.request<unknown>('/api/auth/phone/verify', {
      method: 'POST',
      body: {
        phone: input.phone,
        code: input.code,
      },
    });
    return this.readSuccessResponse(response, AdminPhoneAuthResponseSchema);
  }

  async setPassword(accessToken: string, input: SetAdminPasswordInput): Promise<SetAdminPasswordResponse> {
    const response = await this.request<unknown>('/api/auth/password', {
      method: 'POST',
      accessToken,
      body: { password: input.password },
    });
    return this.readSuccessResponse(response, SetAdminPasswordResponseSchema);
  }

  async refresh(refreshToken: string): Promise<AdminRefreshResponse> {
    const response = await this.request<unknown>('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
    });
    return this.readSuccessResponse(response, AdminRefreshResponseSchema);
  }

  async validate(accessToken: string): Promise<AdminValidateResponse> {
    const response = await this.request<unknown>('/api/auth/validate', {
      method: 'POST',
      accessToken,
    });
    return this.readSuccessResponse(response, AdminValidateResponseSchema);
  }

  async logout(accessToken: string): Promise<void> {
    await this.request('/api/auth/logout', {
      method: 'POST',
      accessToken,
    });
  }

  getLlmConnections(accessToken: string): Promise<AdminLlmConnectionsResponse> {
    return this.request('/api/llm-connections', {
      method: 'GET',
      accessToken,
    });
  }

  async listOrganizations(accessToken: string): Promise<ListOrganizationsResponse> {
    const response = await this.request<unknown>('/api/me/organizations', {
      method: 'GET',
      accessToken,
    });
    return this.readSuccessResponse(response, ListOrganizationsResponseSchema);
  }

  async createOrganization(
    accessToken: string,
    input: CreateOrganizationInput,
  ): Promise<CreateOrganizationResponse> {
    const response = await this.request<unknown>('/api/organizations', {
      method: 'POST',
      accessToken,
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: input,
    });
    return this.readSuccessResponse(response, CreateOrganizationResponseSchema);
  }

  async previewOrganizationJoin(token: string): Promise<OrganizationJoinPreview> {
    const response = await this.request<unknown>(
      `/api/join/${encodeURIComponent(token)}/preview`,
      { method: 'GET' },
    );
    return this.readSuccessResponse(response, OrganizationJoinPreviewSchema);
  }

  async acceptOrganizationJoin(
    accessToken: string,
    token: string,
  ): Promise<AcceptOrganizationJoinResponse> {
    const response = await this.request<unknown>(
      `/api/join/${encodeURIComponent(token)}/accept`,
      { method: 'POST', accessToken },
    );
    return this.readSuccessResponse(response, AcceptOrganizationJoinResponseSchema);
  }

  async listOrganizationMembers(
    accessToken: string,
    organizationId: string,
  ): Promise<{ members: OrganizationMember[] }> {
    const response = await this.request<unknown>(
      `/api/organizations/${encodeURIComponent(organizationId)}/members`,
      { method: 'GET', accessToken },
    );
    return this.readSuccessResponse(response, ListOrganizationMembersResponseSchema);
  }

  async listOrganizationInvitations(
    accessToken: string,
    organizationId: string,
  ): Promise<{ invitations: OrganizationInvitation[] }> {
    const response = await this.request<unknown>(
      `/api/organizations/${encodeURIComponent(organizationId)}/invitations`,
      { method: 'GET', accessToken },
    );
    return this.readSuccessResponse(response, ListOrganizationInvitationsResponseSchema);
  }

  async createOrganizationInvitation(
    accessToken: string,
    organizationId: string,
    input: CreateOrganizationInvitationInput,
  ): Promise<CreateOrganizationInvitationResponse> {
    const response = await this.request<unknown>(
      `/api/organizations/${encodeURIComponent(organizationId)}/invitations`,
      { method: 'POST', accessToken, body: input },
    );
    return this.readSuccessResponse(response, CreateOrganizationInvitationResponseSchema);
  }

  async cancelOrganizationInvitation(
    accessToken: string,
    organizationId: string,
    invitationId: string,
  ): Promise<{ invitation: Pick<OrganizationInvitation, 'id' | 'status' | 'cancelledAt'> }> {
    const response = await this.request<unknown>(
      `/api/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: 'DELETE', accessToken },
    );
    return this.readSuccessResponse(response, OrganizationInvitationMutationResponseSchema);
  }

  async createOrganizationJoinLink(
    accessToken: string,
    organizationId: string,
    input: CreateOrganizationJoinLinkInput,
  ): Promise<CreateOrganizationJoinLinkResponse> {
    const response = await this.request<unknown>(
      `/api/organizations/${encodeURIComponent(organizationId)}/join-links`,
      { method: 'POST', accessToken, body: input },
    );
    return this.readSuccessResponse(response, CreateOrganizationJoinLinkResponseSchema);
  }

  async revokeOrganizationJoinLink(
    accessToken: string,
    organizationId: string,
    joinLinkId: string,
  ): Promise<{ joinLink: Pick<OrganizationJoinLink, 'id' | 'status' | 'revokedAt'> }> {
    const response = await this.request<unknown>(
      `/api/organizations/${encodeURIComponent(organizationId)}/join-links/${encodeURIComponent(joinLinkId)}`,
      { method: 'DELETE', accessToken },
    );
    return this.readSuccessResponse(response, OrganizationJoinLinkMutationResponseSchema);
  }

  async updateOrganizationMember(
    accessToken: string,
    organizationId: string,
    memberId: string,
    input: UpdateOrganizationMemberInput,
  ): Promise<{ membership: OrganizationMembership }> {
    const response = await this.request<unknown>(
      `/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(memberId)}`,
      { method: 'PATCH', accessToken, body: input },
    );
    return this.readSuccessResponse(response, OrganizationMemberMutationResponseSchema);
  }

  async removeOrganizationMember(
    accessToken: string,
    organizationId: string,
    memberId: string,
    reason?: string,
  ): Promise<{ membership: OrganizationMembership }> {
    const response = await this.request<unknown>(
      `/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(memberId)}`,
      {
        method: 'DELETE',
        accessToken,
        body: reason ? { reason } : {},
      },
    );
    return this.readSuccessResponse(response, OrganizationMemberMutationResponseSchema);
  }

  private async request<T>(path: string, options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    accessToken?: string;
    body?: unknown;
    headers?: Record<string, string>;
    retryingAfterRefresh?: boolean;
  }): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
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
    const message = this.safeErrorMessage(response.status, errorCode);

    return new AdminError(message, errorCode, {
      status: response.status,
      details: this.readSafeErrorDetails(data),
    });
  }

  private safeErrorMessage(
    status: number,
    errorCode: AdminErrorCode,
  ): string {
    return getSafeAdminErrorMessage(errorCode, status);
  }

  private readSafeErrorDetails(data: unknown): { retryAfter?: number } | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const record = data as Record<string, unknown>;
    const nested = record.details && typeof record.details === 'object'
      ? (record.details as Record<string, unknown>).retryAfter
      : undefined;
    const value = record.retryAfter ?? nested;
    return (
      typeof value === 'number'
      && Number.isFinite(value)
      && value > 0
      && value <= MAX_RETRY_AFTER_SECONDS
    )
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

  private readSuccessResponse<T>(data: unknown, schema: ZodType<T>): T {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new AdminError('Admin response is invalid', 'SERVER_ERROR');
    }
    return result.data;
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
