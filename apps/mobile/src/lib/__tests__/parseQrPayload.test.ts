// POL-15 unit tests for parseQrPayload (bun test, pure functions).
//
// Covers: the admin-emitted https payload, the polo:// deep-link form, host/
// path/scheme validation, malformed URLs, missing/bad qrId+secret, and
// non-Polo payloads.

import { describe, expect, test } from 'bun:test';

import { parseQrPayload } from '../parseQrPayload';

const QR_ID = 'aGVsbG8td29ybGQteWVhaA'; // base64url-ish, 16+ chars
const SECRET = 'c2VjcmV0LXNlY3JldC12YWx1ZQ';

function httpsPayload(host = 'www.z-h-ai.com', query = `qrId=${QR_ID}&secret=${SECRET}`) {
  return `https://${host}/qr-login?${query}`;
}

describe('parseQrPayload — valid payloads', () => {
  test('accepts the admin-emitted https://www.z-h-ai.com payload', () => {
    expect(parseQrPayload(httpsPayload())).toEqual({ kind: 'valid', qrId: QR_ID, secret: SECRET });
  });

  test('accepts the apex host and trailing slash', () => {
    expect(parseQrPayload(`https://z-h-ai.com/qr-login/?qrId=${QR_ID}&secret=${SECRET}`)).toEqual({
      kind: 'valid',
      qrId: QR_ID,
      secret: SECRET,
    });
  });

  test('accepts a fragment after the query and extra params', () => {
    const payload = `https://www.z-h-ai.com/qr-login?qrId=${QR_ID}&secret=${SECRET}&src=web#top`;
    expect(parseQrPayload(payload)).toEqual({ kind: 'valid', qrId: QR_ID, secret: SECRET });
  });

  test('host check is case-insensitive and whitespace is trimmed (scanner output)', () => {
    expect(parseQrPayload(`  HTTPS://WWW.Z-H-AI.COM/qr-login?qrId=${QR_ID}&secret=${SECRET} `)).toEqual({
      kind: 'valid',
      qrId: QR_ID,
      secret: SECRET,
    });
  });

  test('accepts the polo:// deep-link form (host slot)', () => {
    expect(parseQrPayload(`polo://qr-login?qrId=${QR_ID}&secret=${SECRET}`)).toEqual({
      kind: 'valid',
      qrId: QR_ID,
      secret: SECRET,
    });
  });

  test('accepts the polo:// deep-link form (path form)', () => {
    expect(parseQrPayload(`polo://app/qr-login?qrId=${QR_ID}&secret=${SECRET}`)).toEqual({
      kind: 'valid',
      qrId: QR_ID,
      secret: SECRET,
    });
  });
});

describe('parseQrPayload — 非 Polo 载荷', () => {
  test('rejects a different host', () => {
    expect(parseQrPayload(`https://example.com/qr-login?qrId=${QR_ID}&secret=${SECRET}`)).toEqual({
      kind: 'invalid',
      reason: 'not_polo_payload',
    });
  });

  test('rejects a lookalike host (suffix match must not pass)', () => {
    expect(parseQrPayload(`https://evil-z-h-ai.com/qr-login?qrId=${QR_ID}&secret=${SECRET}`)).toEqual({
      kind: 'invalid',
      reason: 'not_polo_payload',
    });
  });

  test('rejects a hosted lookalike (subdomain-of-attacker shape)', () => {
    expect(
      parseQrPayload(`https://www.z-h-ai.com.evil.com/qr-login?qrId=${QR_ID}&secret=${SECRET}`),
    ).toEqual({ kind: 'invalid', reason: 'not_polo_payload' });
  });

  test('rejects a userinfo trick (z-h-ai.com@evil.com)', () => {
    expect(
      parseQrPayload(`https://z-h-ai.com@evil.com/qr-login?qrId=${QR_ID}&secret=${SECRET}`),
    ).toEqual({ kind: 'invalid', reason: 'not_polo_payload' });
  });

  test('rejects a port variant (admin never emits one; fail closed)', () => {
    expect(
      parseQrPayload(`https://z-h-ai.com:443/qr-login?qrId=${QR_ID}&secret=${SECRET}`),
    ).toEqual({ kind: 'invalid', reason: 'not_polo_payload' });
  });

  test('rejects the http downgrade (admin emits https only)', () => {
    expect(parseQrPayload(`http://www.z-h-ai.com/qr-login?qrId=${QR_ID}&secret=${SECRET}`)).toEqual({
      kind: 'invalid',
      reason: 'not_polo_payload',
    });
  });

  test('rejects a wrong path on the right host', () => {
    expect(parseQrPayload(`https://www.z-h-ai.com/login?qrId=${QR_ID}&secret=${SECRET}`)).toEqual({
      kind: 'invalid',
      reason: 'not_polo_payload',
    });
  });

  test('rejects other schemes', () => {
    expect(parseQrPayload(`weixin://qr-login?qrId=${QR_ID}&secret=${SECRET}`)).toEqual({
      kind: 'invalid',
      reason: 'not_polo_payload',
    });
    expect(parseQrPayload(`ftp://www.z-h-ai.com/qr-login?qrId=${QR_ID}&secret=${SECRET}`)).toEqual({
      kind: 'invalid',
      reason: 'not_polo_payload',
    });
  });

  test('rejects plain text and empty input', () => {
    expect(parseQrPayload('hello world')).toEqual({ kind: 'invalid', reason: 'not_polo_payload' });
    expect(parseQrPayload('   ')).toEqual({ kind: 'invalid', reason: 'not_polo_payload' });
    expect(parseQrPayload(`${QR_ID}&${SECRET}`)).toEqual({ kind: 'invalid', reason: 'not_polo_payload' });
  });
});

