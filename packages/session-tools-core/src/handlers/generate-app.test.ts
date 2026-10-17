import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionToolContext } from '../context.ts';
import { handleGenerateApp, findExternalResourceReference } from './generate-app.ts';
import { GenerateAppSchema, GENERATE_APP_MAX_HTML_BYTES } from '../tool-defs.ts';

// ============================================================
// Static scan
// ============================================================

describe('generate_app external-resource scan', () => {
  it('rejects http(s) src/href and CSS url() references', () => {
    expect(findExternalResourceReference('<img src="https://cdn.example.com/a.png">')).toMatchObject({ kind: 'src/href attribute' });
    expect(findExternalResourceReference("<script src='http://evil.example/x.js'></script>")).toMatchObject({ kind: 'src/href attribute' });
    expect(findExternalResourceReference('<link href="https://fonts.example/style.css" rel="stylesheet">')).toMatchObject({ kind: 'src/href attribute' });
    expect(findExternalResourceReference('<style>body { background: url(https://img.example/bg.png) }</style>')).toMatchObject({ kind: 'CSS url()' });
    expect(findExternalResourceReference('<style>@font-face { src: url("https://f.example/x.woff2") }</style>')).toMatchObject({ kind: 'CSS url()' });
  });

  it('allows data: URIs, relative refs, and protocol-free inline content', () => {
    expect(findExternalResourceReference('<img src="data:image/png;base64,AAAA">')).toBeNull();
    expect(findExternalResourceReference('<a href="#section">jump</a>')).toBeNull();
    expect(findExternalResourceReference('<style>body { background: url(data:image/gif;base64,R0lGOD) }</style>')).toBeNull();
  });

  it('exempts w3.org XML namespaces but not fetched w3.org resources', () => {
    expect(findExternalResourceReference('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')).toBeNull();
    expect(findExternalResourceReference('<html xmlns:x="https://www.w3.org/1999/xhtml"><body/></html>')).toBeNull();
    expect(findExternalResourceReference('<img src="https://www.w3.org/2000/svg">')).not.toBeNull();
  });
});

// ============================================================
// Schema validation
// ============================================================

describe('generate_app schema validation', () => {
  it('accepts a minimal new-app payload', () => {
    const result = GenerateAppSchema.safeParse({ title: 'Tip calculator', html: '<!DOCTYPE html><html><body>hi</body></html>' });
    expect(result.success).toBe(true);
  });

  it('rejects ids and updateOf that could traverse', () => {
    for (const bad of ['../evil', 'a/b', '', 'a'.repeat(65), '.hidden']) {
      const result = GenerateAppSchema.safeParse({ title: 'x', html: '<p>y</p>', updateOf: bad });
      expect(result.success).toBe(false);
    }
  });
});

// ============================================================
// Handler fail-closed paths + artifact writing
// ============================================================

