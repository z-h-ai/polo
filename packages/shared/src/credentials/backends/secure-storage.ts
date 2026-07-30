/**
 * Secure Storage Backend
 *
 * Stores credentials in an encrypted file under CONFIG_DIR.
 * Uses AES-256-GCM for authenticated encryption.
 *
 * Encryption key is derived from OS-native hardware UUID using PBKDF2:
 * - macOS: IOPlatformUUID (tied to logic board, never changes)
 * - Windows: MachineGuid from registry (set at OS install)
 * - Linux: /var/lib/dbus/machine-id (set at OS install)
 *
 * This is more stable than the previous hostname-based derivation, which could
 * change with network/DHCP. Legacy key derivation is migrated within the same
 * instance file on first successful load.
 *
 * File format:
 *   [Header - 64 bytes]
 *   ├── Magic: "POLOAI1\0" (8 bytes)
 *   ├── Flags: uint32 LE (4 bytes) - reserved for future use
 *   ├── Salt: 32 bytes (PBKDF2 salt)
 *   ├── Reserved: 20 bytes
 *   [Encrypted Payload]
 *   ├── IV: 12 bytes (random per write)
 *   ├── Auth Tag: 16 bytes (GCM authentication)
 *   └── Ciphertext: variable (encrypted JSON)
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createHash,
} from 'crypto';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { open, stat, unlink } from 'node:fs/promises';
import { hostname, userInfo, homedir } from 'os';
import { join } from 'path';

import type { CredentialBackend } from './types.ts';
import type { CredentialId, StoredCredential } from '../types.ts';
import { credentialIdToAccount, accountToCredentialId } from '../types.ts';
import { CONFIG_DIR } from '../../config/paths.ts';

const DEFAULT_CREDENTIALS_DIR = join(homedir(), '.polo-ai');

// File format constants
const MAGIC_BYTES = Buffer.from('POLOAI1\0');
const HEADER_SIZE = 64;
const MAGIC_SIZE = 8;
const FLAGS_SIZE = 4;
const SALT_SIZE = 32;
const IV_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const KEY_SIZE = 32;

// PBKDF2 iterations (balance security vs startup time)
const PBKDF2_ITERATIONS = 100000;

/**
 * Get stable machine identifier using OS-native hardware UUID.
 * This is far more stable than hostname which can change with network/DHCP.
 * Falls back to username + homedir if hardware UUID unavailable.
 */
function getStableMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      // macOS: IOPlatformUUID - tied to logic board, never changes
      const output = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } else if (process.platform === 'win32') {
      // Windows: MachineGuid from registry - set at OS install
      const output = execSync(
        'reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match?.[1]) return match[1];
    } else {
      // Linux: dbus machine-id - set at OS install
      const machineIdPath = '/var/lib/dbus/machine-id';
      const altPath = '/etc/machine-id';
      if (existsSync(machineIdPath)) {
        return readFileSync(machineIdPath, 'utf-8').trim();
      } else if (existsSync(altPath)) {
        return readFileSync(altPath, 'utf-8').trim();
      }
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: username + homedir (stable enough for most cases)
  return `${userInfo().username}:${homedir()}`;
}

/** Internal credential store structure */
interface CredentialStore {
  version: 1;
  credentials: Record<string, StoredCredential>;
  metadata: {
    createdAt: number;
    updatedAt: number;
  };
}

export interface SecureStorageBackendOptions {
  /** Override used by isolated instances and tests. Defaults to CONFIG_DIR. */
  credentialsDir?: string;
  /**
   * Pre-CONFIG_DIR location used only by an explicitly trusted host migration.
   * Merely choosing a custom profile never reads credentials from this path.
   */
  legacyCredentialsDir?: string;
  /**
   * Explicit, host-only upgrade switch for copying a legacy fixed-path store
   * into an empty instance. Defaults to false and is not exposed over RPC or
   * Preload.
   */
  allowLegacyPathMigration?: boolean;
}

export class SecureStorageBackend implements CredentialBackend {
  readonly name = 'secure-storage';
  readonly priority = 100;

  private readonly credentialsDir: string;
  private readonly credentialsFile: string;
  private readonly writeLockFile: string;
  private readonly legacyCredentialsFile: string;
  private readonly allowLegacyPathMigration: boolean;
  private cachedStore: CredentialStore | null = null;
  private encryptionKey: Buffer | null = null;
  private salt: Buffer | null = null;

  constructor(options: SecureStorageBackendOptions = {}) {
    this.credentialsDir = options.credentialsDir
      ?? process.env.POLO_AI_SHARED_CREDENTIALS_DIR
      ?? CONFIG_DIR;
    this.credentialsFile = join(this.credentialsDir, 'credentials.enc');
    this.writeLockFile = join(this.credentialsDir, '.credentials.write.lock');
    this.legacyCredentialsFile = join(
      options.legacyCredentialsDir ?? DEFAULT_CREDENTIALS_DIR,
      'credentials.enc',
    );
    this.allowLegacyPathMigration = options.allowLegacyPathMigration === true;
  }

  async isAvailable(): Promise<boolean> {
    // File backend is always available - we can always write to filesystem
    return true;
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const store = await this.loadStore();
    if (!store) return null;

    const key = credentialIdToAccount(id);
    return store.credentials[key] || null;
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    await this.withWriteLock(async () => {
      // Re-read after acquiring the cross-process lock so an OAuth refresh
      // cannot overwrite a credential update made by Electron or another CLI.
      this.cachedStore = null;
      let store = await this.loadStore();
      if (!store) {
        store = {
          version: 1,
          credentials: {},
          metadata: {
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        };
      }

      const key = credentialIdToAccount(id);
      store.credentials[key] = credential;
      store.metadata.updatedAt = Date.now();
      await this.saveStore(store);
    });
  }

  async delete(id: CredentialId): Promise<boolean> {
    return this.withWriteLock(async () => {
      this.cachedStore = null;
      const store = await this.loadStore();
      if (!store) return false;
      const key = credentialIdToAccount(id);
      if (!(key in store.credentials)) return false;
      delete store.credentials[key];
      store.metadata.updatedAt = Date.now();
      await this.saveStore(store);
      return true;
    });
  }

  deleteSync(id: CredentialId): boolean {
    const store = this.loadStoreSync();
    if (!store) return false;

    const key = credentialIdToAccount(id);
    if (!(key in store.credentials)) return false;

    delete store.credentials[key];
    store.metadata.updatedAt = Date.now();

    this.saveStoreSync(store);
    return true;
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const store = await this.loadStore();
    if (!store) return [];

    const ids = Object.keys(store.credentials)
      .map(accountToCredentialId)
      .filter((id): id is CredentialId => id !== null);

    if (!filter) return ids;

    return ids.filter((id) => {
      if (filter.type && id.type !== filter.type) return false;
      if (filter.workspaceId && id.workspaceId !== filter.workspaceId) return false;
      if (filter.name && id.name !== filter.name) return false;
      return true;
    });
  }

  // ============================================================
  // Private Methods
  // ============================================================

  private async loadStore(): Promise<CredentialStore | null> {
    return this.loadStoreSync();
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!existsSync(this.credentialsDir)) {
      mkdirSync(this.credentialsDir, { recursive: true, mode: 0o700 });
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        handle = await open(this.writeLockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const info = await stat(this.writeLockFile).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 30_000) {
          await unlink(this.writeLockFile).catch(() => {});
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }

    if (!handle) throw new Error('Timed out acquiring shared credential write lock');
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      await unlink(this.writeLockFile).catch(() => {});
    }
  }

  private loadStoreSync(): CredentialStore | null {
    // Return cached store if available
    if (this.cachedStore) return this.cachedStore;

    const instanceFileExists = existsSync(this.credentialsFile);
    if (instanceFileExists) {
      return this.loadStoreFromFile(this.credentialsFile, true);
    }

    // Profile isolation is the default. A trusted host may explicitly perform
    // the one-time fixed-path upgrade only while the instance has no file of
    // its own. Never overwrite an existing instance and never mutate/delete
    // the legacy source.
    if (
      this.allowLegacyPathMigration &&
      this.credentialsFile !== this.legacyCredentialsFile
      && existsSync(this.legacyCredentialsFile)
    ) {
      const legacyStore = this.loadStoreFromFile(
        this.legacyCredentialsFile,
        false,
      );
      if (legacyStore) {
        this.saveStoreSync(legacyStore);
        return legacyStore;
      }
    }

    return null;
  }

  private loadStoreFromFile(
    filePath: string,
    deleteIfCorrupted: boolean,
  ): CredentialStore | null {
    let fileData: Buffer;
    try {
      fileData = readFileSync(filePath);
    } catch {
      return null;
    }

    // Validate minimum size
    if (fileData.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) {
      this.resetFailedLoad(filePath, deleteIfCorrupted);
      return null;
    }

    // Validate magic bytes
    if (!fileData.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
      this.resetFailedLoad(filePath, deleteIfCorrupted);
      return null;
    }

    // Parse header
    // const flags = fileData.readUInt32LE(MAGIC_SIZE); // Reserved for future use
    const salt = fileData.subarray(MAGIC_SIZE + FLAGS_SIZE, MAGIC_SIZE + FLAGS_SIZE + SALT_SIZE);
    this.salt = salt;

    // Extract encrypted data
    const encryptedData = fileData.subarray(HEADER_SIZE);

    // Try new stable key first (v2 - hardware UUID based)
    const newKey = this.getEncryptionKey(salt);
    let store = this.tryDecrypt(encryptedData, newKey);

    if (store) {
      this.cachedStore = store;
      return store;
    }

    // Try legacy key for migration (v1 - included hostname)
    // This handles credentials encrypted with old key derivation
    const legacyKey = this.getLegacyEncryptionKey(salt);
    store = this.tryDecrypt(encryptedData, legacyKey);

    if (store) {
      // Migration: re-save with new stable key so future loads use hardware UUID
      this.cachedStore = store;
      this.saveStoreSync(store);
      return store;
    }

    // Both keys failed - the selected file is truly corrupted.
    this.resetFailedLoad(filePath, deleteIfCorrupted);
    return null;
  }

  /**
   * Attempt to decrypt data with given key.
   * Returns parsed store on success, null on failure.
   */
  private tryDecrypt(encryptedData: Buffer, key: Buffer): CredentialStore | null {
    try {
      const iv = encryptedData.subarray(0, IV_SIZE);
      const authTag = encryptedData.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
      const ciphertext = encryptedData.subarray(IV_SIZE + AUTH_TAG_SIZE);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch {
      return null;
    }
  }

  private async saveStore(store: CredentialStore): Promise<void> {
    this.saveStoreSync(store);
  }

  private saveStoreSync(store: CredentialStore): void {
    // Ensure directory exists
    if (!existsSync(this.credentialsDir)) {
      mkdirSync(this.credentialsDir, { recursive: true, mode: 0o700 });
    }

    // Use existing salt or generate new one
    const salt = this.salt || randomBytes(SALT_SIZE);
    this.salt = salt;

    // Get encryption key
    const key = this.getEncryptionKey(salt);

    // Serialize payload
    const plaintext = Buffer.from(JSON.stringify(store), 'utf8');

    // Generate new IV for each write (critical for GCM security)
    const iv = randomBytes(IV_SIZE);

    // Encrypt
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Build header
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC_BYTES.copy(header, 0);
    header.writeUInt32LE(0, MAGIC_SIZE); // Flags (reserved)
    salt.copy(header, MAGIC_SIZE + FLAGS_SIZE);

    // Combine all parts
    const fileData = Buffer.concat([header, iv, authTag, ciphertext]);

    // Write with restrictive permissions (owner read/write only)
    writeFileSync(this.credentialsFile, fileData, { mode: 0o600 });
    this.cachedStore = store;
  }

  private getEncryptionKey(salt: Buffer): Buffer {
    if (this.encryptionKey) return this.encryptionKey;

    // New stable machine ID using hardware UUID (v2)
    // This is far more stable than hostname which can change with network/DHCP
    const stableMachineId = createHash('sha256')
      .update(getStableMachineId())
      .update('polo-ai-v2') // Bumped version for new key derivation
      .digest();

    // Derive key using PBKDF2
    this.encryptionKey = pbkdf2Sync(stableMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');

    return this.encryptionKey;
  }

  /**
   * Legacy key derivation for migration from v1 (included hostname).
   * Used to decrypt credentials from older versions before re-encrypting with stable key.
   */
  private getLegacyEncryptionKey(salt: Buffer): Buffer {
    const legacyMachineId = createHash('sha256')
      .update(hostname())
      .update(userInfo().username)
      .update(homedir())
      .update('polo-ai-v1')
      .digest();

    return pbkdf2Sync(legacyMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
  }

  private resetFailedLoad(filePath: string, deleteIfCorrupted: boolean): void {
    // Delete only a corrupted instance-owned file. A legacy fallback is a
    // shared compatibility source and must remain untouched.
    try {
      if (deleteIfCorrupted && existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // Ignore deletion errors
    }
    this.cachedStore = null;
    this.encryptionKey = null;
    this.salt = null;
  }

  /** Clear cached data (for testing or forced refresh) */
  clearCache(): void {
    this.cachedStore = null;
    this.encryptionKey = null;
    this.salt = null;
  }
}
