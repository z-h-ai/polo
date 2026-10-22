// GENERATED from polo-admin/src/lib/billing/provider-observation.ts
// Source SHA-256: 3e5580f5d77ed61f1e7a09d7d5ddaafc5e1da99b65279f8f869b9ed8c2e19618
// Run backend scripts/sync-billing-runtime-contract.mjs --client <checkout>; do not edit.

/** Bounded metadata from the ORIGINAL transport response, never its headers or
 * body. This pure module is the sole authority for the two generated clients. */
export type ProviderObservationV1 = {
  version: 1;
  state: "observed" | "missing" | "ambiguous";
  providerRequestId?: string;
  responseStatus?: number;
};

/** Private calling context. The App and durable client journal never receive it. */
export type ProviderCorrelationV1 = { header: "X-Polo-Request-Id"; nonce: string };
export function parseProviderCorrelation(value: unknown): ProviderCorrelationV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || row.header !== "X-Polo-Request-Id" || typeof row.nonce !== "string" || !/^[0-9a-f]{32}$/.test(row.nonce)) return null;
  return { header: "X-Polo-Request-Id", nonce: row.nonce };
}

export function parseProviderObservation(value: unknown): ProviderObservationV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["version", "state", "providerRequestId", "responseStatus"].includes(key))) return null;
  if (row.version !== 1 || !["observed", "missing", "ambiguous"].includes(String(row.state))) return null;
  if (row.responseStatus !== undefined && (!Number.isInteger(row.responseStatus) || Number(row.responseStatus) < 100 || Number(row.responseStatus) > 599)) return null;
  const id = row.providerRequestId;
  if (row.state === "observed" ? typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) : id !== undefined) return null;
  return { version: 1, state: row.state as ProviderObservationV1["state"], ...(typeof id === "string" ? { providerRequestId: id } : {}), ...(typeof row.responseStatus === "number" ? { responseStatus: row.responseStatus } : {}) };
}