describe('generate_app handler', () => {
  let rootDir: string;
  let dataDir: string;

  function ctx(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
    return {
      sessionId: 'test-session',
      workspacePath: rootDir,
      sourcesPath: join(rootDir, 'sources'),
      skillsPath: join(rootDir, 'skills'),
      plansFolderPath: join(rootDir, 'session', 'plans'),
      callbacks: {
        onPlanSubmitted: () => {},
        onAuthRequest: () => {},
      },
      fs: {
        exists: () => false,
        readFile: () => '',
        readFileBuffer: () => Buffer.from(''),
        writeFile: () => {},
        isDirectory: () => false,
        readdir: () => [],
        stat: () => ({ size: 0, isDirectory: () => false }),
      },
      loadSourceConfig: () => null,
      dataPath: dataDir,
      ...overrides,
    };
  }

  const VALID_HTML = '<!DOCTYPE html><html><head><style>body{color:red}</style></head><body><h1>Hi</h1></body></html>';

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'generate-app-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function appIdFrom(result: { content: Array<{ text: string }> }): string {
    const text = result.content[0]?.text ?? '';
    const marker = text.split('\n').find(l => l.startsWith('[genui-app '));
    expect(marker).toBeDefined();
    const id = /id="([^"]+)"/.exec(marker!)?.[1];
    expect(id).toBeDefined();
    return id!;
  }

  it('creates a new app: writes index.html + version.json under data/genui-apps/<id>/', async () => {
    const result = await handleGenerateApp(ctx(), { title: 'Tip calculator', html: VALID_HTML });
    expect(result.isError).toBe(false);

    const appId = appIdFrom(result);
    const indexPath = join(dataDir, 'genui-apps', appId, 'index.html');
    expect(existsSync(indexPath)).toBe(true);
    expect(readFileSync(indexPath, 'utf-8')).toBe(VALID_HTML);

    const version = JSON.parse(readFileSync(join(dataDir, 'genui-apps', appId, 'version.json'), 'utf-8'));
    expect(version.version).toBe(1);

    // No zip, no polo-app.json — identity belongs to the publish flow.
    expect(existsSync(join(dataDir, 'genui-apps', `${appId}.zip`))).toBe(false);
    expect(existsSync(join(dataDir, 'genui-apps', appId, 'polo-app.json'))).toBe(false);
  });

  it('rejects external http(s) resource references', async () => {
    const result = await handleGenerateApp(ctx(), {
      title: 'Leaky app',
      html: '<!DOCTYPE html><html><body><img src="https://cdn.example.com/track.png"></body></html>',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('external');
  });

  it('rejects @polo-ai/sdk references', async () => {
    const result = await handleGenerateApp(ctx(), {
      title: 'SDK app',
      html: '<!DOCTYPE html><html><body><script>const sdk = "@polo-ai/sdk";</script></body></html>',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('@polo-ai/sdk');
  });

  it('rejects poloai:// protocol references', async () => {
    const result = await handleGenerateApp(ctx(), {
      title: 'Bridge app',
      html: '<!DOCTYPE html><html><body><a href="poloai://action/foo">bridge</a></body></html>',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('poloai://');
  });

  it('rejects html over the 512KB hard cap and does not write anything', async () => {
    const bigHtml = `${VALID_HTML}<!-- ${'x'.repeat(GENERATE_APP_MAX_HTML_BYTES)} -->`;
    expect(Buffer.byteLength(bigHtml, 'utf8')).toBeGreaterThan(GENERATE_APP_MAX_HTML_BYTES);

    const result = await handleGenerateApp(ctx(), { title: 'Big app', html: bigHtml });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('512');
    expect(existsSync(join(dataDir, 'genui-apps'))).toBe(false);
  });

  it('increments the version on updateOf and fully rewrites index.html', async () => {
    const first = await handleGenerateApp(ctx(), { title: 'Dashboard', html: '<html><body>v1</body></html>' });
    expect(first.isError).toBe(false);
    const appId = appIdFrom(first);

    const second = await handleGenerateApp(ctx(), {
      title: 'Dashboard',
      html: '<html><body>v2 completely rewritten</body></html>',
      updateOf: appId,
    });
    expect(second.isError).toBe(false);
    expect(second.content[0]?.text).toContain('v2');

    const indexPath = join(dataDir, 'genui-apps', appId, 'index.html');
    expect(readFileSync(indexPath, 'utf-8')).toContain('v2 completely rewritten');
    const version = JSON.parse(readFileSync(join(dataDir, 'genui-apps', appId, 'version.json'), 'utf-8'));
    expect(version.version).toBe(2);
  });

  it('rejects updateOf pointing at a non-existent app', async () => {
    const result = await handleGenerateApp(ctx(), {
      title: 'Orphan',
      html: VALID_HTML,
      updateOf: 'app-does-not-exist',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not found');
  });

  it('rejects updateOf ids that escape the apps root', async () => {
    // The schema pattern already blocks separators; assert the handler guard too.
    const result = await handleGenerateApp(ctx(), {
      title: 'Escape',
      html: VALID_HTML,
      updateOf: '..',
    });
    expect(result.isError).toBe(true);
  });

  it('refuses to run when the canvas toggle is off at call time', async () => {
    const result = await handleGenerateApp(ctx({ isGenerateAppEnabled: () => false }), {
      title: 'Off',
      html: VALID_HTML,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('disabled');
  });
});
