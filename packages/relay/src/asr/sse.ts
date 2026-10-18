/**
 * Minimal SSE (server-sent events) parser (POL-21, card step 2).
 *
 * 只覆盖 MiMo（OpenAI 兼容）实际用到的子集：`data:` 字段分帧、空行派发事件、
 * `:` 注释行容错（保活）、多行 data 以 \n 连接、跨 chunk 半包缓冲。`event:`/
 * `id:`/`retry:` 字段与 ASR 无关，解析时忽略。`data: [DONE]` 不在解析器里
 * 特判——哨兵原样上抛，由 adapter 判定终止（解析器保持传输层纯函数）。
 */

/** OpenAI 兼容流的终止哨兵（MiMo stream=true 文档形态）。 */
export const SSE_DONE_SENTINEL = '[DONE]'

export interface SseEvent {
  /** 该事件的 data 载荷（多行 data 以 \n 连接；可能为空串）。 */
  data: string
}

export class SseParser {
  /** 跨 push 的半包缓冲：残存的最后一个不完整行。 */
  private buffer = ''
  /** 当前累积中的事件 data 行（空行派发时清空）。 */
  private dataLines: string[] = []
  /** dataLines 已累计字符数（与 buffer 一并受 maxPendingChars 约束）。 */
  private dataChars = 0

  constructor(
    /**
     * 未决数据内存闸（半包残行 + 未派发 data 行合计字符数）。上游若持续不发
     * 换行或无限堆积 data 行，缓冲会无界增长 —— 超限即抛错（fail-fast；adapter
     * 侧映射致命 upstream_error 断流），绝不在 relay 内无界积内存。正常 MiMo
     * delta chunk 为 KB 量级，1MiB 上限余量充足。
     */
    private readonly maxPendingChars = 1_048_576,
  ) {}

  /** 喂入一段解码后的文本，返回由此完整划出的 SSE 事件（按序）。 */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      const event = this.consumeLine(line.endsWith('\r') ? line.slice(0, -1) : line)
      if (event) events.push(event)
    }
    // 上限只约束「未决」数据（排空完整行后的残行 + 未派发 data 行）：单个大
    // chunk 只要能即时排空就不算积压。上游若持续不发换行，残行在此处超限抛错。
    if (this.buffer.length > this.maxPendingChars) {
      throw new Error(`sse: pending line exceeds ${this.maxPendingChars} chars`)
    }
    return events
  }

  /**
   * 流结束时调用：把残存行视作完整行收尾（容错上游漏掉结尾空行/结尾无换行），
   * 返回最后未派发的事件（若有）。
   */
  flush(): SseEvent[] {
    const events: SseEvent[] = []
    if (this.buffer !== '') {
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer
      this.buffer = ''
      const event = this.consumeLine(line)
      if (event) events.push(event)
    }
    const pending = this.dispatch()
    if (pending) events.push(pending)
    return events
  }

  /** 处理一行；返回值非空 = 该行触发了一次事件派发。 */
  private consumeLine(line: string): SseEvent | null {
    if (line === '') return this.dispatch() // 空行 = 事件边界
    if (line.startsWith(':')) return null // 注释/保活行
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    if (field !== 'data') return null // event:/id:/retry:/无值字段 —— ASR 不关心
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1) // SSE 规范：剥一个前导空格
    this.dataLines.push(value)
    this.dataChars += value.length
    if (this.dataChars + this.buffer.length > this.maxPendingChars) {
      throw new Error(`sse: pending event exceeds ${this.maxPendingChars} chars`)
    }
    return null
  }

  private dispatch(): SseEvent | null {
    if (this.dataLines.length === 0) return null
    const event: SseEvent = { data: this.dataLines.join('\n') }
    this.dataLines = []
    this.dataChars = 0
    return event
  }
}
