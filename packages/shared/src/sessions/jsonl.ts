/**
 * JSONL Session Storage
 *
 * Helpers for reading/writing sessions in JSONL format.
 * Format: Line 1 = SessionHeader, Lines 2+ = StoredMessage (one per line)
 */

import { openSync, readSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { open, readFile } from 'fs/promises';
import { dirname } from 'path';
import type { SessionHeader, StoredSession, StoredMessage, SessionTokenUsage } from './types.ts';
import type { PermissionMode } from '../agent/mode-types.ts';
import { parsePermissionMode } from '../agent/mode-types.ts';
import { toPortablePath, expandPath, normalizePath } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';
import { safeJsonParse } from '../utils/files.ts';
import { pickSessionFields } from './utils.ts';

// ============================================================
// Session Path Portability
// ============================================================

const SESSION_PATH_TOKEN = '{{SESSION_PATH}}';

/**
 * Replace absolute session directory paths with a portable token.
 * Applied after JSON.stringify so paths embedded anywhere in message content
 * (datatable src, planPath, attachment storedPath, etc.) are made portable.
 */
export function makeSessionPathPortable(jsonLine: string, sessionDir: string): string {
  if (!sessionDir) return jsonLine;
  const normalized = normalizePath(sessionDir);
  let result = jsonLine.replaceAll(normalized, SESSION_PATH_TOKEN);
  // On Windows, also replace JSON-escaped backslash paths
  // (JSON.stringify escapes \ to \\, so C:\foo becomes C:\\foo in JSON strings)
  if (sessionDir !== normalized) {
    const jsonEscaped = sessionDir.replaceAll('\\', '\\\\');
    result = result.replaceAll(jsonEscaped, SESSION_PATH_TOKEN);
  }
  return result;
}

/**
 * Expand the portable session path token back to an absolute path.
 * Applied before JSON.parse so all path references resolve correctly at runtime.
 */
export function expandSessionPath(jsonLine: string, sessionDir: string): string {
  if (!jsonLine.includes(SESSION_PATH_TOKEN)) return jsonLine;
  return jsonLine.replaceAll(SESSION_PATH_TOKEN, normalizePath(sessionDir));
}

function normalizePermissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string') return undefined;
  return parsePermissionMode(value) ?? undefined;
}

function normalizeHeaderPermissionModes<T extends SessionHeader>(header: T): T {
  const permissionMode = normalizePermissionMode(header.permissionMode);
  const previousPermissionMode = normalizePermissionMode(header.previousPermissionMode);

  if (permissionMode) {
    header.permissionMode = permissionMode;
  } else {
    delete (header as Partial<SessionHeader>).permissionMode;
  }

  if (previousPermissionMode) {
    header.previousPermissionMode = previousPermissionMode;
  } else {
    delete (header as Partial<SessionHeader>).previousPermissionMode;
  }

  return header;
}

// Session JSONL headers carry full metadata (including pendingQuestion, up to
// 3 questions × 4 options of multi-byte text), so the first line has no fixed
// upper bound. Read with a growing buffer until the line terminator is found —
// a fixed buffer truncates legal headers into corrupt JSON.
const HEADER_INITIAL_BYTES = 16 * 1024;
const HEADER_MAX_BYTES = 512 * 1024;

/** Decode buffer[0..byteLength) with any trailing incomplete UTF-8 sequence removed. */
function stripPartialUtf8Tail(buffer: Buffer, byteLength: number): string {
  if (byteLength <= 0) return '';
  // Walk back at most 3 bytes to find the start of the last sequence.
  const maxLookback = Math.min(4, byteLength);
  for (let i = 1; i < maxLookback; i++) {
    const byte = buffer[byteLength - i];
    if (byte === undefined) break;
    if ((byte & 0xc0) !== 0x80) {
      // Leading byte found: if it announces a sequence longer than what was
      // read, the read boundary split a multi-byte character — trim it.
      const sequenceLength = (byte & 0xe0) === 0xc0 ? 2
        : (byte & 0xf0) === 0xe0 ? 3
        : (byte & 0xf8) === 0xf0 ? 4
        : 1;
      if (i < sequenceLength) {
        return buffer.toString('utf8', 0, byteLength - i);
      }
      break;
    }
  }
  return buffer.toString('utf8', 0, byteLength);
}

