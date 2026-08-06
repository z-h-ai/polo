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
  type AppCatalogFetchResult,
  type AppReleaseDownload,
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
  type CreatorArtifact,
  type CreatorArtifactCapability,
  type CreatorArtifactCatalogPage,
  type CreatorArtifactDetail,
  type CreatorArtifactManagerVersion,
  type CreatorSkillDownloadGrant,
  type CreatorSkillSafetyStatus,
  type CreatorSkillUploadGrant,
  type CreateCreatorArtifactInput,
  type CreateCreatorArtifactVersionInput,
  type SkillArchivePolicy,
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
  CreatorArtifactCapabilitySchema,
  CreatorArtifactCatalogPageSchema,
  CreatorArtifactDetailSchema,
  CreatorArtifactMutationResponseSchema,
  CreatorArtifactVersionCreatedResponseSchema,
  CreatorArtifactVersionSchema,
  CreatorArtifactVersionMutationResponseSchema,
  CreatorSkillDownloadGrantSchema,
  CreatorSkillSafetyStatusSchema,
  CreatorSkillSafetyStatusBatchSchema,
  CreatorSkillUploadGrantSchema,
  SkillArchivePolicySchema,
  AppCatalogResponseSchema,
  AppReleaseDownloadSchema,
} from './schemas.ts';

const ADMIN_ERROR_CODES = new Set<AdminErrorCode>([
  'INVALID_CREDENTIALS',
  'ACCOUNT_DISABLED',
  'TOKEN_REVOKED',
  'TOKEN_EXPIRED',
  'INVALID_TOKEN',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'MEMBERSHIP_REMOVED',
  'MEMBERSHIP_SUSPENDED',
  'ORGANIZATION_UNAVAILABLE',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'SERVER_ERROR',
  'TIMEOUT',
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
  'creator_skill_feature_disabled',
  'creator_skill_upload_cancelled',
  'artifact_type_not_allowed',
  'artifact_not_found',
  'artifact_slug_conflict',
  'artifact_not_deletable',
  'version_not_deletable',
  'invalid_skill_archive',
  'skill_validation_failed',
  'archive_policy_exceeded',
  'version_conflict',
  'artifact_not_published',
  'artifact_version_revoked',
  'artifact_access_denied',
  'upload_expired',
  'checksum_mismatch',
  'content_digest_mismatch',
]);

const ADMIN_ERROR_CODE_ALIASES: Record<string, AdminErrorCode> = {
  account_disabled: 'ACCOUNT_DISABLED',
  forbidden: 'FORBIDDEN',
  invalid_token: 'INVALID_TOKEN',
  membership_removed: 'MEMBERSHIP_REMOVED',
  membership_suspended: 'MEMBERSHIP_SUSPENDED',
  not_found: 'NOT_FOUND',
  organization_unavailable: 'ORGANIZATION_UNAVAILABLE',
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
  MEMBERSHIP_REMOVED: 'Organization membership is no longer available',
  MEMBERSHIP_SUSPENDED: 'Organization membership is suspended',
  ORGANIZATION_UNAVAILABLE: 'Organization is no longer available',
  NOT_FOUND: 'Admin resource was not found',
  VALIDATION_ERROR: 'Admin request was rejected',
  SERVER_ERROR: 'Admin service is temporarily unavailable',
  TIMEOUT: 'Admin request timed out',
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
  creator_skill_feature_disabled: 'Creator Skill publishing and distribution are disabled',
  creator_skill_upload_cancelled: 'Creator Skill upload was cancelled',
  artifact_type_not_allowed: 'This artifact type is not allowed',
  artifact_not_found: 'Creator artifact was not found',
  artifact_slug_conflict: 'This Skill slug is already in use in the Creator Space',
  artifact_not_deletable: 'A published artifact can only be archived',
  version_not_deletable: 'Published and revoked versions cannot be deleted',
  invalid_skill_archive: 'The Skill ZIP is not valid',
  skill_validation_failed: 'SKILL.md validation failed',
  archive_policy_exceeded: 'The Skill ZIP exceeds the platform archive policy',
  version_conflict: 'The version must be higher than the latest published version',
  artifact_not_published: 'This Creator artifact is not published',
  artifact_version_revoked: 'This Creator Skill version has been revoked',
  artifact_access_denied: 'You do not have access to this Creator artifact',
  upload_expired: 'The upload address has expired',
  checksum_mismatch: 'The downloaded ZIP failed its checksum check',
  content_digest_mismatch: 'The extracted Skill content failed its integrity check',
};

