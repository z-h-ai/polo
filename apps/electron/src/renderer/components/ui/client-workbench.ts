/** Shared composition for the POO-70 owned pages and portals. Keep utility
 * literals in the existing component scan scope; the canonical token adapter
 * stays in lib and never injects prototype selectors. */
export { useClientWorkbenchStyle } from '@/lib/client-workbench-style'

export const clientWorkbenchFocusClassName =
  '[&_:is(button,a,input,select,textarea,[tabindex]):focus-visible]:[outline:var(--client-workbench-focus-outline)] [&_:is(button,a,input,select,textarea,[tabindex]):focus-visible]:[outline-offset:var(--client-workbench-focus-offset)] [&_button:disabled]:cursor-not-allowed [&_button:disabled]:opacity-50'

// Shared owned-portal composition; generic Dialog/Dropdown defaults stay intact.
export const clientWorkbenchDialogClassName = clientWorkbenchFocusClassName +
  ' block w-[calc(100%-40px)] max-w-[520px] sm:max-w-[520px] max-h-[calc(100dvh-40px)] overflow-y-auto rounded-[14px] border border-border bg-surface p-0 shadow-modal-small text-foreground [&>[data-slot=dialog-header]]:px-[20px] [&>[data-slot=dialog-header]]:pt-[20px] [&>[data-slot=dialog-header]]:pb-[14px] [&>[data-slot=dialog-header]]:gap-[6px] [&>[data-slot=dialog-header]]:text-left [&_[data-slot=dialog-title]]:text-[16px] [&_[data-slot=dialog-title]]:leading-[1.4] [&_[data-slot=dialog-description]]:text-[13px] [&_[data-slot=dialog-description]]:leading-[1.5] [&>[data-slot=dialog-footer]]:border-t [&>[data-slot=dialog-footer]]:border-border [&>[data-slot=dialog-footer]]:px-[20px] [&>[data-slot=dialog-footer]]:py-[13px] [&>[data-slot=dialog-footer]]:gap-[8px] [&>[data-slot=dialog-footer]]:flex-row [&>[data-slot=dialog-footer]]:flex-wrap [&>[data-slot=dialog-footer]]:justify-end'
export const clientWorkbenchOverlayClassName = 'bg-[var(--overlay,rgba(0,0,0,0.5))]'
export const clientWorkbenchMenuClassName = clientWorkbenchFocusClassName +
  ' rounded-[14px] border border-border bg-surface p-[6px] shadow-modal-small text-foreground [&_[role=menuitem]]:min-h-[44px] [&_[role=menuitem]]:gap-[9px] [&_[role=menuitem]]:rounded-[6px] [&_[role=menuitem]]:px-[8px] [&_[role=menuitem]]:py-[7px] [&_[role=menuitem]]:text-left [&_[role=menuitem]]:text-[13px] [&_[role=menuitem]]:hover:bg-foreground-5 [&_[role=menuitem]]:focus:bg-foreground-5'
export const clientWorkbenchPrimaryClassName = 'h-auto min-h-[32px] gap-[6px] rounded-[8px] border border-accent bg-accent px-[12px] py-0 text-[12px] font-medium text-[var(--on-accent,#fff)] hover:bg-[color-mix(in_srgb,var(--accent)_86%,black)]'
export const clientWorkbenchButtonClassName = 'h-auto min-h-[32px] gap-[6px] rounded-[8px] border border-border bg-transparent px-[12px] py-0 text-[12px] font-medium text-foreground hover:bg-foreground-5'
export const clientWorkbenchDestructiveClassName = 'h-auto min-h-[32px] gap-[6px] rounded-[8px] border border-destructive bg-destructive px-[12px] py-0 text-[12px] font-medium text-white'
