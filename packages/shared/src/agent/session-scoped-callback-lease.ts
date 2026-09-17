/**
 * R51/R52: the OWNER LEASE for a session's session-scoped tool callbacks —
 * the exact (guard-wrapped record, guard, owner token) triple captured at
 * registration/merge time.
 *
 * Kept in a cycle-safe leaf module (no imports) so the registry, the backend
 * config surface and the SessionManager can share ONE named type without
 * import cycles. The fields are typed `unknown` here; the registry narrows
 * them to its concrete callback/guard types.
 */
export interface SessionScopedToolCallbackLease {
  /** The installed (guard-wrapped) callback record. */
  record: unknown;
  /** The guard snapshot at install time. */
  guard: unknown;
  /** The immutable runtime owner token this lease belongs to. */
  ownerToken: string;
}
