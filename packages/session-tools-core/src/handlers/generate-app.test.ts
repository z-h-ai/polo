import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionToolContext } from '../context.ts';
import { handleGenerateApp, findExternalResourceReference, decodeHtmlEntities } from './generate-app.ts';
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

  // ── POO-102 review vectors ────────────────────────────────────────────────

  it('rejects external references in srcset attributes (quoted and unquoted)', () => {
    expect(
      findExternalResourceReference('<img srcset="https://cdn.example.com/a.png 1x, /local.png 2x">'),
    ).toMatchObject({ kind: 'srcset attribute', value: 'https://cdn.example.com/a.png' });
    expect(
      findExternalResourceReference("<source srcset='https://cdn.example.com/b.webp 1x'>"),
    ).toMatchObject({ kind: 'srcset attribute' });
    expect(
      findExternalResourceReference('<img srcset=https://cdn.example.com/c.png 1x>'),
    ).toMatchObject({ kind: 'unquoted src/href/srcset attribute' });
    // Local-only candidate lists stay allowed.
    expect(findExternalResourceReference('<img srcset="/a.png 1x, b.png 2x">')).toBeNull();
  });

  it('rejects unquoted external attribute values', () => {
    expect(findExternalResourceReference('<img src=https://cdn.example.com/a.png>')).toMatchObject({
      kind: 'unquoted src/href/srcset attribute',
      value: 'https://cdn.example.com/a.png',
    });
    expect(findExternalResourceReference('<a href=http://evil.example/x>go</a>')).toMatchObject({
      kind: 'unquoted src/href/srcset attribute',
    });
  });

  it('rejects CSS @import in its string form', () => {
    expect(findExternalResourceReference('<style>@import "https://fonts.example/x.css";</style>')).toMatchObject({
      kind: 'CSS @import',
      value: 'https://fonts.example/x.css',
    });
    expect(findExternalResourceReference("<style>@import 'http://evil.example/y.css';</style>")).toMatchObject({
      kind: 'CSS @import',
    });
    // Local @import stays allowed.
    expect(findExternalResourceReference('<style>@import "theme.css";</style>')).toBeNull();
  });

  it('decodes HTML entities before scanning', () => {
    expect(decodeHtmlEntities('&#104;ttps://x')).toBe('https://x');
    expect(decodeHtmlEntities('&#x68;ttps://x')).toBe('https://x');
    expect(decodeHtmlEntities('a&amp;b')).toBe('a&b');
    expect(decodeHtmlEntities('Tom &#38; Jerry')).toBe('Tom & Jerry');
    // The decoded markup is what gets scanned: an entity-hidden external src.
    expect(
      findExternalResourceReference('<img src="&#104;ttps://cdn.example.com/track.png">'),
    ).toMatchObject({ kind: 'src/href attribute' });
    // A protocol-relative unquoted value is not http(s)-prefixed — inert
    // offline — but the quoted entity-encoded absolute form must trip.
    expect(
      findExternalResourceReference('<style>@import &#x22;&#104;ttps://f.example/x.css&#x22;;</style>'),
    ).toMatchObject({ kind: 'CSS @import' });
  });

  it('rejects inline fetch/WebSocket/XHR network call strings', () => {
    expect(findExternalResourceReference('<script>fetch("https://evil.example/beacon")</script>')).toMatchObject({
      kind: 'inline network call',
    });
    expect(findExternalResourceReference("<script>new WebSocket('wss://evil.example/socket')</script>")).toMatchObject({
      kind: 'inline network call',
    });
    expect(
      findExternalResourceReference('<script>const x = new XMLHttpRequest(); x.open("GET", "https://evil.example/collect");</script>'),
    ).toMatchObject({ kind: 'inline network call' });
    expect(findExternalResourceReference('<script>navigator.sendBeacon(`https://evil.example/ping`)</script>')).toMatchObject({
      kind: 'inline network call',
    });
    // Plain text mentioning a URL without a call context stays allowed.
    expect(findExternalResourceReference('<p>Docs live at https://example.com/docs</p>')).toBeNull();
  });

  it('rejects external links smuggled inside base64 or percent-encoded data: documents', () => {
    const iframeHtml = '<img src="https://evil.example/track.png">';
    const b64 = Buffer.from(iframeHtml, 'utf-8').toString('base64');
    expect(
      findExternalResourceReference(`<iframe src="data:text/html;base64,${b64}"></iframe>`),
    ).toMatchObject({ kind: 'external reference inside a data: URI payload (src/href attribute)' });

    const percentEncoded = encodeURIComponent('<script>fetch("https://evil.example/p")</script>');
    expect(
      findExternalResourceReference(`<iframe src="data:text/html;charset=utf-8,${percentEncoded}"></iframe>`),
    ).toMatchObject({ kind: 'external reference inside a data: URI payload (inline network call)' });

    // An inert payload stays allowed.
    const inert = Buffer.from('<p>safe</p>', 'utf-8').toString('base64');
    expect(findExternalResourceReference(`<iframe src="data:text/html;base64,${inert}"></iframe>`)).toBeNull();
  });

  it('scans nested data: payloads within the bounded depth', () => {
    // One layer of base64 inside another: still visible to the depth-2 scan.
    const inner = Buffer.from('<img src="https://evil.example/deep.png">', 'utf-8').toString('base64');
    const middle = Buffer.from(`<iframe src="data:text/html;base64,${inner}"></iframe>`, 'utf-8').toString('base64');
    const nested = findExternalResourceReference(`<iframe src="data:text/html;base64,${middle}"></iframe>`);
    expect(nested?.kind).toContain('data: URI payload');
    expect(nested?.value).toBe('https://evil.example/deep.png');
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

  it('rejects poloai:// forms that merely prefix the sanctioned ui-event path', async () => {
    const result = await handleGenerateApp(ctx(), {
      title: 'Bridge app',
      html: '<!DOCTYPE html><html><body><a href="poloai://action/ui-eventx/abc">bridge</a></body></html>',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('poloai://');
  });

  it('accepts the sanctioned poloai://action/ui-event/ bridge link (POO-103)', async () => {
    const html = [
      '<!DOCTYPE html><html><head>',
      '<meta name="polo-bridge-capabilities" content="ui-event">',
      '</head><body><button id="go"></button><script>',
      'const q = new URLSearchParams(location.search);',
      `const url = \`poloai://action/ui-event/\${q.get("poloSession")}?cardId=\${q.get("poloCard")}&eventId=e1&type=button-click&callbackId=callback-1\`;`,
      'location.href = url;',
      '</script></body></html>',
    ].join('');
    const result = await handleGenerateApp(ctx(), { title: 'Bridge app', html });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('[genui-app ');
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

  it('atomic updateOf: no torn or temp files, and versions stay monotonic under racing calls', async () => {
    const first = await handleGenerateApp(ctx(), { title: 'Race', html: '<html><body>v1</body></html>' });
    expect(first.isError).toBe(false);
    const appId = appIdFrom(first);

    // Two racing updates of the same app. Semantics documented on the write
    // block: each call swaps index.html atomically (temp + rename), re-reads
    // the counter after the swap, then swaps version.json atomically — so
    // both documents are always complete and the version never regresses,
    // while the surviving document is simply last-writer-wins.
    const [a, b] = await Promise.all([
      handleGenerateApp(ctx(), { title: 'Race', html: '<html><body>race-a</body></html>', updateOf: appId }),
      handleGenerateApp(ctx(), { title: 'Race', html: '<html><body>race-b</body></html>', updateOf: appId }),
    ]);
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);

    const appDir = join(dataDir, 'genui-apps', appId);
    // No temp leftovers: every write either renamed or cleaned up.
    expect(readdirSync(appDir).filter(name => name.includes('.tmp-'))).toEqual([]);

    // The surviving document is exactly one of the two complete payloads.
    const finalHtml = readFileSync(join(appDir, 'index.html'), 'utf-8');
    expect(
      finalHtml === '<html><body>race-a</body></html>' || finalHtml === '<html><body>race-b</body></html>',
    ).toBe(true);

    // The counter is at least one bump beyond v1 and never went backwards.
    const version = JSON.parse(readFileSync(join(appDir, 'version.json'), 'utf-8')).version;
    expect(version).toBeGreaterThanOrEqual(2);
    expect(version).toBeLessThanOrEqual(3);
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