/** Parse the header line from a decoded chunk, or report that more bytes are needed. */
function parseHeaderChunk(text: string, sessionFile: string, bytesRead: number, bufferSize: number):
  { header: SessionHeader | null; needsMore: boolean } {
  const firstNewline = text.indexOf('\n');
  if (firstNewline > 0) {
    const firstLine = text.slice(0, firstNewline);
    const parsed = safeJsonParse(expandSessionPath(firstLine, dirname(sessionFile))) as SessionHeader;
    return { header: normalizeHeaderPermissionModes(parsed), needsMore: false };
  }
  // No newline: EOF reached (bytesRead < bufferSize) or cap exhausted — parse
  // what we have (a header line is the first line, so EOF without newline is
  // still the whole header). A parse failure surfaces as null via the caller.
  if (bytesRead < bufferSize || bufferSize >= HEADER_MAX_BYTES) {
    const parsed = safeJsonParse(expandSessionPath(text, dirname(sessionFile))) as SessionHeader;
    return { header: normalizeHeaderPermissionModes(parsed), needsMore: false };
  }
  return { header: null, needsMore: true };
}

/**
 * Read only the header (first line) from a session.jsonl file.
 * Uses low-level fs with a growing buffer so multi-byte, schema-maximal
 * pendingQuestion headers are never truncated into corrupt JSON.
 */
export function readSessionHeader(sessionFile: string): SessionHeader | null {
  try {
    const fd = openSync(sessionFile, 'r');
    let bufferSize = HEADER_INITIAL_BYTES;
    try {
      for (;;) {
        const buffer = Buffer.alloc(bufferSize);
        const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
        // A read boundary may split a multi-byte UTF-8 character — strip any
        // trailing partial sequence before decoding, or JSON strings corrupt.
        const text = stripPartialUtf8Tail(buffer, bytesRead);
        const { header, needsMore } = parseHeaderChunk(text, sessionFile, bytesRead, bufferSize);
        if (!needsMore) return header;
        bufferSize = Math.min(bufferSize * 4, HEADER_MAX_BYTES);
      }
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    debug('[jsonl] Failed to read session header:', sessionFile, error);
    return null;
  }
}

/**
 * Read full session from JSONL file.
 * Parses header and all message lines.
 */
export function readSessionJsonl(sessionFile: string): StoredSession | null {
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    const firstLine = lines[0];
    if (!firstLine) return null;

    const sessionDir = dirname(sessionFile);
    const header = normalizeHeaderPermissionModes(
      safeJsonParse(expandSessionPath(firstLine, sessionDir)) as SessionHeader
    );
    // Parse messages resiliently: skip lines that fail to parse (e.g. truncated by crash)
    // rather than losing the entire session's messages.
    // Expand session path tokens before parsing so embedded paths resolve correctly.
    const expandedMessageLines = lines.slice(1).map(line => expandSessionPath(line, sessionDir));
    const messages = parseMessagesResilient(expandedMessageLines);

    // Migration: For sessions created before sdkCwd was added, use workingDirectory as fallback.
    // This is correct because the old code used workingDirectory for SDK's cwd parameter.
    const workingDir = header.workingDirectory ? expandPath(header.workingDirectory) : undefined;
    const sdkCwd = header.sdkCwd ? expandPath(header.sdkCwd) : workingDir;

    return {
      ...pickSessionFields(header),
      // Path expansion for portable paths
      workspaceRootPath: expandPath(header.workspaceRootPath),
      workingDirectory: workingDir,
      sdkCwd,
      // Runtime fields
      messages,
      tokenUsage: header.tokenUsage,
    } as StoredSession;
  } catch (error) {
    debug('[jsonl] Failed to read session:', sessionFile, error);
    return null;
  }
}

/**
 * Write session to JSONL format using atomic write (write-to-temp-then-rename).
 * Prevents file corruption if the process crashes mid-write: either the old
 * file remains intact or the new file is fully written. Never a partial file.
 *
 * Line 1: Header with pre-computed metadata
 * Lines 2+: Messages (one per line)
 */
export function writeSessionJsonl(sessionFile: string, session: StoredSession): void {
  const header = createSessionHeader(session);
  const sessionDir = dirname(sessionFile);

  const lines = [
    makeSessionPathPortable(JSON.stringify(header), sessionDir),
    ...session.messages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
  ];

  const tmpFile = sessionFile + '.tmp';
  writeFileSync(tmpFile, lines.join('\n') + '\n');
  // On Windows, rename fails if target exists. Delete first for cross-platform compatibility.
  try { unlinkSync(sessionFile); } catch { /* ignore if doesn't exist */ }
  renameSync(tmpFile, sessionFile);
}

/**
 * Create a SessionHeader from a StoredSession.
 * Pre-computes messageCount, preview, and lastMessageRole for fast list loading.
 * Uses pickSessionFields() to ensure all persistent fields are included.
 */
