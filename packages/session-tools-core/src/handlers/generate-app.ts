/**
 * Generate App Handler
 *
 * Creates single-file HTML canvas apps (Generative UI Track 2) inside the
 * session data directory. This handler is the fail-closed gate — the bundle
 * is untrusted model output and must never reach the sandbox able to call
 * home or touch the host bridge:
 *
 * 1. Hard size cap (GENERATE_APP_MAX_HTML_BYTES, UTF-8 bytes).
 * 2. Static scan: no external http(s) resource references — src/href (quoted
 *    and unquoted), srcset, CSS url() and @import, inline fetch/WebSocket/XHR
 *    call strings, and data: URI payloads one bounded decode deep (base64 or
 *    percent), all applied to an entity-decoded copy of the markup; w3.org
 *    XML namespaces are the only exemption — they are identifiers, never
 *    fetched — plus no `@polo-ai/sdk` literal, and `poloai:` references
 *    confined to the sanctioned `poloai://action/ui-event/` bridge link
 *    (POO-103). Main additionally installs a fail-closed request fence on
 *    every canvas partition, so this scan is defense in depth, not the last
 *    line.
 * 3. Artifacts live only under `<session data>/genui-apps/<id>/` — ids are
 *    validated against a strict pattern, so updateOf can never traverse.
 * 4. Update semantics = full atomic rewrite (temp name + rename) + version
 *    increment (version.json). No zip, no polo-app.json — that identity is
 *    written by the publish flow, not by session-local generation.
 *
 * The tool is only registered for desktop interactive turns while the
 * generativeUI.canvas toggle is on (see tool-defs.ts allowGenerateApp); the
 * optional ctx.isGenerateAppEnabled callback re-checks the toggle at call
 * time so mid-session disable takes effect on the next tool call.
 */

import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
  appDir: string;
  indexPath: string;
  versionPath: string;
}

/**
 * Atomic single-file write: the content lands at a unique temp name in the
 * target directory and is renamed over the target. Readers (the loading
 * webview, the pin gate) see either the previous document or the complete new
 * one — never a torn file.
 */
function writeAtomic(filePath: string, data: string): void {
  const tempPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tempPath, data, 'utf-8');
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp file may never have been created; the original error wins.
    }
    throw error;
  }
}

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * External-resource scan. Extracts the values behind src=/href= attributes
 * and CSS url(...) and rejects any http(s) reference. `xmlns` attributes are
 * exempt ONLY when their value points at the w3.org namespaces — those are
 * XML namespace identifiers, never fetched, and blocking them would break
 * every inline <svg>.
 *
 * POO-102 review hardening: the scan runs on an entity-decoded copy of the
 * markup (&#104;ttps:// in an attribute decodes exactly once, matching what
 * the HTML parser hands the browser), covers unquoted attribute values,
 * srcset, the CSS `@import "…"` string form, inline fetch/WebSocket/XHR-style
 * network calls, and decodes one bounded level of data: URI payloads so a
 * base64- (or percent-) wrapped iframe/document carrying external links is
 * rejected with its payload.
 */
