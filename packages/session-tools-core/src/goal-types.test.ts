/**
 * goal_update wire parsing (POO-134).
 *
 * Regression for the REAL native wire shape observed in the first authorized
 * real-model attempt (2026-10-24): the goal_update tool_result reaches the
 * server as the JSON string of MCP text CONTENT BLOCKS
 * (`[{"type":"text","text":"<ack>\\nGOAL_UPDATE_REPORT {...}"}]`), where the
 * canonical marker and its JSON live ESCAPED inside the block text. The
 * original parser only scanned the raw string for the marker, so its first
 * `{` landed inside an escaped JSON literal and JSON.parse failed — every
 * real report was dropped (attempt-1: goal paused with no_progress after the
 * agent repeatedly reported progress/candidates that never landed).
 *
 * Contract under test:
 * - the REAL wrapped content-block wire parses (the fix);
 * - the historical bare-marker text keeps parsing unchanged (compat);
 * - ambiguous or malformed inputs fail CLOSED (null), never guess.
 */

import { describe, expect, it } from 'bun:test'
import {
  GOAL_UPDATE_REPORT_MARKER,
  parseGoalUpdateReportPayload,
  serializeGoalUpdateReport,
  type GoalUpdateReport,
} from './goal-types.ts'

/** The acknowledgement the goal_update handler prepends to a candidate report. */
const CANDIDATE_ACK = 'Candidate recorded. The server will now verify the evidence independently against every requirement. Do not claim completion yourself; continue only if asked.'

const PROGRESS_ACK = 'Progress recorded. Continue working on the goal. All todos being checked off does NOT complete the goal — report kind "candidate" with real evidence when you believe every requirement is satisfiable.'

function candidateReport(): GoalUpdateReport {
  return {
    kind: 'candidate',
    candidate: {
      summary: '整理完成：已产出 docs/notes.md 与 docs/checklist.md。',
      evidence: [
        { kind: 'file', path: 'docs/notes.md', note: '要求 2 产物，含三节' },
        { kind: 'file', path: 'docs/checklist.md' },
      ],
    },
    todos: [
      { id: 'explore', label: '查看当前工作区目录结构', status: 'completed' },
      { id: 'write-notes', label: '编写 notes.md', status: 'completed' },
      { id: 'write-checklist', label: '编写 checklist.md', status: 'completed' },
    ],
  }
}

/** The REAL attempt-1 wire: MCP text content blocks serialized as a JSON string. */
function mcpTextBlockWire(text: string): string {
  return JSON.stringify([{ type: 'text', text }])
}

describe('goal_update wire parsing — real MCP content-block format', () => {
  it('parses the ACTUAL attempt-1 candidate wire (content blocks JSON string)', () => {
    const report = candidateReport()
    const wire = mcpTextBlockWire(`${CANDIDATE_ACK}\n${serializeGoalUpdateReport(report)}`)
    const parsed = parseGoalUpdateReportPayload(wire)
    expect(parsed).toEqual(report)
  })

  it('parses the ACTUAL progress wire (content blocks JSON string)', () => {
    const report: GoalUpdateReport = {
      kind: 'progress',
      note: '已创建 docs 目录并写入 notes.md',
      todos: [{ id: 'explore', label: '查看当前工作区目录结构', status: 'completed' }],
    }
    const wire = mcpTextBlockWire(`${PROGRESS_ACK}\n${serializeGoalUpdateReport(report)}`)
    expect(parseGoalUpdateReportPayload(wire)).toEqual(report)
  })

  it('joins MULTIPLE text blocks and parses the marker from a later block', () => {
    const report = candidateReport()
    const wire = JSON.stringify([
      { type: 'text', text: '前置说明，不含 marker。' },
      { type: 'text', text: `${CANDIDATE_ACK}\n${serializeGoalUpdateReport(report)}` },
    ])
    expect(parseGoalUpdateReportPayload(wire)).toEqual(report)
  })

  it('round-trips: serialize → wrap → parse equals the original report', () => {
    const report = candidateReport()
    const wrapped = mcpTextBlockWire(`ack\n${serializeGoalUpdateReport(report)}`)
    expect(parseGoalUpdateReportPayload(wrapped)).toEqual(report)
  })

  it('parses a report whose JSON contains the escaped marker sequence inside a string value', () => {
    const report: GoalUpdateReport = {
      kind: 'progress',
      note: `quoted marker in prose: ${GOAL_UPDATE_REPORT_MARKER} {"kind":"progress"}`,
    }
    const wire = mcpTextBlockWire(`${PROGRESS_ACK}\n${serializeGoalUpdateReport(report)}`)
    // the FIRST marker (the real one) wins; the escaped copy must not derail it
    expect(parseGoalUpdateReportPayload(wire)).toEqual(report)
  })
})

