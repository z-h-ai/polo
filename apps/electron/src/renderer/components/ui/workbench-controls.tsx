import * as React from 'react'
import { OptionSelect, type OptionSelectProps } from '@polo-ai/ui/ui/option-select'
import { StyledDropdownMenuContent, StyledDropdownMenuSubContent } from './styled-dropdown'
import { clientWorkbenchMenuClassName, useClientWorkbenchStyle } from './client-workbench'
import { cn } from '@/lib/utils'

/** Portals do not inherit the workbench DOM's tokens. Apply the same adapter
 * to the root AND every submenu, including nested application actions. */
export function WorkbenchMenuContent({ className, style, ...props }: React.ComponentProps<typeof StyledDropdownMenuContent>) {
  const workbenchStyle = useClientWorkbenchStyle()
  return <StyledDropdownMenuContent {...props} style={{ ...workbenchStyle, ...style }} className={cn(clientWorkbenchMenuClassName, className)} />
}

export function WorkbenchMenuSubContent({ className, style, ...props }: React.ComponentProps<typeof StyledDropdownMenuSubContent>) {
  const workbenchStyle = useClientWorkbenchStyle()
  return <StyledDropdownMenuSubContent {...props} style={{ ...workbenchStyle, ...style }} className={cn(clientWorkbenchMenuClassName, className)} />
}

export function WorkbenchSelect<T extends string>({ className, contentClassName, contentStyle, ...props }: OptionSelectProps<T>) {
  const workbenchStyle = useClientWorkbenchStyle()
  return <OptionSelect {...props}
    className={cn('h-auto min-h-[38px] w-auto min-w-0 max-w-full rounded-[8px] border-border bg-surface client-material-card px-[12px] py-[9px] text-[15px] text-foreground', className)}
    contentClassName={cn('rounded-[14px] border border-border bg-surface p-[2px] shadow-modal-small text-foreground client-material-card [&_[role=option]]:min-h-[36px] [&_[role=option]]:rounded-[6px] [&_[role=option]]:text-[13px]', contentClassName)}
    contentStyle={{ ...workbenchStyle, ...contentStyle }}
  />
}
