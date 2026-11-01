import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/**
 * The project-session tab strip (POO-196, Spec v2): 消息 / 文件 / Pin,
 * rendered between the PanelHeader and the chat display ONLY when the session
 * belongs to the committed enterprise project space. The strip is a Radix
 * Tabs root used purely as the selector — the messages pane (ChatDisplay)
 * stays mounted underneath, so tab switches never unmount the conversation.
 */

export type ProjectContextTab = 'messages' | 'files' | 'pins'

export interface ProjectContextTabsProps {
  value: ProjectContextTab
  onValueChange: (tab: ProjectContextTab) => void
  className?: string
}

export function ProjectContextTabs({ value, onValueChange, className }: ProjectContextTabsProps) {
  const { t } = useTranslation()

  return (
    <Tabs
      value={value}
      onValueChange={(next) => onValueChange(next as ProjectContextTab)}
      className={cn('shrink-0 border-b border-border/50 px-3', className)}
      data-testid="pc-tabs"
    >
      <TabsList
        className="h-8 justify-start gap-1 rounded-none border-none bg-transparent p-0 text-muted-foreground"
        aria-label={t('projectContext.tabs.aria')}
      >
        <TabsTrigger
          value="messages"
          className="gap-1.5 rounded-b-none border-b-2 border-transparent px-3 py-1.5 text-[13px] font-medium shadow-none data-[state=active]:rounded-none data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
          data-testid="pc-tab-messages"
        >
          <Icons.MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
          {t('projectContext.tabs.messages')}
        </TabsTrigger>
        <TabsTrigger
          value="files"
          className="gap-1.5 rounded-b-none border-b-2 border-transparent px-3 py-1.5 text-[13px] font-medium shadow-none data-[state=active]:rounded-none data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
          data-testid="pc-tab-files"
        >
          <Icons.FolderClosed className="h-3.5 w-3.5" aria-hidden="true" />
          {t('projectContext.tabs.files')}
        </TabsTrigger>
        <TabsTrigger
          value="pins"
          className="gap-1.5 rounded-b-none border-b-2 border-transparent px-3 py-1.5 text-[13px] font-medium shadow-none data-[state=active]:rounded-none data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
          data-testid="pc-tab-pins"
        >
          <Icons.Pin className="h-3.5 w-3.5" aria-hidden="true" />
          {t('projectContext.tabs.pins')}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
