/**
 * Pending-question header boundary (review round 3, issue #2).
 *
 * A Schema-maximal pendingQuestion (3 questions × 4 options, all multi-byte
 * CJK at the per-field character caps) produces a JSONL header line larger
 * than 16 KiB. The old fixed-size read truncated such headers into corrupt
 * JSON; the reader must grow until the line terminator.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionFilePath,
  readSessionHeader,
  writeSessionJsonl,
  type StoredSession,
} from '@polo-ai/shared/sessions'
import { readSessionHeaderAsync } from '../jsonl.ts'
import type { QuestionRequest } from '@polo-ai/shared/protocol'

// Per-field caps copied from the canonical RequestUserInput schema
// (session-tools-core/src/question-types.ts) — keep in sync intentionally.
const MAX_QUESTIONS = 3
const MAX_OPTIONS = 4
const Q_ID = 'q' + 'x'.repeat(62) // 64-char cap
const HEADER_TEXT = '题'.repeat(24) // 24-char cap, 3 bytes/char
const QUESTION_TEXT = '问'.repeat(500) // 500-char cap
const OPT_ID = 'o' + 'y'.repeat(63) // 64-char cap
const LABEL = '标'.repeat(80) // 80-char cap
const DESCRIPTION = '描'.repeat(240) // 240-char cap

function makeMaximalMultibyteRequest(sessionId: string): QuestionRequest {
  return {
    requestId: 'q-' + 'r'.repeat(60),
    sessionId,
    createdAt: Date.now(),
    questions: Array.from({ length: MAX_QUESTIONS }, (_, qi) => ({
      id: `${Q_ID}${qi}`,
      header: HEADER_TEXT,
      question: QUESTION_TEXT,
      multiple: qi % 2 === 1,
      options: Array.from({ length: MAX_OPTIONS }, (_, oi) => ({
        id: `${OPT_ID}${oi}`,
        label: LABEL,
        description: DESCRIPTION,
        ...(qi === 0 && oi === 0 ? { recommended: true } : {}),
        ...(qi === 1 && oi === 3 ? { exclusive: true } : {}),
      })),
    })),
  }
}

describe('pending question header boundary (multi-byte, schema-maximal)', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-question-header-'))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function seedHeader(sessionId: string, pendingQuestion?: QuestionRequest): void {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const stored = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'boundary session',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      ...(pendingQuestion ? { pendingQuestion } : {}),
    } as StoredSession
    writeSessionJsonl(filePath, stored)
  }

  it('a schema-maximal multi-byte header line exceeds the old 16 KiB budget', () => {
    const request = makeMaximalMultibyteRequest('bound-0')
    seedHeader('bound-0', request)
    const firstLine = readFileSync(getSessionFilePath(tmpRoot, 'bound-0'), 'utf-8').split('\n')[0]!
    const lineBytes = Buffer.byteLength(firstLine, 'utf8')
    // Prove this test exercises the defect: the legal header is > 16 KiB.
    expect(lineBytes).toBeGreaterThan(16 * 1024)
  })

  it('write → readSessionHeader parses a schema-maximal multi-byte pending question', () => {
    const request = makeMaximalMultibyteRequest('bound-1')
    seedHeader('bound-1', request)

    const header = readSessionHeader(getSessionFilePath(tmpRoot, 'bound-1'))
    expect(header).not.toBeNull()
    expect(header?.hasPendingQuestion).toBe(true)
    expect(header?.pendingQuestionRequestId).toBe(request.requestId)
    expect(header?.pendingQuestion?.questions).toHaveLength(3)
    expect(header?.pendingQuestion?.questions[0]?.question).toBe(QUESTION_TEXT)
    expect(header?.pendingQuestion?.questions[0]?.options[0]?.description).toBe(DESCRIPTION)
    // Multibyte content survived byte-boundary handling intact (no U+FFFD)
    const lastOptionLabel = header?.pendingQuestion?.questions[2]?.options[3]?.label ?? ''
    expect(lastOptionLabel.includes('\uFFFD')).toBe(false)
  })

  it('readSessionHeaderAsync parses the same schema-maximal header', async () => {
    const request = makeMaximalMultibyteRequest('bound-2')
    seedHeader('bound-2', request)

    const header = await readSessionHeaderAsync(getSessionFilePath(tmpRoot, 'bound-2'))
    expect(header).not.toBeNull()
    expect(header?.pendingQuestion?.questions).toHaveLength(3)
    expect(header?.pendingQuestion?.questions[1]?.question).toBe(QUESTION_TEXT)
  })

  it('normal ASCII headers still parse (regression)', () => {
    seedHeader('bound-3')
    const header = readSessionHeader(getSessionFilePath(tmpRoot, 'bound-3'))
    expect(header?.name).toBe('boundary session')
    expect(header?.hasPendingQuestion).toBe(false)
  })
})
