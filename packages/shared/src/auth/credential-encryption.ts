import {
  createAdminApiClient,
  type AdminApiClient,
  type LlmConnectionsResult,
} from './admin-auth.ts';

const CREDENTIAL_ALGORITHM = 'aes-256-gcm';
const HKDF_SALT = 'polo-llm-key-encryption';
const HKDF_INFO = 'aes-256-gcm';
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

export interface EncryptedCredential {
  alg: string;
  kid: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface EncryptedConnection {
  slug: string;
  credential: EncryptedCredential;
  [key: string]: unknown;
}

export interface DecryptedConnection {
  slug: string;
  apiKey: string;
  [key: string]: unknown;
}

export interface DecryptedLlmConnectionsResult {
  configVersion: string;
  connections: DecryptedConnection[];
  defaultConnection: string | null;
}

export interface FetchAndDecryptConfigOptions {
  client?: Pick<AdminApiClient, 'getLlmConnections'>;
}

export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'DecryptionError';
    this.cause = options?.cause;
  }
}

export class UnsupportedAlgorithmError extends DecryptionError {
  readonly alg: string;

  constructor(alg: string) {
    super(`Unsupported credential algorithm: ${alg}`);
    this.name = 'UnsupportedAlgorithmError';
    this.alg = alg;
  }
}

export async function deriveCredentialKey(jwt: string): Promise<Uint8Array> {
  if (!jwt) {
    throw new DecryptionError('JWT is required to derive credential key');
  }

  try {
    const subtle = getSubtleCrypto();
    const encoder = new TextEncoder();
    const keyMaterial = await subtle.importKey(
      'raw',
      encoder.encode(jwt),
      'HKDF',
      false,
      ['deriveBits'],
    );
    const bits = await subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode(HKDF_SALT),
        info: encoder.encode(HKDF_INFO),
      },
      keyMaterial,
      256,
    );

    return new Uint8Array(bits);
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw error;
    }
    throw new DecryptionError('Failed to derive credential key', { cause: error });
  }
}

export async function decryptCredential(
  credential: EncryptedCredential,
  jwt: string,
): Promise<string> {
  if (credential.alg !== CREDENTIAL_ALGORITHM) {
    throw new UnsupportedAlgorithmError(String(credential.alg));
  }

  try {
    const iv = decodeBase64Field(credential.iv, 'iv');
    if (iv.byteLength !== AES_GCM_IV_BYTES) {
      throw new DecryptionError(`Credential IV must be ${AES_GCM_IV_BYTES} bytes`);
    }

    const tag = decodeBase64Field(credential.tag, 'tag');
    if (tag.byteLength !== AES_GCM_TAG_BYTES) {
      throw new DecryptionError(`Credential auth tag must be ${AES_GCM_TAG_BYTES} bytes`);
    }

    const ciphertext = decodeBase64Field(credential.ciphertext, 'ciphertext');
    const keyBytes = await deriveCredentialKey(jwt);
    const subtle = getSubtleCrypto();
    const key = await subtle.importKey(
      'raw',
      toArrayBuffer(keyBytes),
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    const encrypted = concatBytes(ciphertext, tag);
    const plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), tagLength: 128 },
      key,
      toArrayBuffer(encrypted),
    );

    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error instanceof UnsupportedAlgorithmError) {
      throw error;
    }
    if (error instanceof DecryptionError) {
      throw error;
    }
    throw new DecryptionError('Failed to decrypt credential', { cause: error });
  }
}

export async function decryptAllConnections(
  connections: EncryptedConnection[],
  jwt: string,
): Promise<DecryptedConnection[]> {
  const decrypted: DecryptedConnection[] = [];

  for (const connection of connections) {
    try {
      const apiKey = await decryptCredential(connection.credential, jwt);
      const { credential: _credential, ...connectionWithoutCredential } = connection;
      decrypted.push({
        ...connectionWithoutCredential,
        apiKey,
      });
    } catch (error) {
      if (error instanceof UnsupportedAlgorithmError) {
        console.warn(
          `[credential-encryption] Skipping LLM connection "${connection.slug}": ${error.message}`,
        );
      } else {
        console.error(
          `[credential-encryption] Failed to decrypt LLM connection "${connection.slug}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return decrypted;
}

export async function fetchAndDecryptConfig(
  jwt: string,
  options: FetchAndDecryptConfigOptions = {},
): Promise<DecryptedLlmConnectionsResult> {
  const client = options.client ?? createAdminApiClient({ token: jwt });
  const result = await client.getLlmConnections();
  return decryptLlmConnectionsResult(result, jwt);
}

async function decryptLlmConnectionsResult(
  result: LlmConnectionsResult,
  jwt: string,
): Promise<DecryptedLlmConnectionsResult> {
  return {
    configVersion: result.configVersion,
    defaultConnection: result.defaultConnection,
    connections: await decryptAllConnections(result.connections as EncryptedConnection[], jwt),
  };
}

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new DecryptionError('Web Crypto API is unavailable');
  }
  return subtle;
}

function decodeBase64Field(value: string, fieldName: string): Uint8Array {
  if (!isStrictBase64(value)) {
    throw new DecryptionError(`Credential ${fieldName} is not valid base64`);
  }

  try {
    const binary = globalThis.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (error) {
    throw new DecryptionError(`Credential ${fieldName} is not valid base64`, { cause: error });
  }
}

function isStrictBase64(value: string): boolean {
  if (value.length % 4 !== 0) {
    return false;
  }
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
