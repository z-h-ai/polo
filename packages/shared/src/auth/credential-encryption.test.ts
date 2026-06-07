import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  DecryptionError,
  UnsupportedAlgorithmError,
  decryptAllConnections,
  decryptCredential,
  deriveCredentialKey,
  fetchAndDecryptConfig,
} from './credential-encryption.ts';
import { NetworkError, TokenRevokedError } from './admin-auth.ts';
import type { EncryptedConnection, EncryptedCredential } from './credential-encryption.ts';

const SAMPLE_JWT = 'test-jwt-token';
const DIFFERENT_JWT = 'different-jwt';
const SAMPLE_KEY_HEX = '237f58e3bd80f7ba37314fcd84d7c81d5d5a4f0c666b4b9c0b2448fb90045d41';

const VALID_CREDENTIAL: EncryptedCredential = {
  alg: 'aes-256-gcm',
  kid: 'ek_test_v1',
  iv: 'ABEiM0RVZneImaq7',
  ciphertext: 'N906iJ5jN/2WBpwHlA==',
  tag: 'NzSnv7KlFFtrsm+B+nquog==',
};

const SECOND_VALID_CREDENTIAL: EncryptedCredential = {
  alg: 'aes-256-gcm',
  kid: 'ek_test_v1',
  iv: 'AQIDBAUGBwgJCgsM',
  ciphertext: 'g+gQyGcSlk5me6jsrE4bdA==',
  tag: 'CXR0GOsyR8m0RksWFFk8vA==',
};

const BASE_CONNECTION: Omit<EncryptedConnection, 'credential'> = {
  slug: 'anthropic-prod',
  name: 'Anthropic Production',
  providerType: 'anthropic',
  authType: 'api_key',
  models: ['claude-sonnet-4-6'],
  defaultModel: 'claude-sonnet-4-6',
};

afterEach(() => {
  spyOn(console, 'warn').mockRestore();
  spyOn(console, 'error').mockRestore();
});

function encryptedConnection(
  slug: string,
  credential: EncryptedConnection['credential'],
): EncryptedConnection {
  return {
    ...BASE_CONNECTION,
    slug,
    credential,
  };
}

async function keyHex(jwt: string): Promise<string> {
  return Buffer.from(await deriveCredentialKey(jwt)).toString('hex');
}

describe('LLM credential key derivation', () => {
  it('deriveCredentialKey derives deterministic 32-byte HKDF-SHA256 output', async () => {
    const key = await deriveCredentialKey(SAMPLE_JWT);

    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.byteLength).toBe(32);
    expect(Buffer.from(key).toString('hex')).toBe(SAMPLE_KEY_HEX);
  });

  it('deriveCredentialKey derives different keys for different JWTs', async () => {
    expect(await keyHex(DIFFERENT_JWT)).not.toBe(await keyHex(SAMPLE_JWT));
  });

  it('deriveCredentialKey rejects an empty JWT', async () => {
    await expect(deriveCredentialKey('')).rejects.toThrow(DecryptionError);
  });
});

describe('LLM credential decryption', () => {
  it('decryptCredential returns the plaintext API key for a valid credential and JWT', async () => {
    await expect(decryptCredential(VALID_CREDENTIAL, SAMPLE_JWT)).resolves.toBe('sk-ant-abc123');
  });

  it('decryptCredential round-trips another known credential vector', async () => {
    await expect(decryptCredential(SECOND_VALID_CREDENTIAL, SAMPLE_JWT)).resolves.toBe(
      'sk-openai-xyz789',
    );
  });

  it('decryptCredential rejects when the JWT derives the wrong key', async () => {
    await expect(decryptCredential(VALID_CREDENTIAL, DIFFERENT_JWT)).rejects.toThrow(DecryptionError);
  });

  it('decryptCredential rejects corrupted ciphertext', async () => {
    await expect(
      decryptCredential({ ...VALID_CREDENTIAL, ciphertext: 'corrupted' }, SAMPLE_JWT),
    ).rejects.toThrow(DecryptionError);
  });

  it('decryptCredential rejects an IV that is not 12 bytes', async () => {
    await expect(decryptCredential({ ...VALID_CREDENTIAL, iv: 'c2hvcnQ=' }, SAMPLE_JWT)).rejects.toThrow(
      DecryptionError,
    );
  });

  it('decryptCredential rejects an auth tag that is not 16 bytes', async () => {
    await expect(decryptCredential({ ...VALID_CREDENTIAL, tag: 'd3Jvbmc=' }, SAMPLE_JWT)).rejects.toThrow(
      DecryptionError,
    );
  });

  it('decryptCredential rejects unsupported algorithms', async () => {
    await expect(
      decryptCredential({ ...VALID_CREDENTIAL, alg: 'aes-128-cbc' }, SAMPLE_JWT),
    ).rejects.toThrow(UnsupportedAlgorithmError);
  });
});

