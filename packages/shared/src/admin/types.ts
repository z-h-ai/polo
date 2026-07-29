import type { LlmConnection } from '../config/llm-connections.ts';

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

export interface AdminValidateResponse {
  valid: boolean;
  user: AdminUser;
  configVersion: string;
}

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
