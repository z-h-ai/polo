/**
 * Re-export of the shared incremental SHA-256 core. The renderer keeps this
 * module path for the creator-skill upload flow (bounded-chunk hashing
 * without Node crypto); the implementation lives in `shared/sha256.ts` so
 * Main and renderer share one audited implementation.
 */
export { IncrementalSha256 } from '../../shared/sha256'