describe('parseQrPayload — 畸形 URL', () => {
  test('rejects https with an empty authority', () => {
    expect(parseQrPayload('https:///qr-login?qrId=1')).toEqual({
      kind: 'invalid',
      reason: 'malformed_url',
    });
  });

  test('rejects a bare polo:// with nothing in it', () => {
    expect(parseQrPayload('polo://')).toEqual({ kind: 'invalid', reason: 'malformed_url' });
  });
});

describe('parseQrPayload — 缺参 / 非法参数', () => {
  test('missing query entirely', () => {
    expect(parseQrPayload('https://www.z-h-ai.com/qr-login')).toEqual({
      kind: 'invalid',
      reason: 'missing_params',
    });
  });

  test('qrId present but secret missing', () => {
    expect(parseQrPayload(`https://www.z-h-ai.com/qr-login?qrId=${QR_ID}`)).toEqual({
      kind: 'invalid',
      reason: 'missing_params',
    });
  });

  test('empty values', () => {
    expect(parseQrPayload('https://www.z-h-ai.com/qr-login?qrId=&secret=')).toEqual({
      kind: 'invalid',
      reason: 'missing_params',
    });
  });

  test('values below the admin length floor (16) are rejected', () => {
    expect(
      parseQrPayload(`https://www.z-h-ai.com/qr-login?qrId=abc123456789012&secret=${SECRET}`),
    ).toEqual({ kind: 'invalid', reason: 'missing_params' });
  });

  test('values with characters outside base64url are rejected', () => {
    expect(parseQrPayload(`https://www.z-h-ai.com/qr-login?qrId=${QR_ID}&secret=${SECRET}/evil`)).toEqual({
      kind: 'invalid',
      reason: 'missing_params',
    });
  });

  test('percent-encoded values are decoded before the charset check', () => {
    // %61.. = 'a...' — decodes to a valid base64url qrId.
    const encodedId = encodeURIComponent(QR_ID);
    expect(parseQrPayload(`https://www.z-h-ai.com/qr-login?qrId=${encodedId}&secret=${SECRET}`)).toEqual({
      kind: 'valid',
      qrId: QR_ID,
      secret: SECRET,
    });
    // '+' is not base64url even when encoded.
    expect(
      parseQrPayload(`https://www.z-h-ai.com/qr-login?qrId=${QR_ID}&secret=${encodeURIComponent('abc+def/ghi+jkl')}`),
    ).toEqual({ kind: 'invalid', reason: 'missing_params' });
    // Broken percent-encoding falls back to the raw value, which the regex rejects.
    expect(
      parseQrPayload(`https://www.z-h-ai.com/qr-login?qrId=${QR_ID}&secret=%ZZ${SECRET}`),
    ).toEqual({ kind: 'invalid', reason: 'missing_params' });
  });

  test('overlong values above the admin caps are rejected', () => {
    const longId = 'a'.repeat(65);
    const longSecret = 'b'.repeat(129);
    expect(parseQrPayload(`https://www.z-h-ai.com/qr-login?qrId=${longId}&secret=${SECRET}`)).toEqual({
      kind: 'invalid',
      reason: 'missing_params',
    });
    expect(parseQrPayload(`https://www.z-h-ai.com/qr-login?qrId=${QR_ID}&secret=${longSecret}`)).toEqual({
      kind: 'invalid',
      reason: 'missing_params',
    });
  });

  test('duplicate params: the last occurrence wins (URLSearchParams semantics)', () => {
    expect(
      parseQrPayload(`https://www.z-h-ai.com/qr-login?qrId=short&qrId=${QR_ID}&secret=${SECRET}`),
    ).toEqual({ kind: 'valid', qrId: QR_ID, secret: SECRET });
    expect(
      parseQrPayload(`https://www.z-h-ai.com/qr-login?qrId=${QR_ID}&secret=${SECRET}&secret=short`),
    ).toEqual({ kind: 'invalid', reason: 'missing_params' });
  });

  test('a query placed after the fragment is not read (missing secret)', () => {
    expect(parseQrPayload(`https://www.z-h-ai.com/qr-login#?qrId=${QR_ID}&secret=${SECRET}`)).toEqual({
      kind: 'invalid',
      reason: 'missing_params',
    });
  });
});
