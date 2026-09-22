import * as React from 'react'
import { FileText, Folder } from 'lucide-react'
import type { ComponentEntry } from './types'
import { FileMissingState } from '@/components/files/FileMissingState'
import { cn } from '@/lib/utils'

// =============================================================================
// Session Files Playground (POO-70 M08 verification)
// - FILES / FILES-PERSONAL: conversation files stay in their original chat
//   (D-PC-03) — the personal-space variant of the same surface.
// - FILE-MISSING: an original file moved or deleted keeps its row and offers
//   the re-pick path (C-R02).
// =============================================================================

const NO_OP = () => {}

interface SessionFileEntry {
  name: string
  meta: string
  missing?: boolean
}

const PERSONAL_FILES: SessionFileEntry[] = [
  { name: 'Q2-报价底稿.xlsx', meta: '报价汇总 · 刚刚 · 46 KB' },
  { name: '客户联系人清单.csv', meta: '报价汇总 · 刚刚 · 12 KB', missing: true },
  { name: '报价明细-客户A.pdf', meta: '报价汇总 · 刚刚 · 320 KB' },
]

function SessionFileRow({ entry }: { entry: SessionFileEntry }) {
  if (entry.missing) {
    return <FileMissingState fileName={entry.name} onRepick={NO_OP} />
  }
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-sm border border-border bg-background px-2.5 py-2">
      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-[13px] font-medium text-foreground">{entry.name}</p>
        <p className="m-0 text-[11px] leading-tight text-muted-foreground">{entry.meta}</p>
      </div>
    </div>
  )
}

interface SessionFilesDemoProps {
  missing?: boolean
}

function SessionFilesDemo({ missing = true }: SessionFilesDemoProps) {
  const entries = missing
    ? PERSONAL_FILES
    : PERSONAL_FILES.map(entry => ({ ...entry, missing: false }))
  return (
    <div className="w-[420px] rounded-lg border border-border bg-background p-4">
      <div className="mb-3 flex items-center gap-2">
        <Folder className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <p className="m-0 text-[13px] font-semibold text-foreground">对话文件 · 报价汇总</p>
        <span className="text-[11px] text-muted-foreground">我的空间</span>
      </div>
      <div className={cn('grid gap-2')}>
        {entries.map(entry => (
          <SessionFileRow key={entry.name} entry={entry} />
        ))}
      </div>
      <p className="m-0 mt-3 text-[11px] text-muted-foreground">
        附件与生成文件留在原对话（D-PC-03）；缺失文件给重选路径（C-R02）
      </p>
    </div>
  )
}

function FileMissingOnlyDemo() {
  return (
    <div className="grid w-[420px] gap-2">
      <FileMissingState fileName="Q2-报价底稿.xlsx" onRepick={NO_OP} />
      <FileMissingState fileName="客户联系人清单.csv" onRepick={NO_OP} />
    </div>
  )
}

export const sessionFilesComponents: ComponentEntry[] = [
  {
    id: 'session-files-personal',
    name: 'Session Files · Personal',
    category: 'Chat',
    description:
      '会话文件列表（P-M08-FILES / P-M08-FILES-PERSONAL）：附件与生成文件留在原对话；含缺失文件行（FileMissingState 给重选路径 C-R02）',
    component: SessionFilesDemo,
    props: [
      {
        name: 'missing',
        description: '包含缺失文件行（原文件已移动或删除）',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
    variants: [
      {
        name: 'P-M08-FILES-PERSONAL · with missing file',
        description: '我的空间会话文件：一行缺失，可重选路径',
        props: { missing: true },
      },
      {
        name: 'P-M08-FILES · all present',
        description: '全部文件在位的常规列表',
        props: { missing: false },
      },
    ],
  },
  {
    id: 'session-file-missing',
    name: 'Session Files · Missing State',
    category: 'Chat',
    description: '文件缺失状态组件（P-M08-FILE-MISSING）：保留文件名与原因，重选路径恢复引用',
    component: FileMissingOnlyDemo,
    props: [],
    variants: [
      {
        name: 'P-M08-FILE-MISSING · repick path',
        description: '两个缺失文件行的最小展示',
        props: {},
      },
    ],
  },
]
