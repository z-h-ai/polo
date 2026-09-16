/**
 * Credential Backend Interface
 *
 * All credential storage backends must implement this interface.
 * Backends are tried in priority order until one succeeds.
 */

import type { CredentialId, StoredCredential } from '../types.ts';

export interface CredentialCompareAndSwapResult {
  updated: boolean;
  current: StoredCredential | null;
}

export interface CredentialBackend {
  /** Backend name for logging/debugging */
  readonly name: string;

  /** Priority (higher = tried first) */
  readonly priority: number;

  /** Check if this backend is available on the current platform */
  isAvailable(): Promise<boolean>;

  /** Get a credential by ID */
  get(id: CredentialId): Promise<StoredCredential | null>;

  /** Re-read a credential from durable storage, bypassing process-local cache. */
  getFresh?(id: CredentialId): Promise<StoredCredential | null>;

  /** Set/update a credential */
  set(id: CredentialId, credential: StoredCredential): Promise<void>;

  /** Atomically replace/delete a credential only if its token identity matches. */
  compareAndSwap?(
    id: CredentialId,
    expected: Pick<StoredCredential, 'value' | 'refreshToken'>,
    replacement: StoredCredential | null,
  ): Promise<CredentialCompareAndSwapResult>;

  /** Run an operation under a cross-process, scope-specific lease. */
  withExclusiveLease?<T>(scope: string, operation: () => Promise<T>): Promise<T>;

  /** Delete a credential */
  delete(id: CredentialId): Promise<boolean>;

  /** Delete a credential synchronously, when supported by the backend. */
  deleteSync?(id: CredentialId): boolean;

  /** List all credentials (optionally filtered by partial ID) */
  list(filter?: Partial<CredentialId>): Promise<CredentialId[]>;
}
