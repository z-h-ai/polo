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
 * instance file on the next successful locked mutation.
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
  randomUUID,
  pbkdf2Sync,
  createHash,
} from 'crypto';
import { execSync } from 'child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { hostname, userInfo, homedir } from 'os';
import { join } from 'path';

import type { CredentialBackend, CredentialCompareAndSwapResult } from './types.ts';
import type { CredentialId, StoredCredential } from '../types.ts';
import { credentialIdToAccount, accountToCredentialId } from '../types.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import { getProcessBirthIdentity } from '../../utils/process-identity.ts';

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
const WRITE_LOCK_TIMEOUT_MS = 5_000;
const WRITE_LOCK_RETRY_MS = 25;
const WRITE_LOCK_OWNER_GRACE_MS = 30_000;
const WRITE_LOCK_HEARTBEAT_MS = 5_000;

interface CredentialWriteLockOwner {
  version: 1;
  lockId: string;
  pid: number;
  processIdentity: string;
  createdAt: number;
  heartbeatAt: number;
}

export interface CredentialWriteLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  ownerGraceMs?: number;
  heartbeatMs?: number;
}

export interface CredentialWriteLockHandle {
  readonly owner: CredentialWriteLockOwner;
  release(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownerIsDefinitelyGone(owner: CredentialWriteLockOwner): boolean {
  if (!isProcessAlive(owner.pid)) return true;
  const currentIdentity = getProcessBirthIdentity(owner.pid);
  // A non-null mismatch proves PID reuse. If identity lookup is unavailable,
  // fail closed and leave the apparently live owner in place.
  return currentIdentity !== null && currentIdentity !== owner.processIdentity;
}

function parseWriteLockOwner(value: string): CredentialWriteLockOwner | null {
  try {
    const parsed = JSON.parse(value) as Partial<CredentialWriteLockOwner>;
    if (
      parsed.version !== 1
      || typeof parsed.lockId !== 'string'
      || !parsed.lockId
      || !Number.isInteger(parsed.pid)
      || (parsed.pid ?? 0) <= 0
      || typeof parsed.processIdentity !== 'string'
      || !parsed.processIdentity
      || typeof parsed.createdAt !== 'number'
      || typeof parsed.heartbeatAt !== 'number'
    ) return null;
    return parsed as CredentialWriteLockOwner;
  } catch {
    return null;
  }
}

async function readWriteLockOwner(lockDirectory: string): Promise<CredentialWriteLockOwner | null> {
  const value = await readFile(join(lockDirectory, 'owner.json'), 'utf8').catch(() => null);
  return value === null ? null : parseWriteLockOwner(value);
}

async function writeWriteLockOwner(
  lockDirectory: string,
  owner: CredentialWriteLockOwner,
): Promise<void> {
  const ownerFile = join(lockDirectory, 'owner.json');
  const temporaryFile = join(lockDirectory, `.owner.${owner.lockId}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryFile, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(owner));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryFile, ownerFile);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }
}

async function moveAbandonedWriteLock(lockDirectory: string): Promise<boolean> {
  const abandoned = `${lockDirectory}.abandoned.${randomUUID()}`;
  try {
    await rename(lockDirectory, abandoned);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return false;
    }
    throw error;
  }
  await rm(abandoned, { recursive: true, force: true });
  return true;
}

/**
 * Cross-process credential writer lock. A live process is never evicted merely
 * because wall time advanced (for example during system sleep).
 */
export async function acquireCredentialWriteLock(
  lockDirectory: string,
  options: CredentialWriteLockOptions = {},
): Promise<CredentialWriteLockHandle> {
  const timeoutMs = options.timeoutMs ?? WRITE_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? WRITE_LOCK_RETRY_MS;
  const ownerGraceMs = options.ownerGraceMs ?? WRITE_LOCK_OWNER_GRACE_MS;
  const heartbeatMs = options.heartbeatMs ?? WRITE_LOCK_HEARTBEAT_MS;
  const processIdentity = getProcessBirthIdentity(process.pid);
  if (!processIdentity) {
    throw new Error(`Could not verify credential writer process identity for pid ${process.pid}`);
  }
  const owner: CredentialWriteLockOwner = {
    version: 1,
    lockId: randomUUID(),
    pid: process.pid,
    processIdentity,
    createdAt: Date.now(),
    heartbeatAt: Date.now(),
  };
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      try {
        await writeWriteLockOwner(lockDirectory, owner);
      } catch (error) {
        await rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const observed = await readWriteLockOwner(lockDirectory);
      let canTakeOver = observed ? ownerIsDefinitelyGone(observed) : false;
      if (!observed) {
        const info = await stat(lockDirectory).catch(() => null);
        canTakeOver = !!info && Date.now() - info.mtimeMs > ownerGraceMs;
      }
      if (canTakeOver && await moveAbandonedWriteLock(lockDirectory)) continue;
      if (Date.now() >= deadline) {
        throw new Error('Timed out acquiring shared credential write lock');
      }
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
  }

  let active = true;
  let heartbeatWrite = Promise.resolve();
  const heartbeat = setInterval(() => {
    if (!active) return;
    owner.heartbeatAt = Date.now();
    heartbeatWrite = heartbeatWrite
      .then(() => writeWriteLockOwner(lockDirectory, owner))
      .catch(() => {});
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    owner,
    async release(): Promise<void> {
      if (!active) return;
      active = false;
      clearInterval(heartbeat);
      await heartbeatWrite;
      const observed = await readWriteLockOwner(lockDirectory);
      if (observed?.lockId !== owner.lockId) return;
      await rm(lockDirectory, { recursive: true, force: true });
    },
  };
}

function acquireCredentialWriteLockSync(lockDirectory: string): () => void {
  const processIdentity = getProcessBirthIdentity(process.pid);
  if (!processIdentity) {
    throw new Error(`Could not verify credential writer process identity for pid ${process.pid}`);
  }
  const owner: CredentialWriteLockOwner = {
    version: 1,
    lockId: randomUUID(),
    pid: process.pid,
    processIdentity,
    createdAt: Date.now(),
    heartbeatAt: Date.now(),
  };
  const deadline = Date.now() + WRITE_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockDirectory, { mode: 0o700 });
      try {
        writeFileSync(join(lockDirectory, 'owner.json'), JSON.stringify(owner), {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        rmSync(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let observed: CredentialWriteLockOwner | null = null;
      try {
        observed = parseWriteLockOwner(readFileSync(join(lockDirectory, 'owner.json'), 'utf8'));
      } catch {}
      let canTakeOver = observed ? ownerIsDefinitelyGone(observed) : false;
      if (!observed) {
        try {
          canTakeOver = Date.now() - statSync(lockDirectory).mtimeMs > WRITE_LOCK_OWNER_GRACE_MS;
        } catch {}
      }
      if (canTakeOver) {
        const abandoned = `${lockDirectory}.abandoned.${randomUUID()}`;
        try {
          renameSync(lockDirectory, abandoned);
          rmSync(abandoned, { recursive: true, force: true });
          continue;
        } catch {}
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out acquiring shared credential write lock');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WRITE_LOCK_RETRY_MS);
    }
  }

  return () => {
    let observed: CredentialWriteLockOwner | null = null;
    try {
      observed = parseWriteLockOwner(readFileSync(join(lockDirectory, 'owner.json'), 'utf8'));
    } catch {}
    if (observed?.lockId === owner.lockId) {
      rmSync(lockDirectory, { recursive: true, force: true });
    }
  };
}

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
  /** Fault-injection hook used by atomic-write regression tests. */
  beforeAtomicRename?: (temporaryFile: string, destinationFile: string) => void;
  /** Shortened lock timing used only by isolated concurrency tests. */
  writeLockOptions?: CredentialWriteLockOptions;
}

export class SecureStorageBackend implements CredentialBackend {
  readonly name = 'secure-storage';
  readonly priority = 100;

  private readonly credentialsDir: string;
  private readonly credentialsFile: string;
  private readonly writeLockDirectory: string;
  private readonly legacyCredentialsFile: string;
  private readonly allowLegacyPathMigration: boolean;
  private readonly beforeAtomicRename?: (temporaryFile: string, destinationFile: string) => void;
  private readonly writeLockOptions: CredentialWriteLockOptions;
  private cachedStore: CredentialStore | null = null;
  private encryptionKey: Buffer | null = null;
  private salt: Buffer | null = null;

  constructor(options: SecureStorageBackendOptions = {}) {
    this.credentialsDir = options.credentialsDir
      ?? process.env.POLO_AI_SHARED_CREDENTIALS_DIR
      ?? CONFIG_DIR;
    this.credentialsFile = join(this.credentialsDir, 'credentials.enc');
    this.writeLockDirectory = join(this.credentialsDir, '.credentials.write.lock');
    this.legacyCredentialsFile = join(
      options.legacyCredentialsDir ?? DEFAULT_CREDENTIALS_DIR,
      'credentials.enc',
    );
    this.allowLegacyPathMigration = options.allowLegacyPathMigration === true;
    this.beforeAtomicRename = options.beforeAtomicRename;
    this.writeLockOptions = options.writeLockOptions ?? {};
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
        if (existsSync(this.credentialsFile)) {
          throw new Error('Credential store is unreadable; refusing to overwrite it');
        }
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

  async compareAndSwap(
    id: CredentialId,
    expected: Pick<StoredCredential, 'value' | 'refreshToken'>,
    replacement: StoredCredential | null,
  ): Promise<CredentialCompareAndSwapResult> {
    return this.withWriteLock(async () => {
      this.cachedStore = null;
      const store = await this.loadStore();
      if (!store) {
        if (existsSync(this.credentialsFile)) {
          throw new Error('Credential store is unreadable; refusing to overwrite it');
        }
        return { updated: false, current: null };
      }

      const key = credentialIdToAccount(id);
      const current = store.credentials[key] ?? null;
      if (
        !current
        || current.value !== expected.value
        || current.refreshToken !== expected.refreshToken
      ) {
        return { updated: false, current };
      }

      if (replacement) store.credentials[key] = replacement;
      else delete store.credentials[key];
      store.metadata.updatedAt = Date.now();
      await this.saveStore(store);
      return { updated: true, current: replacement };
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
    if (!existsSync(this.credentialsDir)) {
      mkdirSync(this.credentialsDir, { recursive: true, mode: 0o700 });
    }
    const release = acquireCredentialWriteLockSync(this.writeLockDirectory);
    try {
      this.cachedStore = null;
      const store = this.loadStoreSync();
      if (!store) return false;

      const key = credentialIdToAccount(id);
      if (!(key in store.credentials)) return false;

      delete store.credentials[key];
      store.metadata.updatedAt = Date.now();

      this.saveStoreSync(store);
      return true;
    } finally {
      release();
    }
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

    const lock = await acquireCredentialWriteLock(this.writeLockDirectory, this.writeLockOptions);
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }

  private loadStoreSync(): CredentialStore | null {
    // Return cached store if available
    if (this.cachedStore) return this.cachedStore;

    const instanceFileExists = existsSync(this.credentialsFile);
    if (instanceFileExists) {
      return this.loadStoreFromFile(this.credentialsFile);
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
      const legacyStore = this.loadStoreFromFile(this.legacyCredentialsFile);
      if (legacyStore) {
        this.saveStoreSync(legacyStore);
        return legacyStore;
      }
    }

    return null;
  }

  private loadStoreFromFile(filePath: string): CredentialStore | null {
    let fileData: Buffer;
    try {
      fileData = readFileSync(filePath);
    } catch {
      return null;
    }

    // Validate minimum size
    if (fileData.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) {
      this.resetFailedLoad();
      return null;
    }

    // Validate magic bytes
    if (!fileData.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
      this.resetFailedLoad();
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
      // Defer migration until the next locked mutation. Re-encrypting during a
      // read would create an uncoordinated writer that could overwrite a
      // concurrent OAuth rotation from Electron or another CLI process.
      this.cachedStore = store;
      return store;
    }

    // Both keys failed - the selected file is truly corrupted.
    this.resetFailedLoad();
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

    // Write to a unique same-directory file, flush it, then atomically replace
    // the store. A crash or failed rename leaves the previous credential file
    // intact and only the caller's temporary file is cleaned up.
    const temporaryFile = join(
      this.credentialsDir,
      `.credentials.enc.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryFile, 'wx', 0o600);
      writeFileSync(descriptor, fileData);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.beforeAtomicRename?.(temporaryFile, this.credentialsFile);
      renameSync(temporaryFile, this.credentialsFile);
      if (process.platform !== 'win32') {
        const directoryDescriptor = openSync(this.credentialsDir, 'r');
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      try { rmSync(temporaryFile, { force: true }); } catch {}
      throw error;
    }
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

  private resetFailedLoad(): void {
    // Preserve unreadable stores for recovery. Callers must never turn a
    // transient partial read or incompatible key into credential deletion.
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
