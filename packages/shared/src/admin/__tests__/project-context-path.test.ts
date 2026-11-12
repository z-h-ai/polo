import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AdminClient } from '../client.ts';

/**
 * POO-205 production incident guard: projectContextPath used to append
 * `?projectId=...` even when the suffix already carried its own query string,
 * planting a literal second '?' INSIDE the previous value — the admin route
 * parsed `limit=50?projectId=...`, the strict schema rejected it, and every
 * filtered asset list / download / search failed with a 400. The project id
 * must join the existing search params with '&'.
 */
let originalFetch: typeof globalThis.fetch;
let fetchUrls: string[] = [];

const assetDto = {
  id: 'asset-1',
  name: 'a.txt',
  tags: [],
  uploaderUserId: 'user-1',
  uploaderDisplayName: null,
  source: { kind: 'file', note: null },
  status: 'active',
  currentVersion: 1,
  revision: 1,
  pinned: false,
  pinnedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  trashedAt: null,
  trashExpiresAt: null,
  deletedById: null,
  current: {
    version: 1,
    sizeBytes: 1,
    mime: 'text/plain',
    checksumSha256: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdById: 'user-1',
    processing: 'indexed',
    confirmedAt: null,
    confirmedByUserId: null,
  },
};

function mockOkJson(responseBody: unknown) {
  fetchUrls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    void init;
    fetchUrls.push(url);
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

function expectSingleQueryMark(url: string): void {
  // exactly one '?' — the regression planted a second one inside a value
  expect((url.match(/\?/g) ?? []).length).toBe(1);
}

describe('AdminClient projectContextPath query joining', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('joins projectId with & when the list suffix carries its own query', async () => {
    mockOkJson({ assets: [], canManage: true });
    const client = new AdminClient('https://admin.example.com');
    await client.listProjectContextAssets('token', 'space-1', 'prj_abc', { view: 'active', limit: 50 });
    const url = new URL(fetchUrls[0]!);
    expect(url.pathname).toBe('/api/project-context/space-1/assets');
    expect(url.searchParams.get('view')).toBe('active');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('projectId')).toBe('prj_abc');
    expectSingleQueryMark(fetchUrls[0]!);
  });

  it('keeps the lone ?projectId query when the path has no suffix params', async () => {
    mockOkJson({
      assetId: 'asset-new',
      uploadId: 'upload-1',
      version: 1,
      uploadUrl: 'https://cos.example.com/put',
      method: 'PUT',
      requiredHeaders: {},
      expiresAt: '2026-01-01T00:05:00.000Z',
      asset: assetDto,
    });
    const client = new AdminClient('https://admin.example.com');
    await client.createProjectContextAsset('token', 'space-1', 'prj_abc', {
      name: 'a.txt',
      tags: [],
      sizeBytes: 1,
      mime: 'text/plain',
      checksumSha256: '0'.repeat(64),
    });
    const url = new URL(fetchUrls[0]!);
    expect(url.pathname).toBe('/api/project-context/space-1/assets');
    expect(url.searchParams.get('projectId')).toBe('prj_abc');
    expectSingleQueryMark(fetchUrls[0]!);
  });

  it('joins projectId with & for versioned download queries', async () => {
    mockOkJson({
      url: 'https://cos.example.com/signed',
      expiresAt: '2026-01-01T00:05:00.000Z',
      name: 'a.txt',
      mime: 'text/plain',
      sizeBytes: 1,
      disposition: 'attachment',
    });
    const client = new AdminClient('https://admin.example.com');
    await client.getProjectContextDownload('token', 'space-1', 'prj_abc', 'asset-1', 2);
    const url = new URL(fetchUrls[0]!);
    expect(url.pathname).toBe('/api/project-context/space-1/assets/asset-1/download');
    expect(url.searchParams.get('version')).toBe('2');
    expect(url.searchParams.get('projectId')).toBe('prj_abc');
    expectSingleQueryMark(fetchUrls[0]!);
  });
});
