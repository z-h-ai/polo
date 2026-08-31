/**
 * Stable, collision-safe editor identity for Edit Popover sessions.
 *
 * The popover owner id must be a SHORT, fixed-length, deterministic string:
 * it is persisted as the session's `popoverOwner` and matched EXACTLY on
 * pending-question recovery (reopen / reload / restart). The raw
 * "label::filePath" pair can exceed any sane field bound for deeply nested
 * projects, so it is hashed instead.
 *
 * FNV-1a 64-bit: deterministic across processes and restarts, no async
 * crypto, and a 64-bit space that is collision-safe for the realistic number
 * of editor surfaces in a workspace.
 */

const FNV_64_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_64_PRIME = 0x00000100000001b3n
const FNV_64_MASK = 0xffffffffffffffffn

function fnv1a64(input: string): string {
  let hash = FNV_64_OFFSET_BASIS
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i))
    hash = (hash * FNV_64_PRIME) & FNV_64_MASK
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * Derive the stable Edit Popover owner identity from its structured editor
 * context. Same label + filePath always maps to the same id; different
 * surfaces (or files) virtually never collide.
 */
export function editorIdentityId(label: string, filePath: string): string {
  // NUL separator keeps "ab"+"c" and "a"+"bc" distinct.
  return `ep-${fnv1a64(`${label}\u0000${filePath}`)}`
}
