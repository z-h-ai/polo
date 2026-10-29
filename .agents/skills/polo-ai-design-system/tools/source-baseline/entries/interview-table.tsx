import { Markdown, MarkdownDatatableBlock, PlatformProvider } from '@polo-ai/ui'
import { GenUICard, type GenUiDataTable } from '../../../../../../packages/ui/src/components/chat/GenUICard'

// Same data feeds Markdown, inline rich blocks and the actual GenUI consumer.
// Only file IO is replaced; no production component, styles or scroll logic copied.
const columns = Array.from({ length: 20 }, (_, index) => ({
  key: `column${index + 1}`, label: `列${String(index + 1).padStart(2, '0')}：季度经营记录`, type: 'text' as const,
}))
const rows = Array.from({ length: 100 }, (_, row) => Object.fromEntries(
  columns.map((column, col) => [column.key, `第${String(row + 1).padStart(3, '0')}行·${col + 1}列经营数据`]),
))
const shortRows = rows.slice(0, 2)
function markdownTable(short: boolean) {
  const selected = short ? columns.slice(0, 3) : columns
  return [
    `| ${selected.map(column => column.label).join(' | ')} |`,
    `| ${selected.map(() => '---').join(' | ')} |`,
    ...(short ? shortRows : rows).map(row => `| ${selected.map(column => row[column.key]).join(' | ')} |`),
  ].join('\n')
}
const tableCode = JSON.stringify({ title: '季度经营记录', columns, rows })
const filePath = '/mock/interview-table/quarter.json'
const fileContents = JSON.stringify(rows)
const fileActions = { onReadFile: async (path: string) => {
  if (path !== filePath) throw new Error('table fixture: unknown file')
  return fileContents
} }
const component: GenUiDataTable = {
  type: 'data-table', id: 'interview-table', title: '季度经营记录', columns, src: filePath,
  rowAction: { label: '跟进', promptTemplate: '跟进{{column1}}' },
}

function TableHost({ children }: { children: React.ReactNode }) {
  // Viewport host only, matching the message reading area's scrolling boundary.
  // Production Markdown/datatable owns all table layout and internal scrolling.
  return <section data-interview-table-host tabIndex={0} className="h-screen overflow-auto outline-none">
    <article className="mx-auto max-w-[840px] min-w-0 px-5 py-8">{children}</article>
  </section>
}

export function InterviewMarkdownTableScene({ mode }: { mode: 'terminal' | 'minimal' | 'full' }) {
  const short = new URLSearchParams(window.location.search).get('short') === '1'
  return <TableHost><Markdown mode={mode}>{markdownTable(short)}</Markdown></TableHost>
}

export function InterviewDatatableScene() {
  return <TableHost><MarkdownDatatableBlock code={tableCode} /></TableHost>
}

export function InterviewGenUiTableScene() {
  return <PlatformProvider actions={fileActions}><TableHost>
    <GenUICard components={[component]} sessionId="interview-table-session" />
  </TableHost></PlatformProvider>
}
