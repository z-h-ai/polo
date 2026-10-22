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

/**
 * Discriminative presence inspection (startup restore): `absent` means the
 * credential was confirmed not to exist; `found` means it exists and is
 * structurally usable; `unreadable_or_invalid` means something is there but
 * it could not be read, decrypted or validated — callers must fail closed
 * instead of treating it as absent.
 */
export type CredentialPresenceStatus =
  | { status: 'absent' }
  | { status: 'found' }
  | { status: 'unreadable_or_invalid'; reason: string };

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

  /**
   * Discriminative presence inspection. Optional: a manager whose backends
   * all lack this method cannot confirm absence and fails closed with
   * `unreadable_or_invalid` (never `absent`).
   */
  inspectCredentialPresence?(
    id: CredentialId,
  ): Promise<CredentialPresenceStatus>;

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
