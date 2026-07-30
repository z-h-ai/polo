import type { LlmConnection } from '../config/llm-connections.ts';
import type {
  LocalAppArchitecture,
  LocalAppPlatform,
  LocalAppRuntimeKind,
} from '../protocol/local-apps.ts';

export interface AdminUser {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
  groupIds: string[];
}

export interface AdminLoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AdminUser;
}

export interface AdminAuthConfig {
  phoneAuthEnabled: boolean;
}

export interface AdminPhoneAuthChallengeConfig {
  type: 'browser_redirect';
  issuerUrl: string;
}

export interface SendPhoneAuthCodeInput {
  phone: string;
  challengeToken: string;
}

export interface SendPhoneAuthCodeResponse {
  accepted: boolean;
  expiresIn: number;
  resendAfter: number;
}

export interface VerifyPhoneAuthCodeInput {
  phone: string;
  code: string;
}

export interface AdminPhoneAuthResponse extends AdminLoginResponse {
  isNewUser: boolean;
}

export interface SetAdminPasswordInput {
  password: string;
}

export interface SetAdminPasswordResponse {
  success: boolean;
}

export interface AdminRefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type AdminValidateResponse =
  | {
      valid: true;
      user: AdminUser;
      configVersion: string;
    }
  | {
      valid: false;
    };

export interface AdminLlmConnection extends LlmConnection {
  endpoint?: string;
  apiKey?: string | AdminTransitEncryptedApiKey;
  key?: string;
  credentials?: {
    apiKey?: string | AdminTransitEncryptedApiKey;
    key?: string;
  };
}

