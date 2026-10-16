export const MAX_FILE_BYTES = 262_144
export interface Item { name: string; quantity: number; unitPriceCents: number; note: string }
export interface Quote { currency: 'CNY'; items: Item[] }
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
function text(v: unknown, max: number, empty = false): v is string {
  return typeof v === 'string' && (empty || !!v.trim()) && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
}
export function validateQuote(raw: unknown): Quote {
  if (!plain(raw) || Object.keys(raw).sort().join(',') !== 'currency,items' || raw.currency !== 'CNY' || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 100) throw new Error('报价格式无效：需要 CNY 和 1–100 个项目。')
  const items = raw.items.map(v => {
    if (!plain(v) || Object.keys(v).sort().join(',') !== 'name,note,quantity,unitPriceCents' || !text(v.name, 120) || !text(v.note, 500, true) || !integer(v.quantity, 1, 100_000) || !integer(v.unitPriceCents, 0, 1_000_000_000)) throw new Error('项目无效：名称、数量、整数分单价或说明超出范围。')
    return { name: v.name, quantity: v.quantity as number, unitPriceCents: v.unitPriceCents as number, note: v.note }
  })
  const quote: Quote = { currency: 'CNY', items }; totalCents(quote); return quote
}
export function totalCents(quote: Quote): number {
  let total = 0
  for (const item of quote.items) {
    const line = item.quantity * item.unitPriceCents
    total += line
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(total)) throw new Error('金额溢出，请减少数量或单价。')
  }
  return total
}
/** RFC4180-style quoting, bounded rows/columns; malformed quotes fail closed. */
export function parseCsv(source: string): string[][] {
  if (new TextEncoder().encode(source).byteLength > MAX_FILE_BYTES) throw new Error('文件超过 256 KiB。')
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, closed = false
  source = source.replace(/^\uFEFF/, '')
  const pushCell = () => { if (cell.length > 2000 || row.length >= 8) throw new Error('CSV 列或字段过大。'); row.push(cell); cell = ''; closed = false }
  const pushRow = () => { pushCell(); if (row.some(v => v !== '')) rows.push(row); row = []; if (rows.length > 101) throw new Error('CSV 最多 100 个项目。') }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (quoted) {
      if (c === '"') { if (source[i + 1] === '"') { cell += '"'; i++ } else { quoted = false; closed = true } }
      else cell += c
    } else if (c === ',' ) pushCell()
    else if (c === '\r' || c === '\n') { if (c === '\r' && source[i + 1] === '\n') i++; pushRow() }
    else if (c === '"' && !cell && !closed) quoted = true
    else { if (closed || c === '"') throw new Error('CSV 引号格式错误。'); cell += c }
  }
  if (quoted) throw new Error('CSV 引号未闭合。')
  if (cell || row.length || closed) pushRow()
  return rows
}
export function csvItems(source: string): Item[] {
  const [header, ...rows] = parseCsv(source)
  if (header?.join(',') !== 'name,quantity,unitPriceCents' || !rows.length) throw new Error('CSV 表头须为 name,quantity,unitPriceCents。')
  const items = rows.map(row => {
    if (row.length !== 3 || !/^[1-9]\d*$/.test(row[1]!) || !/^\d+$/.test(row[2]!)) throw new Error('CSV 数量和单价须为十进制整数。')
    return { name: row[0], quantity: Number(row[1]), unitPriceCents: Number(row[2]), note: '' }
  })
  const quote = validateQuote({ currency: 'CNY', items })
  if (new Set(quote.items.map(i => i.name)).size !== quote.items.length) throw new Error('CSV 项目名称不能重复。')
  return quote.items
}
export async function readSelectedFile(file: File): Promise<{ text: string; items: Item[] }> {
  if (!/\.(csv|txt)$/i.test(file.name) || file.size > MAX_FILE_BYTES || file.size === 0) throw new Error('请选择不超过 256 KiB 的 UTF-8 CSV 或 TXT 文件。')
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) }
  catch { throw new Error('文件不是有效 UTF-8，请转换编码后重试。') }
  if (source.includes('\0') || !source.trim()) throw new Error('文件为空或包含无效字符。')
  return { text: source, items: /\.csv$/i.test(file.name) ? csvItems(source) : [] }
}
export function validateSuggestedPrices(quote: Quote, selected: Item[], rate: number): void {
  if (!integer(rate, 0, 1_000_000_000)) throw new Error('请输入有效的整数分单价。')
  const rates = new Map(selected.map(i => [i.name, i.unitPriceCents]))
  for (const item of quote.items) {
    const expected = selected.length ? rates.get(item.name) : rate
    if (expected === undefined || expected !== item.unitPriceCents) throw new Error('AI 建议使用了未确认的项目或单价，请检查后主动重新生成。')
  }
}
const safeCell = (value: string) => {
  // Quoting alone does not stop spreadsheet formula execution.
  const safe = /^[\s\uFEFF]*[=+@-]/u.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}
export function exportCsv(quote: Quote): string {
  return '\uFEFF' + [['项目', '数量', '单价（分）', '小计（分）', '说明'], ...quote.items.map(i => [i.name, String(i.quantity), String(i.unitPriceCents), String(i.quantity * i.unitPriceCents), i.note]), ['合计', '', '', String(totalCents(quote)), 'CNY']].map(row => row.map(safeCell).join(',')).join('\r\n')
}
export function exportJson(quote: Quote): string { return JSON.stringify({ ...quote, totalCents: totalCents(quote) }, null, 2) }
