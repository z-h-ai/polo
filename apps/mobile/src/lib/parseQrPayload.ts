// qrPayload parser (POL-240).
//
// Pure function so the scanner UI stays thin and the failure modes are unit
// tested. Accepted payloads mirror what the admin qr-login service emits
// (polo-admin src/lib/qr-login/service.ts buildQrPayload):
//   https://www.z-h-ai.com/qr-login?qrId=<base64url>&secret=<base64url>
// plus the app deep-link form (`polo://` — the app scheme in app.json) so a
// QR printed with the custom scheme also works.
//
// Anything else is invalid with a machine-readable reason so the UI can show
// the P10 「这不是 Polo 登录二维码」 layer vs. a broken-ticket hint.
//
// Hand-rolled URL split (no WHATWG URL): React Native does not ship a global
// URL, and the shapes accepted here are a tiny closed set.

/** qrId / secret charset+length per admin validation (qrIdSchema/qrSecretSchema). */
const QR_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const QR_SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** Hosts allowed for the https form (admin emits https://www.z-h-ai.com). */
const LOGIN_HOSTS = new Set(['www.z-h-ai.com', 'z-h-ai.com']);
const LOGIN_PATH = '/qr-login';

export type InvalidPayloadReason =
  /** Parses as a URL but is not a Polo login URL (wrong scheme/host/path). */
  | 'not_polo_payload'
  /** URL-looking string whose structure cannot be read at all. */
  | 'malformed_url'
  /** Polo login URL but qrId/secret missing or malformed. */
  | 'missing_params';

export type QrPayload =
  | { kind: 'valid'; qrId: string; secret: string }
  | { kind: 'invalid'; reason: InvalidPayloadReason };

interface SplitUrl {
  scheme: string;
  /** Lowercased host (https) or host (custom scheme); '' when absent. */
  host: string;
  /** Path starting with '/', or ''. */
  path: string;
  /** Raw query without the leading '?', or ''. */
  query: string;
  wellFormed: boolean;
}

/**
 * Reads the qrId+secret from a scanned QR payload.
 * Never throws — every non-conforming input maps to an invalid reason.
 */
export function parseQrPayload(raw: string): QrPayload {
  const input = raw.trim();
  if (!input) return { kind: 'invalid', reason: 'not_polo_payload' };

  const url = splitUrl(input);
  if (!url) return { kind: 'invalid', reason: 'not_polo_payload' };

  if (!url.wellFormed) return { kind: 'invalid', reason: 'malformed_url' };

  // https only: the admin service emits https://www.z-h-ai.com payloads and
  // nothing ever fetches this URL (the confirm goes to the configured api
  // base), so an http variant has no legitimate sender — fail closed.
  const isHttpsLogin =
    url.scheme === 'https' && LOGIN_HOSTS.has(url.host) && trimTrailingSlash(url.path) === LOGIN_PATH;
  const isAppDeepLink =
    url.scheme === 'polo' && trimTrailingSlash(url.path || (url.host ? `/${url.host}` : '')) === LOGIN_PATH;

  if (!isHttpsLogin && !isAppDeepLink) {
    return { kind: 'invalid', reason: 'not_polo_payload' };
  }

  const params = parseQuery(url.query);
  const qrId = params.get('qrId');
  const secret = params.get('secret');

  if (!qrId || !secret || !QR_ID_RE.test(qrId) || !QR_SECRET_RE.test(secret)) {
    return { kind: 'invalid', reason: 'missing_params' };
  }

  return { kind: 'valid', qrId, secret };
}

/**
 * Minimal URL splitter for the two accepted shapes. Returns null when the
 * input does not even look like a URL (no scheme separator); wellFormed is
 * false for scheme-bearing strings whose structure cannot be read.
 */
function splitUrl(input: string): SplitUrl | null {
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(input);
  if (!schemeMatch) return null;

  const scheme = (schemeMatch[1] ?? '').toLowerCase();
  const rest = input.slice(schemeMatch[0].length);
  const hashIndex = rest.indexOf('#');
  const beforeHash = hashIndex === -1 ? rest : rest.slice(0, hashIndex);

  const queryIndex = beforeHash.indexOf('?');
  const authorityAndPath = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : beforeHash.slice(queryIndex + 1);

  // Authority ends at the first '/' (https). Custom schemes may put the path
  // in the host slot (polo://qr-login?...), so no slash is required there.
  const slashIndex = authorityAndPath.indexOf('/');
  const authority = slashIndex === -1 ? authorityAndPath : authorityAndPath.slice(0, slashIndex);
  const path = slashIndex === -1 ? '' : authorityAndPath.slice(slashIndex);

  // https URLs need an authority; custom-scheme deep links may put the whole
  // path in the host slot (polo://qr-login?...), so accept either there.
  const wellFormed =
    scheme === 'https' || scheme === 'http' ? authority.length > 0 : authority.length + path.length > 0;

  return { scheme, host: authority.toLowerCase(), path, query, wellFormed };
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function parseQuery(query: string): Map<string, string> {
  const params = new Map<string, string>();
  if (!query) return params;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    if (!key) continue;
    try {
      params.set(decodeURIComponent(key), decodeURIComponent(value));
    } catch {
      // Malformed percent-encoding: keep the raw value; the charset check on
      // qrId/secret rejects anything it does not allow anyway.
      params.set(key, value);
    }
  }
  return params;
}
