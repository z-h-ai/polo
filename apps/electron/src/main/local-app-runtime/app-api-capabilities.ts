import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  APP_API_CAPABILITY_TTL_MS,
  type ProductSpaceAppRuntimeIdentity,
} from '@polo-ai/shared/product-spaces'

export interface CapabilityBindings {
  identityKey: string
  identity: ProductSpaceAppRuntimeIdentity
  workspaceId: string
  executionId: string
  runtimeGeneration: number
  scopeGeneration: number
}

export interface IssuedCapability {
  capabilityGeneration: number
  /** Only held by the coordinator for process-env injection; never persisted. */
  token: string
  expiresAt: number
}

export type CapabilityRecord = CapabilityBindings & {
  capabilityGeneration: number
  digest: string
  expiresAt: number
}

/**
 * Digest-only per-launch capability registry. Tokens are 256-bit base64url
 * values issued once per process generation; the registry retains only the
 * SHA-256 digest and verifies with a timing-safe compare. Tokens are bound to
 * the immutable runtime identity, workspace, execution, runtime process
 * generation and ProductSpace scope generation, with a fixed non-renewable
 * 24h TTL.
 */
export class AppApiCapabilityRegistry {
  private readonly records = new Map<number, CapabilityRecord>()
  private readonly revoked = new Set<number>()
  private nextGeneration = 0

  issue(bindings: CapabilityBindings, now: number): IssuedCapability {
    const capabilityGeneration = ++this.nextGeneration
    const token = randomBytes(32).toString('base64url')
    this.records.set(capabilityGeneration, {
      ...bindings,
      capabilityGeneration,
      digest: createHash('sha256').update(token).digest('hex'),
      expiresAt: now + APP_API_CAPABILITY_TTL_MS,
    })
    return { capabilityGeneration, token, expiresAt: now + APP_API_CAPABILITY_TTL_MS }
  }

  /** Timing-safe digest lookup; expired or revoked tokens verify as invalid. */
  verify(token: unknown, now: number): CapabilityRecord | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null
    const candidate = createHash('sha256').update(token).digest()
    for (const record of this.records.values()) {
      if (!timingSafeEqual(Buffer.from(record.digest, 'hex'), candidate)) continue
      if (record.expiresAt <= now || this.revoked.has(record.capabilityGeneration)) return null
      return record
    }
    return null
  }

  /**
   * Returns the record matching the token when it is expired or revoked but
   * still retained — the trigger for the coordinator's unified expiry
   * teardown. Records already forgotten (torn down) never match.
   */
  findExpiredOrRevoked(token: unknown, now: number): CapabilityRecord | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null
    const candidate = createHash('sha256').update(token).digest()
    for (const record of this.records.values()) {
      if (!timingSafeEqual(Buffer.from(record.digest, 'hex'), candidate)) continue
      if (record.expiresAt <= now || this.revoked.has(record.capabilityGeneration)) {
        return record
      }
      return null
    }
    return null
  }

  get(capabilityGeneration: number): CapabilityRecord | undefined {
    return this.records.get(capabilityGeneration)
  }

  revoke(capabilityGeneration: number): void {
    this.revoked.add(capabilityGeneration)
  }

  /** Revokes every capability bound to one runtime process generation. */
  revokeRuntimeGeneration(runtimeGeneration: number): void {
    for (const record of this.records.values()) {
      if (record.runtimeGeneration === runtimeGeneration) {
        this.revoked.add(record.capabilityGeneration)
      }
    }
  }

  revokeAll(): void {
    for (const generation of this.records.keys()) this.revoked.add(generation)
  }

  isRevoked(capabilityGeneration: number): boolean {
    return this.revoked.has(capabilityGeneration)
  }

  /** Drops revoked/expired records after their bounded cleanup completed. */
  forget(capabilityGeneration: number): void {
    this.records.delete(capabilityGeneration)
    this.revoked.delete(capabilityGeneration)
  }
}
