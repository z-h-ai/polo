const RELAY_PREFIX = 'ca2.';

export function parseRelayState(value: string): { id: string; token: string } | null {
  const match = value.match(/^ca2\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{24,128})$/);
  return match ? { id: match[1]!, token: match[2]! } : null;
}

export function formatRelayState(id: string, token: string): string {
  return `${RELAY_PREFIX}${id}.${token}`;
}

export function parseAllowedCallbackUrls(value: string | undefined): Set<string> {
  const result = new Set<string>();
  for (const raw of (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('OAUTH_RELAY_ALLOWED_CALLBACKS must contain HTTPS callback URLs without credentials or fragments');
    }
    result.add(callbackKey(url));
  }
  return result;
}

export function isAllowedRelayDestination(value: string, allowedCallbacks: Set<string>, allowLoopback: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (allowedCallbacks.has(callbackKey(url))) return true;
  if (!allowLoopback || url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) return false;
  const port = Number(url.port);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && url.pathname === '/callback';
}

function callbackKey(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

export function buildRelayRedirect(returnTo: string, innerState: string, query: URLSearchParams): string {
  const target = new URL(returnTo);
  for (const key of ['code', 'error', 'error_description', 'state']) target.searchParams.delete(key);
  for (const key of ['code', 'error', 'error_description']) {
    const value = query.get(key);
    if (value) target.searchParams.set(key, value);
  }
  target.searchParams.set('state', innerState);
  return target.toString();
}

export function buildSlackRedirect(portValue: string | null, query: URLSearchParams): string | null {
  if (!portValue || !/^\d{1,5}$/.test(portValue)) return null;
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  const target = new URL(`http://127.0.0.1:${port}/callback`);
  for (const key of ['code', 'error', 'error_description', 'state']) {
    const value = query.get(key);
    if (value) target.searchParams.set(key, value);
  }
  return target.toString();
}
