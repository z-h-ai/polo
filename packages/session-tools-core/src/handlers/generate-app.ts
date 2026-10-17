/**
 * Generate App Handler
 *
 * Creates single-file HTML canvas apps (Generative UI Track 2) inside the
 * session data directory. This handler is the fail-closed gate — the bundle
 * is untrusted model output and must never reach the sandbox able to call
 * home or touch the host bridge:
 *
 * 1. Hard size cap (GENERATE_APP_MAX_HTML_BYTES, UTF-8 bytes).
 * 2. Static scan: no external http(s) resource references (src/href/CSS
 *    url(); w3.org XML namespaces are the only exemption — they are
 *    identifiers, never fetched), no `@polo-ai/sdk` literal, no `poloai:`
 *    protocol references.
 * 3. Artifacts live only under `<session data>/genui-apps/<id>/` — ids are
 *    validated against a strict pattern, so updateOf can never traverse.
 * 4. Update semantics = full rewrite + version increment (version.json).
 *    No zip, no polo-app.json — that identity is written by the publish
 *    flow, not by session-local generation.
 *
 * The tool is only registered for desktop interactive turns while the
 * generativeUI.canvas toggle is on (see tool-defs.ts allowGenerateApp); the
 * optional ctx.isGenerateAppEnabled callback re-checks the toggle at call
 * time so mid-session disable takes effect on the next tool call.
 */

import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { isPathWithinDirectory, isPathWithinDirectoryForCreation } from '../runtime/path-security.ts';
import {
  GenerateAppSchema,
  GENERATE_APP_MAX_HTML_BYTES,
  GENERATE_APP_MAX_ID_LENGTH,
} from '../tool-defs.ts';

export interface GenerateAppArgs {
  title: string;
  html: string;
  updateOf?: string;
}

interface ResolvedApp {
  appId: string;
  version: number;
  appDir: string;
  indexPath: string;
  versionPath: string;
}

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * External-resource scan. Extracts the values behind src=/href= attributes
 * and CSS url(...) and rejects any http(s) reference. `xmlns` attributes are
 * exempt ONLY when their value points at the w3.org namespaces — those are
 * XML namespace identifiers, never fetched, and blocking them would break
 * every inline <svg>.
 */
const EXTERNAL_REF_PATTERNS: Array<{ label: string; regex: RegExp; groups: number[] }> = [
  // Group 2 = double-quoted value, group 3 = single-quoted value.
  { label: 'src/href attribute', regex: /\b(?:src|href)\s*=\s*("([^"]*)"|'([^']*)')/gi, groups: [2, 3] },
  // Group 2 = url(...) body.
  { label: 'CSS url()', regex: /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, groups: [2] },
];

const XMLNS_ATTR_PATTERN = /\bxmlns(?::[A-Za-z0-9_-]+)?\s*=\s*("([^"]*)"|'([^']*)')/gi;
const XMLNS_ALLOWLIST = /^https?:\/\/(?:www\.)?w3\.org\//i;

/** Literal that would pull the host SDK into a session artifact. */
const SDK_REFERENCE_PATTERN = /@polo-ai\/sdk/i;
/** Deep-link protocol that only exists to reach the host bridge. */
const POLOAI_PROTOCOL_PATTERN = /poloai:/i;

