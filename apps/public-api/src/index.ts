import { SQL } from 'bun';
import { createPublicApi } from './app.ts';
import { parseAllowedCallbackUrls } from './oauth.ts';
import { PostgresShareRepository } from './postgres-repository.ts';

const port = Number(process.env.PORT ?? '3000');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const repository = new PostgresShareRepository(new SQL(databaseUrl));
await repository.initialize();

const app = createPublicApi({
  repository,
  allowedCallbacks: parseAllowedCallbackUrls(process.env.OAUTH_RELAY_ALLOWED_CALLBACKS),
  allowLoopbackCallbacks: process.env.OAUTH_RELAY_ALLOW_LOOPBACK === 'true',
  viewerDistDir: process.env.VIEWER_DIST_DIR ?? '/app/apps/viewer/dist',
  installScriptsDir: process.env.INSTALL_SCRIPTS_DIR ?? '/app/scripts',
});

Bun.serve({ port, fetch: app.fetch });
console.log(`Polo public API listening on ${port}`);
