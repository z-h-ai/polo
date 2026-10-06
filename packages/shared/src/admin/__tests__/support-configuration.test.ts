import { afterEach, describe, expect, it } from 'bun:test';
import { AdminClient } from '../client';
import {
  MemberCircleInvalidResponseError, parseSupportConfiguration, parseMemberCircleSupportState,
  SUPPORT_IMAGE_PATH, SUPPORT_MAX_IMAGE_BYTES,
} from '../member-circles';

// Unit image bytes, never a platform contact configuration.
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEtcAAAAASUVORK5CYII='), c => c.charCodeAt(0));
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
async function metadata(bytes = png) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return { configured: true as const, qrSha256: Buffer.from(digest).toString('hex'), qrContentType: 'image/png' as const,
    updatedAt: '2026-10-05T00:00:00.000Z', qrImageUrl: SUPPORT_IMAGE_PATH };
}
function imageResponse(bytes: Uint8Array, meta: Awaited<ReturnType<typeof metadata>>, headers: Record<string, string> = {}) {
  return new Response(bytes, { headers: { 'content-type': meta.qrContentType, 'content-sha256': meta.qrSha256, ...headers } });
}
function install(responses: (Response | (() => Response))[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error('unexpected request');
    return typeof response === 'function' ? response() : response;
  }) as typeof fetch;
  return calls;
}

