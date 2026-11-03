import { useState } from 'react'
import { RichTextInput } from '@/components/ui/rich-text-input'

/** Local state only. This is the production editor, including its IME handling. */
export function InterviewInputScene() {
  const [value, setValue] = useState('')
  return (
    <section className="mx-auto w-full max-w-[840px] px-5 py-8" aria-label="输入区域">
      <RichTextInput
        value={value}
        onChange={setValue}
        placeholder="输入消息"
        workspaceId="playground-workspace"
        className="pl-5 pr-4 pt-4 pb-3 overflow-y-auto min-h-[88px]"
        data-tutorial="chat-input"
        spellCheck={false}
      />
    </section>
  )
}