describe('LLM batch credential decryption', () => {
  it('decryptAllConnections decrypts every valid connection', async () => {
    const connections = [
      encryptedConnection('anthropic-prod', VALID_CREDENTIAL),
      encryptedConnection('openai-prod', SECOND_VALID_CREDENTIAL),
    ];

    await expect(decryptAllConnections(connections, SAMPLE_JWT)).resolves.toEqual([
      expect.objectContaining({ slug: 'anthropic-prod', apiKey: 'sk-ant-abc123' }),
      expect.objectContaining({ slug: 'openai-prod', apiKey: 'sk-openai-xyz789' }),
    ]);
  });

  it('decryptAllConnections skips corrupted connections and logs per-connection errors', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const connections = [
      encryptedConnection('anthropic-prod', VALID_CREDENTIAL),
      encryptedConnection('broken', { ...VALID_CREDENTIAL, ciphertext: 'corrupted' }),
      encryptedConnection('openai-prod', SECOND_VALID_CREDENTIAL),
    ];

    const decrypted = await decryptAllConnections(connections, SAMPLE_JWT);

    expect(decrypted.map(connection => connection.slug)).toEqual(['anthropic-prod', 'openai-prod']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('broken');
  });

  it('decryptAllConnections returns an empty array for no assigned config', async () => {
    await expect(decryptAllConnections([], SAMPLE_JWT)).resolves.toEqual([]);
  });

  it('decryptAllConnections skips unsupported algorithms with a warning', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const connections = [
      encryptedConnection('legacy', { ...VALID_CREDENTIAL, alg: 'aes-128-cbc' }),
    ];

    await expect(decryptAllConnections(connections, SAMPLE_JWT)).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('legacy');
  });

  it('decryptAllConnections logs each failure and returns empty when every connection fails', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const connections = [
      encryptedConnection('bad-ciphertext', { ...VALID_CREDENTIAL, ciphertext: 'corrupted' }),
      encryptedConnection('bad-iv', { ...VALID_CREDENTIAL, iv: 'c2hvcnQ=' }),
    ];

    await expect(decryptAllConnections(connections, SAMPLE_JWT)).resolves.toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});

describe('LLM config fetch and decrypt pipeline', () => {
  it('fetchAndDecryptConfig calls getLlmConnections and decrypts returned credentials', async () => {
    let called = false;
    const client = {
      async getLlmConnections() {
        called = true;
        return {
          configVersion: 'cv_llm_001',
          defaultConnection: 'anthropic-prod',
          connections: [encryptedConnection('anthropic-prod', VALID_CREDENTIAL)],
        };
      },
    };

    await expect(fetchAndDecryptConfig(SAMPLE_JWT, { client })).resolves.toEqual({
      configVersion: 'cv_llm_001',
      defaultConnection: 'anthropic-prod',
      connections: [expect.objectContaining({ slug: 'anthropic-prod', apiKey: 'sk-ant-abc123' })],
    });
    expect(called).toBe(true);
  });

  it('fetchAndDecryptConfig propagates getLlmConnections network failures', async () => {
    const client = {
      async getLlmConnections() {
        throw new NetworkError('Admin unavailable');
      },
    };

    await expect(fetchAndDecryptConfig(SAMPLE_JWT, { client })).rejects.toThrow(NetworkError);
  });

  it('fetchAndDecryptConfig propagates revoked-token failures', async () => {
    const client = {
      async getLlmConnections() {
        throw new TokenRevokedError(401, { error: 'token_revoked' });
      },
    };

    await expect(fetchAndDecryptConfig(SAMPLE_JWT, { client })).rejects.toThrow(TokenRevokedError);
  });
});