export function findExternalResourceReference(html: string): { kind: string; value: string } | null {
  const xmlnsValues = new Set<string>();
  for (const match of html.matchAll(XMLNS_ATTR_PATTERN)) {
    const value = (match[2] ?? match[3] ?? '').trim();
    if (value) xmlnsValues.add(value);
  }

  for (const { label, regex, groups } of EXTERNAL_REF_PATTERNS) {
    for (const match of html.matchAll(regex)) {
      for (const group of groups) {
        const ref = (match[group] ?? '').trim();
        if (!ref) continue;
        if (!/^https?:\/\//i.test(ref)) continue;
        // xmlns values are identifiers; a src/href/url() pointing at a w3.org
        // namespace is still an external reference and stays rejected.
        if (xmlnsValues.has(ref) && XMLNS_ALLOWLIST.test(ref)) continue;
        return { kind: label, value: ref };
      }
    }
  }
  return null;
}

function formatValidationIssues(error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return error.issues
    .slice(0, 10)
    .map(issue => `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(payload)'}: ${issue.message}`)
    .join('; ');
}

function readVersion(versionPath: string): number {
  if (!existsSync(versionPath)) return 0;
  try {
    const raw = JSON.parse(readFileSync(versionPath, 'utf-8')) as { version?: unknown };
    return typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version > 0 ? raw.version : 0;
  } catch {
    return 0;
  }
}

/**
 * Handle the generate_app tool call: validate, then write the bundle under
 * the session data dir. Returns a success summary whose final line is a
 * machine-readable marker the renderer parses to mount the webview card and
 * wire the pin-to-tab action.
 */
export async function handleGenerateApp(
  ctx: SessionToolContext,
  args: GenerateAppArgs
): Promise<ToolResult> {
  // Call-time toggle re-check (defense in depth): registration already gated
  // the tool, but a mid-session toggle change must take effect on the next
  // call without a hot un-registration.
  if (ctx.isGenerateAppEnabled && !ctx.isGenerateAppEnabled()) {
    return errorResponse('generate_app is disabled by the Generative UI feature toggle.');
  }

  if (!ctx.dataPath) {
    return errorResponse('generate_app requires a session data directory.');
  }

  const parsed = GenerateAppSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return errorResponse(
      `Invalid generate_app payload — fix the issues and retry. Issues: ${formatValidationIssues(parsed.error)}`
    );
  }
  const { title, html, updateOf } = parsed.data;

  const htmlBytes = Buffer.byteLength(html, 'utf8');
  if (htmlBytes > GENERATE_APP_MAX_HTML_BYTES) {
    return errorResponse(
      `html is ${htmlBytes} bytes; the hard limit is ${GENERATE_APP_MAX_HTML_BYTES} bytes (512KB). Reduce inline assets (embed images as compressed data: URIs or drop them) and retry.`
    );
  }

  const externalRef = findExternalResourceReference(html);
  if (externalRef) {
    return errorResponse(
      `html must be fully self-contained: rejected external ${externalRef.kind} "${externalRef.value.slice(0, 200)}". Inline all CSS/JS and use data: URIs for images/fonts — no CDN, no web fonts, no hotlinks.`
    );
  }

  if (SDK_REFERENCE_PATTERN.test(html)) {
    return errorResponse(
      'html must not reference @polo-ai/sdk — session apps are not trusted host documents and get no SDK capabilities. Remove the reference and retry.'
    );
  }

  if (POLOAI_PROTOCOL_PATTERN.test(html)) {
    return errorResponse(
      'html must not reference the poloai:// protocol — session apps run without a host bridge. Remove the link and retry.'
    );
  }

  // Resolve the target app directory strictly inside <data>/genui-apps/.
  // The fixed-name root is created up front (idempotent, trusted path from
  // session storage) so the containment checks below decide in real-path
  // space — a not-yet-existing boundary would compare lexical fallbacks and
  // spuriously fail on symlinked prefixes (macOS /var → /private/var).
  const appsRoot = resolve(ctx.dataPath, 'genui-apps');
  try {
    mkdirSync(appsRoot, { recursive: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(`Failed to prepare the app directory: ${msg}`);
  }
  let resolved: ResolvedApp;
  if (updateOf) {
    if (!APP_ID_PATTERN.test(updateOf) || updateOf.length > GENERATE_APP_MAX_ID_LENGTH) {
      return errorResponse(`updateOf must be an app id returned by a previous generate_app call. Got: ${updateOf}`);
    }
    const appDir = resolve(appsRoot, updateOf);
    // updateOf targets an EXISTING app dir, so the existing-path variant is
    // the right check: it real-paths both sides (the creation variant only
    // real-paths the nearest existing ancestor, which mixes a real base with
    // a lexical target and fails under symlinked prefixes like macOS /var).
    if (!isPathWithinDirectory(appDir, appsRoot) || !existsSync(appDir)) {
      return errorResponse(
        `updateOf app not found: ${updateOf}. List the id from the previous generate_app result, or omit updateOf to create a new app.`
      );
    }
    const version = readVersion(join(appDir, 'version.json')) + 1;
    resolved = {
      appId: updateOf,
      version,
      appDir,
      indexPath: join(appDir, 'index.html'),
      versionPath: join(appDir, 'version.json'),
    };
  } else {
    const appId = `app-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const appDir = resolve(appsRoot, appId);
    if (!isPathWithinDirectoryForCreation(appDir, appsRoot)) {
      return errorResponse('Could not allocate an app directory inside the session data directory.');
    }
    resolved = {
      appId,
      version: 1,
      appDir,
      indexPath: join(appDir, 'index.html'),
      versionPath: join(appDir, 'version.json'),
    };
  }

  try {
    mkdirSync(resolved.appDir, { recursive: true });
    writeFileSync(resolved.indexPath, html, 'utf-8');
    writeFileSync(
      resolved.versionPath,
      `${JSON.stringify({ version: resolved.version, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf-8'
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(`Failed to write the app bundle: ${msg}`);
  }

  const lines = [
    `Generative UI app "${title}" ${updateOf ? `updated to v${resolved.version}` : 'created (v1)'}.`,
    `App id: ${resolved.appId}`,
    `Entry: ${resolved.indexPath}`,
    'It is now rendering in a sandboxed card below. To iterate, resend the COMPLETE html with updateOf set to this app id.',
    // Machine-readable marker consumed by the desktop renderer (webview card
    // + pin-to-tab). Keep the shape stable.
    `[genui-app id="${resolved.appId}" version="${resolved.version}" path="${resolved.indexPath}"]`,
  ];

  return successResponse(lines.join('\n'));
}