describe('goal_update wire parsing — historical bare-text compatibility', () => {
  it('parses the bare marker + JSON text unchanged', () => {
    const report = candidateReport()
    expect(parseGoalUpdateReportPayload(serializeGoalUpdateReport(report))).toEqual(report)
  })

  it('parses acknowledgement + marker + JSON as plain text', () => {
    const report: GoalUpdateReport = { kind: 'progress', note: '开始拆解任务' }
    expect(parseGoalUpdateReportPayload(`${PROGRESS_ACK}\n${serializeGoalUpdateReport(report)}`)).toEqual(report)
  })
})

describe('goal_update wire parsing — fail-closed on bad/ambiguous input', () => {
  it('rejects null/undefined/empty', () => {
    expect(parseGoalUpdateReportPayload(null)).toBeNull()
    expect(parseGoalUpdateReportPayload(undefined)).toBeNull()
    expect(parseGoalUpdateReportPayload('')).toBeNull()
  })

  it('rejects prose without the marker', () => {
    expect(parseGoalUpdateReportPayload('Candidate recorded. Continue working.')).toBeNull()
  })

  it('rejects a marker with no JSON after it', () => {
    expect(parseGoalUpdateReportPayload(`${GOAL_UPDATE_REPORT_MARKER} `)).toBeNull()
  })

  it('rejects a marker followed by malformed JSON', () => {
    expect(parseGoalUpdateReportPayload(`${GOAL_UPDATE_REPORT_MARKER} {"kind":`)).toBeNull()
  })

  it('rejects JSON that fails the schema (candidate without evidence)', () => {
    expect(parseGoalUpdateReportPayload(`${GOAL_UPDATE_REPORT_MARKER} {"kind":"candidate","candidate":{"summary":"x","evidence":[]}}`)).toBeNull()
  })

  it('rejects a content-block array mixing non-text blocks (ambiguous)', () => {
    const report = candidateReport()
    const wire = JSON.stringify([
      { type: 'text', text: `${CANDIDATE_ACK}\n${serializeGoalUpdateReport(report)}` },
      { type: 'image', source: { type: 'base64', data: 'x' } },
    ])
    expect(parseGoalUpdateReportPayload(wire)).toBeNull()
  })

  it('rejects a content-block array with a block missing its text field', () => {
    expect(parseGoalUpdateReportPayload(JSON.stringify([{ type: 'text' }]))).toBeNull()
  })

  it('rejects a JSON array of plain strings (not content blocks)', () => {
    expect(parseGoalUpdateReportPayload(JSON.stringify(['GOAL_UPDATE_REPORT {"kind":"progress"}']))).toBeNull()
  })

  it('rejects a JSON object (not an array) even when it embeds the marker', () => {
    const wire = JSON.stringify({ text: `${CANDIDATE_ACK}\n${GOAL_UPDATE_REPORT_MARKER} {"kind":"progress"}` })
    expect(parseGoalUpdateReportPayload(wire)).toBeNull()
  })

  it('rejects truncated content-block JSON (unparseable array)', () => {
    expect(parseGoalUpdateReportPayload('[{"type":"text","text":"GOAL_UPDATE_REPORT {"kind":"progress"}')).toBeNull()
  })

  it('rejects a bracketed non-JSON text that is not content blocks', () => {
    expect(parseGoalUpdateReportPayload('[1, 2, 3] GOAL_UPDATE_REPORT {"kind":"progress"}')).toBeNull()
  })
})
