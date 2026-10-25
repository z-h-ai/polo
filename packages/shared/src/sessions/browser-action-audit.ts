import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserActionAudit } from '../agent/browser-action-authorization';
/** Caller resolves this directory through trusted SessionStorage. Persist the
 * safe operation summary even when production debug logging is disabled. */
export async function appendBrowserActionAudit(sessionDirectory: string, event: BrowserActionAudit): Promise<void> {
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await appendFile(join(sessionDirectory, 'browser-action-audit.jsonl'), JSON.stringify({ version: 1, at: new Date().toISOString(), ...event }) + '\n', { encoding: 'utf8', mode: 0o600 });
}
