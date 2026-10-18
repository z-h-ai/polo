/**
 * POL-21 SSE parser tests: data 分帧、[DONE] 哨兵透传、空行/注释行容错、
 * 跨 chunk 半包缓冲、\r\n 行尾、多行 data、flush 收尾。
 */

import { describe, expect, test } from 'bun:test'

import { SSE_DONE_SENTINEL, SseParser } from './sse.ts'

function datas(events: Array<{ data: string }>): string[] {
  return events.map((event) => event.data)
}

describe('sse parser', () => {
  test('basic framing: one event per blank-line-terminated data line', () => {
    const parser = new SseParser()
    expect(datas(parser.push('data: {"a":1}\n\ndata: {"b":2}\n\n'))).toEqual(['{"a":1}', '{"b":2}'])
    expect(datas(parser.flush())).toEqual([])
  })

  test('half-package: event split across pushes is buffered until complete', () => {
    const parser = new SseParser()
    expect(parser.push('data: {"del')).toEqual([])
    expect(parser.push('ta":{"content":"你"}')).toEqual([]) // 无换行仍在缓冲
    expect(datas(parser.push('\n\n'))).toEqual(['{"delta":{"content":"你"}'])
  })

  test('half-package: multiple lines and boundaries, \r\n line endings', () => {
    const parser = new SseParser()
    expect(parser.push('data: one\r')).toEqual([])
    // \r\n 空行分界：两个事件按序派发
    expect(datas(parser.push('\n\ndata: two\r\n\n'))).toEqual(['one', 'two'])
  })

  test('comment lines, blank lines and non-data fields are ignored without spurious events', () => {
    const parser = new SseParser()
    const events = parser.push(': keep-alive\n\n:event: ping\nid: 42\nretry: 100\ndata: real\n\n')
    expect(datas(events)).toEqual(['real'])
    expect(parser.flush()).toEqual([])
  })

  test('multi-line data fields join with \\n into a single event', () => {
    const parser = new SseParser()
    expect(datas(parser.push('data: line1\ndata: line2\n\n'))).toEqual(['line1\nline2'])
  })

  test('[DONE] sentinel passes through verbatim (adapter decides termination)', () => {
    const parser = new SseParser()
    expect(datas(parser.push(`data: ${SSE_DONE_SENTINEL}\n\n`))).toEqual([SSE_DONE_SENTINEL])
  })

  test('data with no space after colon, and bare field without colon, are tolerated', () => {
    const parser = new SseParser()
    expect(datas(parser.push('data:x\n\n'))).toEqual(['x'])
    expect(datas(parser.push('data\n\n'))).toEqual(['']) // 无值 data = 空串事件
  })

  test('flush emits the trailing event when upstream omits the final blank line', () => {
    const parser = new SseParser()
    expect(parser.push('data: {"tail":true}\n')).toEqual([])
    expect(datas(parser.flush())).toEqual(['{"tail":true}'])
    expect(datas(parser.flush())).toEqual([]) // 幂等
  })

  test('streamed sequence: chunks then [DONE] in order', () => {
    const parser = new SseParser()
    const stream = [
      'data: {"c":"你"}\n\n',
      'data: {"c":"好"}\n\n',
      `data: ${SSE_DONE_SENTINEL}\n\n`,
    ]
    const events = stream.flatMap((chunk) => parser.push(chunk))
    expect(datas(events)).toEqual(['{"c":"你"}', '{"c":"好"}', SSE_DONE_SENTINEL])
  })

  test('memory cap: a line without newlines beyond the limit throws (恶意长行不积内存)', () => {
    const parser = new SseParser(64)
    expect(datas(parser.push('data: ok\n\n'))).toEqual(['ok'])
    expect(() => parser.push('x'.repeat(100))).toThrow(/pending line/)
  })

  test('memory cap: flooding data lines without a blank line throws (无空行洪水)', () => {
    const parser = new SseParser(64)
    expect(() => {
      for (let i = 0; i < 100; i += 1) parser.push(`data: ${'y'.repeat(10)}\n`)
    }).toThrow(/pending event/)
  })

  test('memory cap: exactly at the limit is still accepted (边界不误伤)', () => {
    const parser = new SseParser(64)
    expect(datas(parser.push(`data: ${'z'.repeat(58)}\n\n`))).toEqual(['z'.repeat(58)])
  })
})
