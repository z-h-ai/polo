---
id: llm.config-decrypt
module: llm
type: domain
priority: 7
status: completed
estimatedMinutes: 25
dependencies: [auth.admin-api-client]
startedAt: 2026-06-07T09:09:55.638Z
completedAt: 2026-06-07T09:22:06.518Z
---
# LLM Config Fetch + AES-256-GCM Decryption

## Description
Implement the credential decryption pipeline:
1. Receive the encrypted LLM connections response from `getLlmConnections()`
2. For each connection's `credential` field, derive AES-256 key from JWT via HKDF-SHA256
3. Decrypt the API key using AES-256-GCM
4. Handle partial failures: if one connection fails decryption, skip it and continue
5. Return the list of connections with decrypted API keys

Create `packages/shared/src/auth/credential-encryption.ts`.

## Environment Context
- Runtime: Node.js + Electron + Browser (Web Crypto API)
- Package manager: Bun
- Test strategy: Unit tests with known test vectors
- Encryption: AES-256-GCM, HKDF-SHA256(JWT, salt="polo-llm-key-encryption", info="aes-256-gcm")

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| Valid encrypted credential + correct JWT | Happy path | Decrypted API key string |
| Valid encrypted credential + wrong JWT | Key mismatch | Decryption error (GCM auth tag fails) |
| credential.alg != "aes-256-gcm" | Unsupported algorithm | Skip connection, log warning |
| Corrupted ciphertext (bad base64) | Data corruption | Skip connection, log error |
| Corrupted IV (wrong length) | Data corruption | Skip connection, log error |
| Empty connections array | No config assigned | Return empty array |
| 2 connections, 1 fails decrypt | Partial failure | Return 1 decrypted connection, skip failed one |

## Input/Output Types
```typescript
// Input
interface EncryptedCredential {
  alg: 'aes-256-gcm';
  kid: string;
  iv: string;       // base64, 12 bytes
  ciphertext: string; // base64
  tag: string;       // base64, 16 bytes
}

// Function signature
function decryptCredential(
  credential: EncryptedCredential,
  jwt: string
): Promise<string>  // returns plaintext API key

function decryptAllConnections(
  connections: EncryptedConnection[],
  jwt: string
): Promise<DecryptedConnection[]>  // skips failures
```

## Acceptance Criteria
1. HKDF-SHA256 key derivation uses JWT as input key material, salt="polo-llm-key-encryption", info="aes-256-gcm"
2. Derived key is 32 bytes (256 bits)
3. AES-256-GCM decryption uses IV, ciphertext, and tag from credential
4. Successful decryption returns plaintext API key string
5. GCM authentication failure (tampered data) throws/rejects
6. Unsupported `alg` value → skip connection, log warning
7. Partial failure: other connections still decrypted successfully
8. Base64 decoding errors are caught and reported per-connection

## Test Cases (Red Phase)

### Key Derivation
- TEST: deriveKey("test-jwt-token") with salt="polo-llm-key-encryption", info="aes-256-gcm" → produces deterministic 32-byte key (verify with known test vector)
- TEST: deriveKey("different-jwt") → produces different 32-byte key
- TEST: deriveKey("") → throws or returns error (empty JWT)

### Decryption Happy Path
- TEST: decryptCredential(validEncryptedCred, correctJwt) → returns "sk-ant-abc123" (plaintext key)
- TEST: Round-trip test: encrypt a known key with known JWT → decrypt → matches original

### Decryption Failures
- TEST: decryptCredential(validEncryptedCred, wrongJwt) → throws DecryptionError (GCM auth tag mismatch)
- TEST: decryptCredential({ ...valid, ciphertext: "corrupted" }, jwt) → throws DecryptionError
- TEST: decryptCredential({ ...valid, iv: "short" }, jwt) → throws DecryptionError (IV must be 12 bytes)
- TEST: decryptCredential({ ...valid, tag: "wrong" }, jwt) → throws DecryptionError
- TEST: decryptCredential({ alg: "aes-128-cbc", ...rest }, jwt) → throws UnsupportedAlgorithmError

### Batch Decryption
- TEST: decryptAllConnections([valid1, valid2], jwt) → returns 2 decrypted connections
- TEST: decryptAllConnections([valid1, corrupted, valid2], jwt) → returns 2 decrypted connections, logs error for corrupted
- TEST: decryptAllConnections([], jwt) → returns empty array
- TEST: decryptAllConnections([corrupted1, corrupted2], jwt) → returns empty array, logs 2 errors

### Fetch Integration (getLlmConnections → decrypt pipeline)
- TEST: fetchAndDecryptConfig(jwt) calls getLlmConnections() then decrypts each credential → returns DecryptedConnection[]
- TEST: fetchAndDecryptConfig when getLlmConnections() fails (NetworkError) → throws, caller handles
- TEST: fetchAndDecryptConfig when getLlmConnections() returns 401 → throws TokenRevokedError

## Fixtures Required
- Pre-computed test vector: known JWT + known plaintext key → encrypted credential (IV, ciphertext, tag)
- Multiple encrypted credential samples for batch testing