const MAX_RETRY_AFTER_SECONDS = 86_400;
export const DEFAULT_ADMIN_REQUEST_TIMEOUT_MS = 15_000;

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
  private readonly requestTimeoutMs: number;

  constructor(adminUrl: string, options?: {
    tokenStore?: AdminClientTokenStore;
    requestTimeoutMs?: number;
  }) {
    const normalized = adminUrl.trim().replace(/\/+$/, '');
    if (!normalized) {
      throw new AdminError('Admin URL is required', 'VALIDATION_ERROR');
    }
    const requestTimeoutMs = options?.requestTimeoutMs
      ?? DEFAULT_ADMIN_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs <= 0
    ) {
      throw new AdminError(
        'Admin request timeout is invalid',
        'VALIDATION_ERROR',
      );
    }
    this.adminUrl = normalized;
    this.tokenStore = options?.tokenStore;
    this.requestTimeoutMs = requestTimeoutMs;
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

  async getAppCatalog(
    accessToken: string,
    organizationId: string,
    appConfigVersion?: string,
  ): Promise<AppCatalogFetchResult> {
    const query = new URLSearchParams();
    if (appConfigVersion) query.set('version', appConfigVersion);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const response = await this.request<unknown>(
      `/api/organizations/${encodeURIComponent(organizationId)}/apps${suffix}`,
      {
      method: 'GET',
      accessToken,
      allowNotModified: true,
      },
    );
    if (response === undefined) return { notModified: true };
    const catalog = this.readSuccessResponse(response, AppCatalogResponseSchema);
    if (catalog.apps.some(app => app.organizationId !== organizationId)) {
      throw new AdminError(
        'Admin app catalog contains an app from another organization',
        'SERVER_ERROR',
      );
    }
    return { notModified: false, ...catalog };
  }

  async getAppReleaseDownload(
    accessToken: string,
    organizationId: string,
    appId: string,
    releaseId: string,
  ): Promise<AppReleaseDownload> {
    const response = await this.request<unknown>(
      `/api/organizations/${encodeURIComponent(organizationId)}`
        + `/apps/${encodeURIComponent(appId)}`
        + `/releases/${encodeURIComponent(releaseId)}/download`,
      { method: 'POST', accessToken },
    );
    return this.readSuccessResponse(response, AppReleaseDownloadSchema);
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

  async getCreatorArtifactCapabilities(
    accessToken: string,
  ): Promise<CreatorArtifactCapability> {
    const response = await this.request<unknown>('/api/capabilities', {
      method: 'GET',
      accessToken,
    });
    return this.readSuccessResponse(response, CreatorArtifactCapabilitySchema);
  }

  async listCreatorArtifacts(
    accessToken: string,
    input: {
      organizationId: string;
      type?: 'web_app' | 'skill';
      includeDrafts?: boolean;
      cursor?: string;
    },
  ): Promise<CreatorArtifactCatalogPage> {
    const search = new URLSearchParams();
    if (input.type) search.set('type', input.type);
    if (input.includeDrafts) search.set('includeDrafts', 'true');
    if (input.cursor) search.set('cursor', input.cursor);
    search.set('capability', 'creatorSkillArtifacts');
    const response = await this.request<unknown>(
      `/api/organizations/${encodeURIComponent(input.organizationId)}/artifacts?${search}`,
      { method: 'GET', accessToken },
    );
    return this.readSuccessResponse(response, CreatorArtifactCatalogPageSchema);
  }

  async getCreatorArtifact(
    accessToken: string,
    organizationId: string,
    artifactId: string,
    version?: string,
    referencePath?: string,
  ): Promise<CreatorArtifactDetail> {
    const search = new URLSearchParams();
    if (version) search.set('version', version);
    if (referencePath) search.set('referencePath', referencePath);
    const suffix = search.size > 0 ? `?${search}` : '';
    const response = await this.request<unknown>(
      `/api/artifacts/${encodeURIComponent(artifactId)}${suffix}`,
      { method: 'GET', accessToken },
    );
    return this.readSuccessResponse(response, CreatorArtifactDetailSchema);
  }

  async createCreatorArtifact(
    accessToken: string,
    input: CreateCreatorArtifactInput,
  ): Promise<{ artifact: CreatorArtifact; replayed?: boolean }> {
    const response = await this.request<unknown>(
      `/api/organizations/${encodeURIComponent(input.organizationId)}/artifacts`,
      {
        method: 'POST',
        accessToken,
        headers: { 'Idempotency-Key': input.idempotencyKey },
        // The creator-artifact endpoint is the dedicated Skill creation
        // endpoint. `type` remains in the renderer/RPC DTO to make that
        // boundary explicit, but it is intentionally not serialized: POL-59
        // rejects unknown body fields with a strict schema.
        body: { slug: input.slug },
      },
    );
    return this.readSuccessResponse(response, CreatorArtifactMutationResponseSchema);
  }

  async deleteCreatorArtifactDraft(
    accessToken: string,
    organizationId: string,
    artifactId: string,
    idempotencyKey: string,
  ): Promise<{ artifact: CreatorArtifact; replayed?: boolean }> {
    const response = await this.request<unknown>(
      `/api/artifacts/${encodeURIComponent(artifactId)}`,
      {
        method: 'DELETE',
        accessToken,
        headers: { 'Idempotency-Key': idempotencyKey },
      },
    );
    return this.readSuccessResponse(response, CreatorArtifactMutationResponseSchema);
  }

  async createCreatorArtifactVersion(
    accessToken: string,
    input: CreateCreatorArtifactVersionInput,
  ): Promise<{
    version: CreatorArtifactManagerVersion;
    replayed?: boolean;
  }> {
    const response = await this.request<unknown>(
      `/api/artifacts/${encodeURIComponent(input.artifactId)}/versions`,
      {
        method: 'POST',
        accessToken,
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: {
          version: input.version,
          ...(input.changelog ? { changelog: input.changelog } : {}),
        },
      },
    );
    return this.readSuccessResponse(response, CreatorArtifactVersionCreatedResponseSchema);
  }

  async getCreatorSkillArchivePolicy(
    accessToken: string,
  ): Promise<SkillArchivePolicy> {
    const response = await this.request<unknown>('/api/artifact-policies/skill', {
      method: 'GET',
      accessToken,
    });
    return this.readSuccessResponse(response, SkillArchivePolicySchema);
  }

  async createCreatorSkillUploadGrant(
    accessToken: string,
    input: {
      organizationId: string;
      artifactId: string;
      version: string;
      sizeBytes: number;
      archiveChecksum: string;
      idempotencyKey: string;
    },
  ): Promise<CreatorSkillUploadGrant> {
    const response = await this.request<unknown>(
      `/api/artifacts/${encodeURIComponent(input.artifactId)}/versions/${encodeURIComponent(input.version)}/uploads`,
      {
        method: 'POST',
        accessToken,
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: {
          sizeBytes: input.sizeBytes,
          archiveChecksum: input.archiveChecksum,
        },
      },
    );
    return this.readSuccessResponse(response, CreatorSkillUploadGrantSchema);
  }

  async completeCreatorSkillUpload(
    accessToken: string,
    input: {
      organizationId: string;
      artifactId: string;
      version: string;
      uploadGeneration: number;
      sizeBytes: number;
      archiveChecksum: string;
      idempotencyKey: string;
    },
  ): Promise<CreatorArtifactManagerVersion> {
    const response = await this.request<unknown>(
      `/api/artifacts/${encodeURIComponent(input.artifactId)}/versions/${encodeURIComponent(input.version)}/upload-complete`,
      {
        method: 'POST',
        accessToken,
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: {
          uploadGeneration: input.uploadGeneration,
          sizeBytes: input.sizeBytes,
          archiveChecksum: input.archiveChecksum,
        },
      },
    );
    return this.readSuccessResponse(response, CreatorArtifactVersionSchema);
  }

  async triggerCreatorSkillValidation(
    accessToken: string,
    input: {
      artifactId: string;
      version: string;
    },
  ): Promise<CreatorArtifactManagerVersion> {
    const response = await this.request<unknown>(
      `/api/artifacts/${encodeURIComponent(input.artifactId)}/versions/${encodeURIComponent(input.version)}/validate`,
      {
        method: 'POST',
        accessToken,
      },
    );
    // POL-59 returns the validated artifact alongside the version and
    // validation diagnostics. The desktop transport keeps the version as its
    // stable operation result and deliberately strips the extra fields.
    return this.readSuccessResponse(
      response,
      CreatorArtifactVersionMutationResponseSchema,
    ).version;
  }

  async publishCreatorArtifactVersion(
    accessToken: string,
    input: {
      organizationId: string;
      artifactId: string;
      version: string;
      idempotencyKey: string;
    },
  ): Promise<{ version: CreatorArtifactManagerVersion; replayed?: boolean }> {
    const response = await this.request<unknown>(
      `/api/artifacts/${encodeURIComponent(input.artifactId)}/versions/${encodeURIComponent(input.version)}/publish`,
      {
        method: 'POST',
        accessToken,
        headers: { 'Idempotency-Key': input.idempotencyKey },
      },
    );
    return this.readSuccessResponse(response, CreatorArtifactVersionMutationResponseSchema);
  }

  async deleteCreatorArtifactVersionDraft(
    accessToken: string,
    input: {
      organizationId: string;
      artifactId: string;
      version: string;
      idempotencyKey: string;
    },
  ): Promise<{ version: CreatorArtifactManagerVersion; replayed?: boolean }> {
    const response = await this.request<unknown>(
      `/api/artifacts/${encodeURIComponent(input.artifactId)}/versions/${encodeURIComponent(input.version)}`,
      {
        method: 'DELETE',
        accessToken,
        headers: { 'Idempotency-Key': input.idempotencyKey },
      },
    );
    return this.readSuccessResponse(response, CreatorArtifactVersionMutationResponseSchema);
  }

  async setCreatorArtifactArchived(
    accessToken: string,
    input: {
      organizationId: string;
      artifactId: string;
      archived: boolean;
      idempotencyKey: string;
    },
  ): Promise<{ artifact: CreatorArtifact; replayed?: boolean }> {
    const action = input.archived ? 'archive' : 'restore';
    const response = await this.request<unknown>(
      `/api/artifacts/${encodeURIComponent(input.artifactId)}/${action}`,
      {
        method: 'POST',
        accessToken,
        headers: { 'Idempotency-Key': input.idempotencyKey },
      },
    );
    return this.readSuccessResponse(response, CreatorArtifactMutationResponseSchema);
  }

  async revokeCreatorArtifactVersion(
    accessToken: string,
    input: {
      organizationId: string;
      artifactId: string;
      version: string;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<{ version: CreatorArtifactManagerVersion; replayed?: boolean }> {
    const response = await this.request<unknown>(
      `/api/artifacts/${encodeURIComponent(input.artifactId)}/versions/${encodeURIComponent(input.version)}/revoke`,
      {
        method: 'POST',
        accessToken,
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: { reason: input.reason },
      },
    );
    return this.readSuccessResponse(response, CreatorArtifactVersionMutationResponseSchema);
  }

  async getCreatorSkillDownloadGrant(
    accessToken: string,
    input: {
      organizationId: string;
      artifactId: string;
      version: string;
    },
  ): Promise<CreatorSkillDownloadGrant> {
    const response = await this.request<unknown>(
      `/api/artifacts/${encodeURIComponent(input.artifactId)}/versions/${encodeURIComponent(input.version)}/download`,
      { method: 'POST', accessToken },
    );
    return this.readSuccessResponse(response, CreatorSkillDownloadGrantSchema);
  }

  async getCreatorSkillSafetyStatus(
    accessToken: string,
    input: {
      artifactId: string;
      version: string;
      archiveChecksum: string;
    },
  ): Promise<CreatorSkillSafetyStatus> {
    const canonicalChecksum = input.archiveChecksum.toLowerCase().replace(/^sha256:/, '');
    const response = await this.request<unknown>('/api/installed-artifacts/status', {
      method: 'POST',
      accessToken,
      body: {
        identities: [{
          ...input,
          archiveChecksum: `sha256:${canonicalChecksum}`,
        }],
      },
    });
    const batch = this.readSuccessResponse(response, CreatorSkillSafetyStatusBatchSchema);
    if (batch.statuses.length !== 1) {
      throw new AdminError('Admin response is invalid', 'SERVER_ERROR');
    }
    const status = CreatorSkillSafetyStatusSchema.parse(batch.statuses[0]);
    if (
      status.artifactId !== input.artifactId
      || status.version !== input.version
      || status.archiveChecksum !== canonicalChecksum
    ) throw new AdminError('Admin response is invalid', 'SERVER_ERROR');
    return status;
  }

  private async request<T>(path: string, options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    accessToken?: string;
    body?: unknown;
    headers?: Record<string, string>;
    retryingAfterRefresh?: boolean;
    allowNotModified?: boolean;
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

    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new AdminError(
      'Admin request timed out',
      'TIMEOUT',
    );
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError);
        reject(timeoutError);
      }, this.requestTimeoutMs);
    });

    let response: Response | undefined;
    let data: unknown;
    try {
      ({ response, data } = await Promise.race([
        (async () => {
          const fetchedResponse = await fetch(`${this.adminUrl}${path}`, {
            method: options.method,
            headers,
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
          });
          // Preserve a definitive authorization status as soon as the response
          // headers arrive. The body remains deadline-bounded, but a half-open
          // 401/403 body must not be reclassified as a transport timeout.
          response = fetchedResponse;
          return {
            response: fetchedResponse,
            data: await this.readJson(fetchedResponse),
          };
        })(),
        timeoutPromise,
      ]));
    } catch (error) {
      if (response?.status === 401 || response?.status === 403) {
        data = undefined;
      } else {
        if (timedOut || error === timeoutError) throw timeoutError;
        throw new AdminError('Failed to reach admin server', 'NETWORK_ERROR', { cause: error });
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (!response) {
      throw new AdminError('Failed to reach admin server', 'NETWORK_ERROR');
    }

    if (response.status === 304 && options.allowNotModified) {
      return undefined as T;
    }

    if (
      response.status === 401 &&
      options.accessToken &&
      !options.retryingAfterRefresh &&
      path !== '/api/auth/refresh' &&
      this.tokenStore
    ) {
      const refreshToken = await this.tokenStore.getRefreshToken();
      if (refreshToken) {
        const originalAuthenticationError = this.createError(response, data);
        let refreshed: AdminRefreshResponse;
        try {
          refreshed = await this.refresh(refreshToken);
          await this.tokenStore.onTokensRefreshed?.(refreshed);
        } catch {
          // A protected endpoint has already provided a definitive
          // authentication result. A refresh transport/service failure must
          // not overwrite that 401 and turn it into restricted offline access.
          throw originalAuthenticationError;
        }
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
