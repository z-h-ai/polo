/**
 * The KB error contract (POO-108 v3.1).
 *
 * `code` is the stable RPC error code the renderer maps onto i18n text;
 * `detail` carries the raw failure context (storage-vendor messages, URIs,
 * response bodies) for SERVER-side logs and the audit trail only — it must
 * never reach the wire, where the message stays neutral (brief D7: the
 * enterprise user must never learn a storage vendor exists).
 */

/** Thrown for KB business failures; `code` is the stable RPC error contract. */
export class KbStoreError extends Error {
  constructor(
    readonly code: string,
    message?: string,
    readonly detail?: unknown,
  ) {
    super(message ?? code)
    this.name = 'KbStoreError'
  }
}

/**
 * The neutral user-facing text for every availability failure (brief D7).
 * The knowledge-base service is named generically — never the vendor behind
 * it — and the message never repeats the underlying cause.
 */
export const KB_SERVICE_UNAVAILABLE_MESSAGE = 'The knowledge base service is temporarily unavailable'
