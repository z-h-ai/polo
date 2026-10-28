import * as React from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './Select'

export interface SelectOption<T extends string = string> {
  /** Should be unique across the option list; the React key already carries the
   * index as a fallback so a duplicate value cannot collide. */
  value: T
  label: string
  disabled?: boolean
}

export interface OptionSelectProps<T extends string = string>
  extends Omit<React.ComponentProps<typeof SelectTrigger>, 'value' | 'onChange' | 'children' | 'defaultValue' | 'dir'> {
  value: T
  onValueChange: (value: T) => void
  options: readonly SelectOption<T>[]
  name?: string
  placeholder?: string
  contentClassName?: string
  contentStyle?: React.CSSProperties
  container?: HTMLElement | null
}

/** A single-value field, not an action menu. Index keys let empty values remain
 * selectable (including clearing optional forms) without reserving a user value.
 * A named field submits the original value, never the internal Radix key. */
export function OptionSelect<T extends string>({
  value, onValueChange, options, name, placeholder,
  contentClassName, contentStyle, container, disabled, ...triggerProps
}: OptionSelectProps<T>) {
  const selected = options.findIndex(option => option.value === value)
  return (
    <>
      {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
      <Select
        value={selected < 0 ? '' : String(selected)}
        onValueChange={key => {
          if (key === '') return
          const option = options[Number(key)]
          if (option && !option.disabled) onValueChange(option.value)
        }}
        disabled={disabled}
      >
        <SelectTrigger {...triggerProps} data-value={value}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent container={container} className={contentClassName} style={contentStyle} collisionPadding={8}>
          {options.map((option, index) => (
            <SelectItem key={`${index}-${option.value}`} value={String(index)} data-value={option.value} disabled={option.disabled}>
              {option.label || '\u00a0'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  )
}