const EXTERNAL_REF_PATTERNS: Array<{ label: string; regex: RegExp; groups: number[] }> = [
  // Group 2 = double-quoted value, group 3 = single-quoted value.
  { label: 'src/href attribute', regex: /\b(?:src|href)\s*=\s*("([^"]*)"|'([^']*)')/gi, groups: [2, 3] },
  // Unquoted attribute value form: src=https://… (run ends at whitespace or a
  // tag close; the quoted forms above never match here because the value
  // class excludes quotes). srcset is included so its unquoted single-entry
  // form is covered too — the quoted srcset form is matched separately below.
  { label: 'unquoted src/href/srcset attribute', regex: /\b(?:src|href|srcset)\s*=\s*([^\s>'"]+)/gi, groups: [1] },
  // Group 2 = double-quoted srcset, group 3 = single-quoted; the value is a
  // comma-separated candidate list whose entries are "url [descriptor]".
  { label: 'srcset attribute', regex: /\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, groups: [2, 3] },
  // Group 2 = url(...) body.
  { label: 'CSS url()', regex: /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, groups: [2] },
  // CSS @import in its string form (the url() form is covered above).
  { label: 'CSS @import', regex: /@import\s+(['"])([^'"]+)\1/gi, groups: [2] },
  // Inline script network calls, best-effort string-level coverage: fetch,
  // WebSocket (ws(s)), EventSource, sendBeacon, XHR open, dynamic import.
  // No JS parser — this is the second fence behind the session-level network
  // fence Main installs on canvas partitions. Group 1 captures the URL so the
  // shared http(s) test below applies to the address, not the call text.
  {
    label: 'inline network call',
    regex: /\b(?:fetch|new\s+WebSocket|WebSocket|EventSource|sendBeacon|import)\s*\(\s*(['"`])\s*(wss?:[^\s'"`)]*|https?:[^\s'"`)]*)/gi,
    groups: [2],
  },
  // XHR: .open('GET', 'https://…') or .open('https://…').
  {
    label: 'inline network call',
    regex: /\.open\s*\(\s*(?:['"][A-Z]+['"]\s*,\s*)?(['"])(https?:[^'"]*)/gi,
    groups: [2],
  },
];

const XMLNS_ATTR_PATTERN = /\bxmlns(?::[A-Za-z0-9_-]+)?\s*=\s*("([^"]*)"|'([^']*)')/gi;
const XMLNS_ALLOWLIST = /^https?:\/\/(?:www\.)?w3\.org\//i;

/** Literal that would pull the host SDK into a session artifact. */
const SDK_REFERENCE_PATTERN = /@polo-ai\/sdk/i;
/** Deep-link protocol that only exists to reach the host bridge. */
const POLOAI_PROTOCOL_PATTERN = /poloai:/i;
/**
 * POO-103: the one sanctioned poloai:// form — the ui-event bridge. A bundle
 * may reference exactly this shape; every other poloai: link stays rejected.
 * (The deep link itself is still gated host-side by capability + sender
 * validation, so referencing it without the meta declaration is inert.)
 */
const ALLOWED_POLOAI_UI_EVENT_PATTERN = /poloai:\/\/action\/ui-event\//gi;

/**
 * data: payload extraction for the two document-carrying forms. Bounded
 * recursion (MAX_SCAN_DEPTH) so a payload cannot hide behind more encodings
 * than this; payload size is bounded by the 512KB document cap upstream.
 */
const BASE64_DATA_URI_PATTERN = /data:[^"'`\s]*;base64,([A-Za-z0-9+/=]{16,})/gi;
const ENCODED_DOCUMENT_DATA_URI_PATTERN =
  /data:(?:text\/html|image\/svg|application\/xhtml)[^"'`\s]*,[^"'`\s]{8,}/gi;
const MAX_SCAN_DEPTH = 2;

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * One-pass HTML entity decode over the common numeric forms and the named
 * entities an attribute value realistically needs. Decoding once mirrors the
 * browser: a value the parser would see as "https://…" must be scanned as
 * "https://…", while double-encoded content stays inert in the DOM too.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{0,31});/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 0x23 /* # */) {
      const hex = body.charCodeAt(1) === 0x78 /* x */;
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_HTML_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function decodeDataUriPayload(uriText: string): string | null {
  try {
    const base64Idx = uriText.toLowerCase().indexOf(';base64,');
    if (base64Idx >= 0) {
      const encoded = uriText.slice(base64Idx + ';base64,'.length);
      return Buffer.from(encoded, 'base64').toString('utf-8');
    }
    const commaIdx = uriText.indexOf(',');
    if (commaIdx < 0) return null;
    return decodeURIComponent(uriText.slice(commaIdx + 1));
  } catch {
    // Malformed encodings are inert for this scan — nothing more to extract.
    return null;
  }
}

export function findExternalResourceReference(html: string): { kind: string; value: string } | null {
  return findExternalResourceReferenceInText(decodeHtmlEntities(html), 0);
}

function findExternalResourceReferenceInText(
  text: string,
  depth: number,
): { kind: string; value: string } | null {
  const xmlnsValues = new Set<string>();
  for (const match of text.matchAll(XMLNS_ATTR_PATTERN)) {
    const value = (match[2] ?? match[3] ?? '').trim();
    if (value) xmlnsValues.add(value);
  }

  for (const { label, regex, groups } of EXTERNAL_REF_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const candidates = groups.map(group => (match[group] ?? '').trim());
      for (const raw of candidates) {
        if (!raw) continue;
        // srcset carries a candidate list: every entry's URL (text before the
        // first whitespace) is checked on its own.
        const refs = label === 'srcset attribute'
          ? raw.split(',').map(entry => entry.trim().split(/\s+/)[0] ?? '')
          : [raw];
        for (const ref of refs) {
          // wss?:// is accepted here for the inline-call patterns — a
          // WebSocket endpoint in an attribute is inert anyway, and scanning
          // broader only ever tightens.
          if (!ref || !/^(?:https?|wss?):\/\//i.test(ref)) continue;
          // xmlns values are identifiers; a src/href/url() pointing at a w3.org
          // namespace is still an external reference and stays rejected.
          if (xmlnsValues.has(ref) && XMLNS_ALLOWLIST.test(ref)) continue;
          return { kind: label, value: ref };
        }
      }
    }
  }

  if (depth >= MAX_SCAN_DEPTH) return null;
  for (const pattern of [BASE64_DATA_URI_PATTERN, ENCODED_DOCUMENT_DATA_URI_PATTERN]) {
    for (const match of text.matchAll(pattern)) {
      const decoded = decodeDataUriPayload(match[0]);
      if (!decoded) continue;
      const nested = findExternalResourceReferenceInText(decoded, depth + 1);
      if (nested) {
        return {
          kind: `external reference inside a data: URI payload (${nested.kind})`,
          value: nested.value,
        };
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
    const withoutUiEventBridge = html.replace(ALLOWED_POLOAI_UI_EVENT_PATTERN, '');
    if (POLOAI_PROTOCOL_PATTERN.test(withoutUiEventBridge)) {
      return errorResponse(
        'html must not reference the poloai:// protocol — the only sanctioned form is the poloai://action/ui-event/ host-bridge link (see the tool description). Remove the other link and retry.'
      );
    }
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
    resolved = {
      appId: updateOf,
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
      appDir,
      indexPath: join(appDir, 'index.html'),
      versionPath: join(appDir, 'version.json'),
    };
  }

  // Concurrency semantics for racing updateOf calls on one app id (POO-102
  // review): each write swaps index.html atomically (temp name + rename, so a
  // loading webview never sees a torn document), then RE-READS the version
  // counter and swaps version.json the same way. Two racing updates can still
  // interleave to the same "next" version and last-writer-wins on the
  // document — session-local generation has no cross-writer lock — but the
  // invariants that matter hold: version.json is only bumped after the
  // document it describes is already fully in place, both files are always
  // individually complete, and a version can never regress below the counter
  // observed at write time.
  let version: number;
  try {
    mkdirSync(resolved.appDir, { recursive: true });
    writeAtomic(resolved.indexPath, html);
    version = readVersion(resolved.versionPath) + 1;
    writeAtomic(
      resolved.versionPath,
      `${JSON.stringify({ version, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(`Failed to write the app bundle: ${msg}`);
  }

  const lines = [
    `Generative UI app "${title}" ${updateOf ? `updated to v${version}` : 'created (v1)'}.`,
    `App id: ${resolved.appId}`,
    `Entry: ${resolved.indexPath}`,
    'It is now rendering in a sandboxed card below. To iterate, resend the COMPLETE html with updateOf set to this app id.',
    // Machine-readable marker consumed by the desktop renderer (webview card
    // + pin-to-tab). Keep the shape stable.
    `[genui-app id="${resolved.appId}" version="${version}" path="${resolved.indexPath}"]`,
  ];

  return successResponse(lines.join('\n'));
}
