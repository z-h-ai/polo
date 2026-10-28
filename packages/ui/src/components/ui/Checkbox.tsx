import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'

/** Native form/label semantics with a theme-owned appearance on every OS.
 * readOnly is used for rendered task lists: clicks must not alter their data. */
export const Checkbox = React.forwardRef<HTMLInputElement, Omit<React.ComponentProps<'input'>, 'type'>>(
  ({ className, readOnly, onClick, ...props }, ref) => (
    <span className={cn('relative inline-flex size-4 shrink-0 align-middle', className)}>
      <input
        {...props}
        ref={ref}
        type="checkbox"
        readOnly={readOnly}
        onClick={event => {
          onClick?.(event)
          if (readOnly) event.preventDefault()
        }}
        className="peer client-material-control m-0 size-full appearance-none rounded-[4px] border border-foreground/30 bg-background checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:checked:bg-muted-foreground"
      />
      <Check aria-hidden className="pointer-events-none absolute inset-0 hidden size-full p-[1px] text-[var(--on-accent,#fff)] peer-checked:block peer-disabled:text-background" strokeWidth={3} />
    </span>
  ),
)
Checkbox.displayName = 'Checkbox'
