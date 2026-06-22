import type { LlmConnection } from '../config/llm-connections.ts';

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  groupIds: string[];
}

export interface AdminLoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AdminUser;
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
  | 'UNKNOWN_ERROR';

export class AdminError extends Error {
  readonly errorCode: AdminErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(message: string, errorCode: AdminErrorCode, options?: {
    status?: number;
    details?: unknown;
    cause?: unknown;
  }) {
    super(message, { cause: options?.cause });
    this.name = 'AdminError';
    this.errorCode = errorCode;
    this.status = options?.status;
    this.details = options?.details;
  }
}
