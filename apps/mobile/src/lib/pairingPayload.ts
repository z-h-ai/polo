// Pairing-QR payload parser (POL-16).
//
// Pure function so the scanner UI stays thin and the failure modes are unit
// tested. Accepted payloads mirror what the Mac pairing panel renders into the
// QR (PRD v1.6 §⑤ D02 convention, POL-13):
//   {"code":"246810","wsUrl":"ws://192.168.31.42:8787"}
//   - code: the 6-digit pairing code from admin /api/devices/pairing-code
//     (admin pairingCodeSchema: ^\d{6}$ — the prototype's "8F3K2Q" example
//     predates the admin charset; digits win as the authoritative contract)
//   - wsUrl: LAN hint ONLY — passed through for the POL-17 connection
//     manager to try direct connect first. It is never an authorization
//     input: authorization happens exclusively through admin bind validation.
// Also accepted: the bare 6-digit code (a QR printed with just the code).
//
// Anything else — including the qr-LOGIN payloads from POL-15 — is invalid
// with a machine-readable reason so the UI can show the right layer:
// a login QR must not be silently consumed as a pairing code (and vice
// versa), so https://.../qr-login?... lands on not_polo_payload here.

export const PAIRING_CODE_LENGTH = 6;

/** Admin pairingCodeSchema charset — six digits. */
export function isValidPairingCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

export type InvalidPairingPayloadReason =
  /** Not JSON and not a bare 6-digit code (wrong QR, login QR, garbage). */
  | 'not_polo_payload'
  /** JSON object but the code field is missing / not a string. */
  | 'missing_code'
  /** JSON object with a code that is not exactly six digits. */
  | 'bad_code';

export type PairingPayload =
  | { kind: 'valid'; code: string; wsUrl: string | null }
  | { kind: 'invalid'; reason: InvalidPairingPayloadReason };

/**
 * Reads the pairing code (and optional LAN wsUrl hint) from a scanned QR.
 * Never throws — every non-conforming input maps to an invalid reason.
 */
export function parsePairingPayload(raw: string): PairingPayload {
  const input = raw.trim();
  if (!input) return { kind: 'invalid', reason: 'not_polo_payload' };

  // Bare code form: someone printed just the six digits.
  if (isValidPairingCode(input)) {
    return { kind: 'valid', code: input, wsUrl: null };
  }

  if (!input.startsWith('{')) return { kind: 'invalid', reason: 'not_polo_payload' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { kind: 'invalid', reason: 'not_polo_payload' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: 'not_polo_payload' };
  }

  const record = parsed as Record<string, unknown>;
  const code = record.code;
  if (typeof code !== 'string') return { kind: 'invalid', reason: 'missing_code' };

  const codeTrimmed = code.trim();
  if (!isValidPairingCode(codeTrimmed)) {
    return { kind: 'invalid', reason: 'bad_code' };
  }

  const wsUrl = typeof record.wsUrl === 'string' && record.wsUrl.trim() ? record.wsUrl.trim() : null;

  return { kind: 'valid', code: codeTrimmed, wsUrl };
}

/** Manual-entry sanitizer: keep digits only, capped at the code length. */
export function sanitizePairingCodeInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, PAIRING_CODE_LENGTH);
}
