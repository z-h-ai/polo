import { extname, join, normalize, resolve } from 'node:path';
import {
  BodyTooLargeError,
  FixedWindowRateLimiter,
  InvalidJsonError,
  OAUTH_RELAY_TTL_MS,
  SHARE_TTL_MS,
  createOpaqueToken,
  createShareId,
  createWriteToken,
  hashWriteToken,
  readJsonBody,
  requestIp,
  writeTokenMatches,
} from './security.ts';
import {
  buildRelayRedirect,
  buildSlackRedirect,
  formatRelayState,
  isAllowedRelayDestination,
  parseRelayState,
} from './oauth.ts';
import type { ShareRepository } from './types.ts';

const SHARE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const EXPIRY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

export interface PublicApiOptions {
  repository: ShareRepository;
  allowedCallbacks: Set<string>;
  allowLoopbackCallbacks: boolean;
  viewerDistDir?: string;
  installScriptsDir?: string;
  writeRateLimit?: number;
}

export interface PublicApi {
  fetch(request: Request): Promise<Response>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function staticFilePath(root: string, pathname: string): string | null {
  const relative = normalize(pathname.replace(/^\/s\/?/, '')).replace(/^[/\\]+/, '');
  const filePath = resolve(root, relative);
  return filePath === root || filePath.startsWith(`${root}/`) ? filePath : null;
}

async function serveViewer(options: PublicApiOptions, pathname: string): Promise<Response | null> {
  if (!options.viewerDistDir || !pathname.startsWith('/s')) return null;
  const root = resolve(options.viewerDistDir);
  const candidate = staticFilePath(root, pathname);
  if (candidate && extname(candidate)) {
    const file = Bun.file(candidate);
    if (await file.exists()) {
      return new Response(file, {
        headers: { 'content-type': MIME_TYPES[extname(candidate)] ?? 'application/octet-stream' },
      });
    }
  }
  const index = Bun.file(join(root, 'index.html'));
  return (await index.exists())
    ? new Response(index, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
    : null;
}

async function serveInstaller(options: PublicApiOptions, pathname: string): Promise<Response | null> {
  if (!options.installScriptsDir || !['/install-app.sh', '/install-app.ps1'].includes(pathname)) return null;
  const file = Bun.file(join(options.installScriptsDir, pathname.slice(1)));
  if (!(await file.exists())) return null;
  return new Response(file, {
    headers: {
      'content-type': pathname.endsWith('.ps1') ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}

export function createPublicApi(options: PublicApiOptions): PublicApi {
  const rateLimiter = new FixedWindowRateLimiter(options.writeRateLimit ?? 30, 60_000);
  let lastExpiryCleanup = 0;

  async function purgeExpiredIfDue(): Promise<void> {
    const now = Date.now();
    if (now - lastExpiryCleanup < EXPIRY_CLEANUP_INTERVAL_MS) return;
    await options.repository.purgeExpired();
    lastExpiryCleanup = now;
  }

  return {
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const { pathname, searchParams } = url;
      const method = request.method.toUpperCase();
      const remoteAddress = requestIp(request);

      if (pathname === '/healthz' && method === 'GET') return json({ ok: true });

      if (pathname === '/auth/callback' && method === 'GET') {
        const outerState = searchParams.get('state');
        if (!outerState) return json({ error: 'Missing OAuth relay state' }, 400);
        const parsed = parseRelayState(outerState);
        if (!parsed) return json({ error: 'Invalid OAuth relay state' }, 400);
        const state = await options.repository.consumeOAuthRelayState(parsed.id, hashWriteToken(parsed.token));
        if (!state || !isAllowedRelayDestination(state.returnTo, options.allowedCallbacks, options.allowLoopbackCallbacks)) {
          return json({ error: 'Invalid OAuth relay state' }, 400);
        }
        return Response.redirect(buildRelayRedirect(state.returnTo, state.innerState, searchParams), 302);
      }

      if (pathname === '/auth/slack/callback' && method === 'GET') {
        const location = buildSlackRedirect(searchParams.get('port'), searchParams);
        return location
          ? Response.redirect(location, 302)
          : json({ error: 'Invalid Slack callback port' }, 400);
      }

      if (pathname === '/auth/state' && method === 'POST') {
        if (!rateLimiter.allow(`${remoteAddress ?? 'unknown'}:oauth-state`)) return json({ error: 'Rate limit exceeded' }, 429);
        try {
          const body = await readJsonBody(request);
          if (!isJsonObject(body) || typeof body.returnTo !== 'string' || typeof body.innerState !== 'string' ||
              body.returnTo.length > 2048 || body.innerState.length > 4096 ||
              !isAllowedRelayDestination(body.returnTo, options.allowedCallbacks, options.allowLoopbackCallbacks)) {
            return json({ error: 'OAuth callback destination is not registered' }, 400);
          }
          const id = createShareId();
          const token = createOpaqueToken();
          await purgeExpiredIfDue();
          await options.repository.createOAuthRelayState({
            id,
            tokenHash: hashWriteToken(token),
            returnTo: body.returnTo,
            innerState: body.innerState,
            expiresAt: new Date(Date.now() + OAUTH_RELAY_TTL_MS),
          });
          return json({ state: formatRelayState(id, token) }, 201);
        } catch (error) {
          if (error instanceof BodyTooLargeError) return json({ error: 'Request is too large' }, 413);
          if (error instanceof InvalidJsonError) return json({ error: 'Invalid JSON' }, 400);
          throw error;
        }
      }

      if (pathname === '/s/api' && method === 'POST') {
        if (!rateLimiter.allow(`${remoteAddress ?? 'unknown'}:create`)) return json({ error: 'Rate limit exceeded' }, 429);
        try {
          const payload = await readJsonBody(request);
          if (!isJsonObject(payload)) return json({ error: 'A shared session must be a JSON object' }, 400);
          const id = createShareId();
          const writeToken = createWriteToken();
          await purgeExpiredIfDue();
          await options.repository.create({
            id,
            payload,
            writeTokenHash: hashWriteToken(writeToken),
            expiresAt: new Date(Date.now() + SHARE_TTL_MS),
          }, { shareId: id, action: 'create', remoteAddress });
          return json({ id, url: `${url.origin}/s/${id}`, writeToken }, 201);
        } catch (error) {
          if (error instanceof BodyTooLargeError) return json({ error: 'Share is too large' }, 413);
          if (error instanceof InvalidJsonError) return json({ error: 'Invalid JSON' }, 400);
          throw error;
        }
      }

      const shareMatch = pathname.match(/^\/s\/api\/([A-Za-z0-9_-]+)$/);
      if (shareMatch) {
        const id = shareMatch[1]!;
        if (!SHARE_ID.test(id)) return json({ error: 'Not found' }, 404);
        const session = await options.repository.getActive(id);
        if (!session) return json({ error: 'Not found' }, 404);

        if (method === 'GET') return json(session.payload);
        if (!['PUT', 'DELETE'].includes(method)) return empty(405);
        if (!rateLimiter.allow(`${remoteAddress ?? 'unknown'}:${method}`)) return json({ error: 'Rate limit exceeded' }, 429);
        if (!writeTokenMatches(request.headers.get('x-polo-share-token'), session.writeTokenHash)) {
          return json({ error: 'A valid write token is required' }, 401);
        }

        if (method === 'DELETE') {
          await options.repository.delete(id, { shareId: id, action: 'delete', remoteAddress });
          return empty(204);
        }

        try {
          const payload = await readJsonBody(request);
          if (!isJsonObject(payload)) return json({ error: 'A shared session must be a JSON object' }, 400);
          const updated = await options.repository.update(id, payload, { shareId: id, action: 'update', remoteAddress });
          return updated ? empty(204) : json({ error: 'Not found' }, 404);
        } catch (error) {
          if (error instanceof BodyTooLargeError) return json({ error: 'Share is too large' }, 413);
          if (error instanceof InvalidJsonError) return json({ error: 'Invalid JSON' }, 400);
          throw error;
        }
      }

      const installer = await serveInstaller(options, pathname);
      if (installer) return installer;
      const viewer = await serveViewer(options, pathname);
      if (viewer) return viewer;
      return json({ error: 'Not found' }, 404);
    },
  };
}