export function createSessionHeader(session: StoredSession): SessionHeader {
  return {
    ...pickSessionFields(session),
    // Path conversion for portability
    workspaceRootPath: toPortablePath(session.workspaceRootPath),
    // Override lastUsedAt with current timestamp (save time, not original)
    lastUsedAt: Date.now(),
    // Pre-computed fields
    messageCount: session.messages.length,
    lastMessageRole: extractLastMessageRole(session.messages),
    preview: extractPreview(session.messages),
    tokenUsage: session.tokenUsage,
    lastFinalMessageId: extractLastFinalMessageId(session.messages),
    // Pending question badge (derived so the session list never loads messages)
    hasPendingQuestion: !!session.pendingQuestion,
    pendingQuestionRequestId: session.pendingQuestion?.requestId,
  } as SessionHeader;
}

/**
 * Extract the role of the last message for badge display.
 * Only returns roles that are meaningful for UI display (user, assistant, plan, tool, error).
 */
function extractLastMessageRole(messages: StoredMessage[]): SessionHeader['lastMessageRole'] {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return undefined;
  // Map message types to the subset we care about for display
  const role = lastMessage.type;
  if (role === 'user' || role === 'assistant' || role === 'plan' || role === 'tool' || role === 'error') {
    return role;
  }
  return undefined;
}

/**
 * Extract the ID of the last final (non-intermediate) assistant message.
 * Used for unread detection in session list without loading all messages.
 */
function extractLastFinalMessageId(messages: StoredMessage[]): string | undefined {
  // Walk backwards to find the last assistant message that isn't intermediate
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.type === 'assistant' && !msg.isIntermediate) {
      return msg.id;
    }
  }
  return undefined;
}

/**
 * Extract preview from first user message.
 * Sanitizes by stripping special blocks and normalizing whitespace.
 * Returns first 150 chars.
 */
function extractPreview(messages: StoredMessage[]): string | undefined {
  const firstUserMessage = messages.find(m => m.type === 'user');
  if (!firstUserMessage?.content) return undefined;

  // Sanitize: strip special blocks, tags, and bracket mentions, normalize whitespace
  const sanitized = firstUserMessage.content
    .replace(/<edit_request>[\s\S]*?<\/edit_request>/g, '') // Strip entire edit_request blocks
    .replace(/<[^>]+>/g, '')     // Strip remaining XML/HTML tags
    .replace(/\[skill:(?:[\w-]+:)?[\w-]+\]/g, '')   // Strip [skill:...] mentions
    .replace(/\[source:[\w-]+\]/g, '')              // Strip [source:...] mentions
    .replace(/\[file:[^\]]+\]/g, '')                // Strip [file:...] mentions
    .replace(/\[folder:[^\]]+\]/g, '')              // Strip [folder:...] mentions
    .replace(/\s+/g, ' ')        // Collapse whitespace (including newlines)
    .trim();

  return sanitized.substring(0, 150) || undefined;
}

/**
 * Async version of readSessionHeader for parallel I/O.
 * Uses fs/promises for non-blocking reads.
 */
export async function readSessionHeaderAsync(sessionFile: string): Promise<SessionHeader | null> {
  try {
    const handle = await open(sessionFile, 'r');
    try {
      // Same growing-buffer contract as readSessionHeader: never truncate a
      // legal multi-byte header line into corrupt JSON.
      let bufferSize = HEADER_INITIAL_BYTES;
      for (;;) {
        const buffer = Buffer.alloc(bufferSize);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const text = stripPartialUtf8Tail(buffer, bytesRead);
        const { header, needsMore } = parseHeaderChunk(text, sessionFile, bytesRead, bufferSize);
        if (!needsMore) return header;
        bufferSize = Math.min(bufferSize * 4, HEADER_MAX_BYTES);
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    debug('[jsonl] Failed to read session header async:', sessionFile, error);
    return null;
  }
}

/**
 * Read only messages from a JSONL file (skips header).
 * Used for lazy loading when session is selected.
 * Resilient to corrupted/truncated lines (skips them instead of failing entirely).
 */
export function readSessionMessages(sessionFile: string): StoredMessage[] {
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    // Skip first line (header), expand session path tokens, parse rest as messages resiliently
    const sessionDir = dirname(sessionFile);
    const expandedLines = lines.slice(1).map(line => expandSessionPath(line, sessionDir));
    return parseMessagesResilient(expandedLines);
  } catch (error) {
    debug('[jsonl] Failed to read session messages:', sessionFile, error);
    return [];
  }
}

/**
 * Parse message lines resiliently: skip lines that fail JSON.parse
 * (e.g. truncated by a crash mid-write) rather than losing all messages.
 */
function parseMessagesResilient(lines: string[]): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as StoredMessage);
    } catch {
      // Corrupted/truncated line (likely from a crash during write).
      // Skip it and continue — losing one message is better than losing all.
      debug('[jsonl] Skipping corrupted message line (truncated?):', line.substring(0, 100));
    }
  }
  return messages;
}