describe('support pure boundary', () => {
  it('allowlists metadata and bridge fields without renderer secrets or URLs', async () => {
    const meta = await metadata();
    expect(parseSupportConfiguration({ ...meta, updatedBy: 'staff-secret' })).toEqual(meta);
    const state = { availability: 'available', configured: true, guidance: null, qrSha256: meta.qrSha256,
      qrContentType: meta.qrContentType, updatedAt: meta.updatedAt, qrDataUri: `data:image/png;base64,${Buffer.from(png).toString('base64')}` };
    expect(parseMemberCircleSupportState({ ...state, accessToken: 'secret' })).toEqual(state);
    for (const qrDataUri of ['https://foreign.example/qr', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,AAAA', state.qrDataUri + ' ']) {
      expect(() => parseMemberCircleSupportState({ ...state, qrDataUri })).toThrow(MemberCircleInvalidResponseError);
    }
    expect(() => parseMemberCircleSupportState({ availability: 'available', configured: true, guidance: null })).toThrow();
  });
  it('refuses foreign/changed endpoints, invalid digest/MIME/time and nonboolean configured', async () => {
    const meta = await metadata();
    for (const patch of [{ qrImageUrl: 'https://foreign.example/x' }, { qrImageUrl: '/api/support/configuration?image=2' },
      { qrSha256: meta.qrSha256.toUpperCase() }, { qrContentType: 'image/svg+xml' }, { updatedAt: 'yesterday' }, { configured: 'true' }]) {
      expect(() => parseSupportConfiguration({ ...meta, ...patch })).toThrow();
    }
    expect(parseSupportConfiguration({ configured: false, guidance: '未配置' })).toEqual({ configured: false, guidance: '未配置' });
  });
});

describe('AdminClient real support transport', () => {
  it('reads original bytes only from the fixed authenticated origin with no redirects', async () => {
    const meta = await metadata();
    const calls = install([Response.json(meta), imageResponse(png, meta)]);
    const result = await new AdminClient('https://admin.example').getSupportConfiguration('unit-token');
    expect(result).toEqual({ ...meta, bytes: png });
    expect(calls.map(c => c.url)).toEqual(['https://admin.example/api/support/configuration', `https://admin.example${SUPPORT_IMAGE_PATH}`]);
    for (const call of calls) {
      expect(call.init.redirect).toBe('manual');
      expect(call.init.headers).toMatchObject({ Authorization: 'Bearer unit-token' });
    }
  });
  it('does not fetch an image when genuinely unconfigured', async () => {
    const calls = install([Response.json({ configured: false, guidance: '未配置' })]);
    expect(await new AdminClient('https://admin.example').getSupportConfiguration('unit-token')).toEqual({ configured: false, guidance: '未配置' });
    expect(calls).toHaveLength(1);
  });
  it('rejects metadata redirects and foreign image paths before authenticated follow-up', async () => {
    const meta = await metadata();
    for (const response of [new Response(null, { status: 302, headers: { location: 'https://foreign.example' } }), Response.json({ ...meta, qrImageUrl: 'https://foreign.example' })]) {
      const calls = install([response]);
      await expect(new AdminClient('https://admin.example').getSupportConfiguration('unit-token')).rejects.toBeInstanceOf(MemberCircleInvalidResponseError);
      expect(calls).toHaveLength(1);
    }
    const calls = install([Response.json(meta), new Response(null, { status: 307, headers: { location: 'https://foreign.example' } })]);
    await expect(new AdminClient('https://admin.example').getSupportConfiguration('unit-token')).rejects.toBeInstanceOf(MemberCircleInvalidResponseError);
    expect(calls).toHaveLength(2);
  });
  it('fails closed on MIME/header digest/actual digest changes or empty bytes', async () => {
    const meta = await metadata();
    for (const response of [imageResponse(png, meta, { 'content-type': 'image/svg+xml' }),
      imageResponse(png, meta, { 'content-sha256': '0'.repeat(64) }), imageResponse(png.slice(0, 12), meta), imageResponse(new Uint8Array(), meta)]) {
      install([Response.json(meta), response]);
      await expect(new AdminClient('https://admin.example').getSupportConfiguration('unit-token')).rejects.toBeInstanceOf(MemberCircleInvalidResponseError);
    }
  });
  it('bounds chunked bytes even when Content-Length is absent or lies, and cancels overflow', async () => {
    const meta = await metadata();
    for (const contentLength of [undefined, '1']) {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
        cancel() { cancelled = true; },
      });
      install([Response.json(meta), new Response(stream, { headers: { 'content-type': 'image/png', 'content-sha256': meta.qrSha256, ...(contentLength ? { 'content-length': contentLength } : {}) } })]);
      await expect(new AdminClient('https://admin.example').getSupportConfiguration('unit-token')).rejects.toBeInstanceOf(MemberCircleInvalidResponseError);
      expect(cancelled).toBe(true);
    }
    expect(SUPPORT_MAX_IMAGE_BYTES).toBe(512 * 1024);
  });
  it('times out a half-open image body and cancels its reader', async () => {
    const meta = await metadata();
    let cancelled = false;
    install([Response.json(meta), new Response(new ReadableStream({ cancel() { cancelled = true; } }),
      { headers: { 'content-type': 'image/png', 'content-sha256': meta.qrSha256 } })]);
    await expect(new AdminClient('https://admin.example', { requestTimeoutMs: 30 }).getSupportConfiguration('unit-token')).rejects.toMatchObject({ errorCode: 'TIMEOUT' });
    expect(cancelled).toBe(true);
  });
  for (const status of [401, 403]) {
    it(`preserves definitive ${status} with a half-open error body`, async () => {
      let cancelled = false;
      install([new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status })]);
      await expect(new AdminClient('https://admin.example', { requestTimeoutMs: 30 }).getSupportConfiguration('unit-token')).rejects.toMatchObject({ status });
      expect(cancelled).toBe(true);
    });
  }
  it('uses refreshed credentials for BOTH metadata retry and binary receipt', async () => {
    const meta = await metadata();
    const calls = install([Response.json({}, { status: 401 }), Response.json({ accessToken: 'new-unit-token', refreshToken: 'new-refresh', expiresIn: 600 }), Response.json(meta), imageResponse(png, meta)]);
    const client = new AdminClient('https://admin.example', { tokenStore: { getRefreshToken: async () => 'old-refresh', onTokensRefreshed: async () => {} } });
    await client.getSupportConfiguration('old-unit-token');
    expect(calls[2]!.init.headers).toMatchObject({ Authorization: 'Bearer new-unit-token' });
    expect(calls[3]!.init.headers).toMatchObject({ Authorization: 'Bearer new-unit-token' });
  });
  it('uses one total deadline across metadata and binary body, not a fresh image budget', async () => {
    const meta = await metadata();
    let calls = 0, cancelled = false;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
        return Response.json(meta);
      }
      return new Response(new ReadableStream({
        start(controller) { setTimeout(() => { if (!cancelled) { controller.enqueue(png); controller.close(); } }, 30); },
        cancel() { cancelled = true; },
      }), { headers: { 'content-type': 'image/png', 'content-sha256': meta.qrSha256 } });
    }) as typeof fetch;
    await expect(new AdminClient('https://admin.example', { requestTimeoutMs: 45 }).getSupportConfiguration('unit-token')).rejects.toMatchObject({ errorCode: 'TIMEOUT' });
    expect(calls).toBe(2);
    expect(cancelled).toBe(true);
  });
  it('bounds pending credential refresh and preserves the already-observed 401', async () => {
    install([Response.json({}, { status: 401 })]);
    const client = new AdminClient('https://admin.example', { requestTimeoutMs: 25,
      tokenStore: { getRefreshToken: () => new Promise(() => {}) } });
    await expect(client.getSupportConfiguration('unit-token')).rejects.toMatchObject({ status: 401 });
  });
  it('preserves service status when a failed response has a non-JSON body', async () => {
    install([new Response('service unavailable', { status: 503 })]);
    await expect(new AdminClient('https://admin.example').getSupportConfiguration('unit-token')).rejects.toMatchObject({ status: 503, errorCode: 'SERVER_ERROR' });
  });
  it('refuses a non-origin Admin URL before fetching or sending credentials', async () => {
    const calls = install([]);
    for (const url of ['https://admin.example/base', 'https://user:pass@admin.example', 'file:///tmp/qr']) {
      await expect(new AdminClient(url).getSupportConfiguration('unit-token')).rejects.toBeInstanceOf(MemberCircleInvalidResponseError);
    }
    expect(calls).toHaveLength(0);
  });

});
