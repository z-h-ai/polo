// Long-lived credential storage for the mobile app (POL-14).
//
// Security contract (PRD §③): access/refresh tokens must live in
// expo-secure-store (iOS Keychain / Android Keystore) and NEVER in plaintext
// persistence such as AsyncStorage. When SecureStore is unavailable (tests,
// Expo web, missing native module) the store degrades to an in-memory backend
// only — session-scoped, never written to disk. A failed read is treated as
// "not signed in".
//
// Writes update the in-memory cache synchronously so non-React layers (api
// client, the future connection manager) can read the current access token
// without awaiting.

export interface StoredUser {
  id: string;
  phone: string;
  username?: string;
  displayName?: string | null;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  user: StoredUser;
}

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export type StorageBackendName = 'secure-store' | 'memory';

const ACCESS_KEY = 'polo.accessToken';
const REFRESH_KEY = 'polo.refreshToken';
const USER_KEY = 'polo.user';

/** Session-scoped Map backend; the safe fallback (nothing touches disk). */
export function createMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    async getItem(key) {
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async deleteItem(key) {
      map.delete(key);
    },
  };
}

interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/**
 * Loads expo-secure-store only inside a real React Native runtime. In plain
 * Node (bun test) requiring the package would drag in react-native internals,
 * so we skip it entirely and the caller falls back to memory.
 */
function loadSecureStore(): SecureStoreLike | null {
  const isReactNative =
    typeof navigator !== 'undefined' && navigator.product === 'ReactNative';
  if (!isReactNative) return null;
  try {
    // Lazy require so Metro still bundles the module statically while bun
    // test never evaluates it.
    const mod = require('expo-secure-store') as Partial<SecureStoreLike>;
    if (
      typeof mod.getItemAsync === 'function'
      && typeof mod.setItemAsync === 'function'
      && typeof mod.deleteItemAsync === 'function'
    ) {
      return mod as SecureStoreLike;
    }
    return null;
  } catch {
    return null;
  }
}

function secureStoreBackend(secure: SecureStoreLike): KeyValueStorage {
  return {
    async getItem(key) {
      return secure.getItemAsync(key);
    },
    async setItem(key, value) {
      await secure.setItemAsync(key, value);
    },
    async deleteItem(key) {
      await secure.deleteItemAsync(key);
    },
  };
}

/** Returns the storage for the current runtime; never a plaintext persistence. */
export function resolveDefaultStorage(): {
  storage: KeyValueStorage;
  backend: StorageBackendName;
} {
  const secure = loadSecureStore();
  if (secure) {
    return { storage: secureStoreBackend(secure), backend: 'secure-store' };
  }
  return { storage: createMemoryStorage(), backend: 'memory' };
}

export interface TokenStore {
  /** Re-reads persisted tokens into the cache; null means "not signed in". */
  load(): Promise<StoredTokens | null>;
  /** Synchronous read of the in-memory snapshot (for api client / guards). */
  getCached(): StoredTokens | null;
  /** Persists tokens and refreshes the cache synchronously. */
  save(tokens: StoredTokens): Promise<void>;
  /** Refresh rotation: swap the access token, keep the rest. */
  updateAccessToken(accessToken: string): Promise<void>;
  /** Removes everything; safe to call repeatedly. */
  clear(): Promise<void>;
  backend(): StorageBackendName;
}

export function createTokenStore(deps?: {
  storage?: KeyValueStorage;
}): TokenStore {
  let backend: StorageBackendName;
  let storage: KeyValueStorage;
  if (deps?.storage) {
    storage = deps.storage;
    backend = 'memory'; // injected backends are test doubles
  } else {
    const resolved = resolveDefaultStorage();
    storage = resolved.storage;
    backend = resolved.backend;
  }
  let cache: StoredTokens | null = null;

  const readUser = async (): Promise<StoredUser | null> => {
    const raw = await storage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredUser;
      if (
        parsed
        && typeof parsed === 'object'
        && typeof parsed.id === 'string'
        && typeof parsed.phone === 'string'
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  };

  return {
    async load() {
      try {
        const accessToken = await storage.getItem(ACCESS_KEY);
        const refreshToken = await storage.getItem(REFRESH_KEY);
        if (!accessToken || !refreshToken) {
          cache = null;
          return null;
        }
        const user = await readUser();
        if (!user) {
          cache = null;
          return null;
        }
        cache = { accessToken, refreshToken, user };
        return cache;
      } catch {
        // Unreadable storage counts as signed out; never crash the boot path.
        cache = null;
        return null;
      }
    },
    getCached() {
      return cache;
    },
    async save(tokens) {
      cache = tokens; // synchronous visibility for non-React layers
      try {
        await storage.setItem(ACCESS_KEY, tokens.accessToken);
        await storage.setItem(REFRESH_KEY, tokens.refreshToken);
        await storage.setItem(USER_KEY, JSON.stringify(tokens.user));
      } catch (error) {
        // Persist failed but the session stays alive in memory (e.g. Keychain
        // hiccup); log for diagnostics instead of throwing mid-login.
        console.warn('[tokenStore] persist failed', error);
      }
    },
    async updateAccessToken(accessToken) {
      const current = cache;
      if (!current) return;
      const next = { ...current, accessToken };
      cache = next;
      try {
        await storage.setItem(ACCESS_KEY, accessToken);
      } catch (error) {
        console.warn('[tokenStore] persist(access) failed', error);
      }
    },
    async clear() {
      cache = null;
      try {
        await storage.deleteItem(ACCESS_KEY);
        await storage.deleteItem(REFRESH_KEY);
        await storage.deleteItem(USER_KEY);
      } catch (error) {
        console.warn('[tokenStore] clear failed', error);
      }
    },
    backend() {
      return backend;
    },
  };
}

/** App-wide singleton used by the api client and the session store. */
export const tokenStore = createTokenStore();