export interface AdminTransitEncryptedApiKey {
  alg: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface AdminLlmConnectionsResponse {
  configVersion: string;
  connections: AdminLlmConnection[];
  defaultConnection: string | null;
}

export type OrganizationType = 'enterprise_workspace' | 'creator_space';
export type OrganizationRole = 'owner' | 'manager' | 'member';
export type OrganizationStatus = 'active' | 'suspended';
export type OrganizationMembershipStatus = 'active' | 'suspended' | 'removed';
export type OrganizationJoinStatus =
  | 'active'
  | 'cancelled'
  | 'revoked'
  | 'expired'
  | 'exhausted'
  | 'unavailable';

export interface Organization {
  id: string;
  type: OrganizationType;
  name: string;
  purpose: string;
  visibility?: 'private';
  status?: OrganizationStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrganizationMembership {
  id: string;
  organizationId?: string;
  userId?: string;
  role: OrganizationRole;
  status: OrganizationMembershipStatus;
  joinedAt?: string;
  updatedAt?: string;
}

export interface OrganizationSummary extends Organization {
  membership: OrganizationMembership;
  memberCount: number;
}

export interface CreateOrganizationInput {
  type: OrganizationType;
  name: string;
  purpose: string;
  idempotencyKey: string;
}

export interface CreateOrganizationResponse {
  organization: Organization;
  membership: OrganizationMembership;
  replayed: boolean;
}

export interface ListOrganizationsResponse {
  organizations: OrganizationSummary[];
}

export type CatalogAppDeliveryMode = 'remote_url' | 'local_bundle';

export interface AppReleaseSummary {
  version: string;
  runtime: LocalAppRuntimeKind;
  downloadUrl: string;
  checksum: string;
  sizeBytes: number;
  platform?: LocalAppPlatform;
  arch?: LocalAppArchitecture;
}

export interface CatalogApp {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  iconUrl?: string;
  creatorName?: string;
  deliveryMode: CatalogAppDeliveryMode;
  remoteUrl?: string;
  currentRelease?: AppReleaseSummary;
  permissions?: string[];
  sortOrder: number;
  /**
   * Added locally when an app disappears from a refreshed catalog. Retaining
   * the lightweight metadata lets the client explain why an installed app can
   * no longer be launched without silently deleting it.
   */
  availability?: 'available' | 'withdrawn';
}

export interface AppCatalogResponse {
  appConfigVersion: string;
  apps: CatalogApp[];
}

export type AppCatalogFetchResult =
  | { notModified: true }
  | ({ notModified: false } & AppCatalogResponse);

export interface AppCatalogCacheEntry extends AppCatalogResponse {
  accountId: string;
  organizationId: string;
  syncedAt: number;
}

export type AppCatalogSyncResult =
  | {
      success: true;
      catalog: AppCatalogCacheEntry;
      source: 'network' | 'cache';
      refreshed: boolean;
      warning?: string;
    }
  | {
      success: false;
      errorCode: string;
      message: string;
      status?: number;
    };

export interface OrganizationJoinPreview {
  organization: Organization;
  join: {
    kind: 'invitation' | 'join_link';
    effectiveStatus: OrganizationJoinStatus;
    expiresAt: string | null;
    usesRemaining: number | null;
    requiresPhoneMatch: boolean;
  };
}

export interface AcceptOrganizationJoinResponse {
  membership: OrganizationMembership & {
    organizationId: string;
    userId: string;
  };
  replayed: boolean;
}

export interface OrganizationMember {
  id: string;
  role: OrganizationRole;
  status: Exclude<OrganizationMembershipStatus, 'removed'>;
  joinedAt: string;
  updatedAt: string;
  user: {
    id: string;
    username: string;
    displayName: string | null;
    phone?: string | null;
  };
}

export interface OrganizationInvitation {
  id: string;
  targetPhone: string | null;
  status: string;
  effectiveStatus: Exclude<OrganizationJoinStatus, 'revoked' | 'unavailable'>;
  maxUses: number;
  useCount: number;
  expiresAt: string;
  cancelledAt?: string | null;
  createdAt: string;
  createdByUserId?: string;
}

export interface CreateOrganizationInvitationInput {
  targetPhone?: string;
  expiresAt?: string;
  maxUses?: number;
}

export interface CreateOrganizationInvitationResponse {
  invitation: OrganizationInvitation;
  token: string;
}

export interface OrganizationJoinLink {
  id: string;
  status: string;
  effectiveStatus?: OrganizationJoinStatus;
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  createdAt?: string;
  revokedAt?: string | null;
}

export interface CreateOrganizationJoinLinkInput {
  expiresAt?: string | null;
  maxUses?: number | null;
}

export interface CreateOrganizationJoinLinkResponse {
  joinLink: OrganizationJoinLink;
  token: string;
}

export interface UpdateOrganizationMemberInput {
  role?: 'manager' | 'member';
  status?: 'active' | 'suspended';
  reason?: string;
}

export type PhoneAuthErrorCode =
  | 'phone_auth_disabled'
  | 'invalid_phone'
  | 'verification_code_invalid'
  | 'verification_code_expired'
  | 'verification_attempts_exceeded'
  | 'phone_not_registered'
  | 'sms_rate_limited'
  | 'sms_send_failed'
  | 'phone_auth_configuration_error'
  | 'invalid_credentials';

export type AdminErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_DISABLED'
  | 'TOKEN_REVOKED'
  | 'TOKEN_EXPIRED'
  | 'INVALID_TOKEN'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR'
  | 'idempotency_conflict'
  | 'join_link_not_allowed'
  | 'join_token_invalid'
  | 'join_token_cancelled'
  | 'join_token_expired'
  | 'join_token_exhausted'
  | 'phone_mismatch'
  | 'last_owner_required'
  | 'duplicate_request'
  | PhoneAuthErrorCode;

export interface AdminErrorDetails {
  retryAfter?: number;
}

export class AdminError extends Error {
  readonly errorCode: AdminErrorCode;
  readonly status?: number;
  readonly details?: AdminErrorDetails;

  constructor(message: string, errorCode: AdminErrorCode, options?: {
    status?: number;
    details?: AdminErrorDetails;
    cause?: unknown;
  }) {
    super(message, { cause: options?.cause });
    this.name = 'AdminError';
    this.errorCode = errorCode;
    this.status = options?.status;
    this.details = options?.details;
  }
}
