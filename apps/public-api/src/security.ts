import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_SHARE_BYTES = 10 * 1024 * 1024;
export const SHARE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const OAUTH_RELAY_TTL_MS = 10 * 60 * 1000;

export function createShareId(): string {
  return randomBytes(18).toString('base64url');
}

export function createWriteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createOpaqueToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashWriteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function writeTokenMatches(token: string | null, expectedHash: string): boolean {
  if (!token || !/^[A-Za-z0-9_-]{32,}$/.test(token)) return false;
  const suppliedHash = Buffer.from(hashWriteToken(token), 'hex');
  const storedHash = Buffer.from(expectedHash, 'hex');
  return suppliedHash.length === storedHash.length && timingSafeEqual(suppliedHash, storedHash);
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length < 0 || length > MAX_SHARE_BYTES) {
    throw new BodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) throw new InvalidJsonError();

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > MAX_SHARE_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(result.value);
  }

  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    throw new InvalidJsonError();
  }
}

export class BodyTooLargeError extends Error {}
export class InvalidJsonError extends Error {}

export function requestIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip');
}

export class FixedWindowRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }
}
