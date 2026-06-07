import React from 'react'
import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import SessionExpiredDialog, { type SessionExpiredDialogProps } from '../SessionExpiredDialog'

type ElementWithProps = React.ReactElement<Record<string, unknown>>

function isElement(value: React.ReactNode): value is ElementWithProps {
  return React.isValidElement(value)
}

function walk(node: React.ReactNode): ElementWithProps[] {
  if (Array.isArray(node)) return node.flatMap(walk)
  if (!isElement(node)) return []

  return [node, ...walk(node.props.children as React.ReactNode)]
}

function textContent(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (!isElement(node)) return ''
  return textContent(node.props.children as React.ReactNode)
}

function findButton(node: React.ReactNode, label: string) {
  return walk(node).find((element) => element.type === 'button' && textContent(element).includes(label))
}

function findByRole(node: React.ReactNode, role: string) {
  return walk(node).find((element) => element.props.role === role)
}

function renderDialog(props: Partial<SessionExpiredDialogProps> = {}) {
  return renderToStaticMarkup(
    <SessionExpiredDialog
      visible
      onLogin={() => {}}
      {...props}
    />,
  )
}

describe('SessionExpiredDialog', () => {
  it('renders a visible modal with the session expired message', () => {
    const html = renderDialog()

    expect(html).toContain('role="dialog"')
    expect(html).toContain('会话已失效，请重新登录')
  })

  it('does not render when visible is false', () => {
    const html = renderDialog({ visible: false })

    expect(html).toBe('')
  })

  it('calls onLogin when the relogin button is clicked', () => {
    const onLogin = mock(() => {})
    const tree = SessionExpiredDialog({ visible: true, onLogin })
    const button = findButton(tree, '重新登录')

    expect(button).toBeDefined()
    ;(button?.props.onClick as () => void)()
    expect(onLogin).toHaveBeenCalledTimes(1)
  })

  it('marks the dialog as modal for assistive technology', () => {
    const html = renderDialog()

    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="会话已失效"')
  })

  it('keeps tab focus inside the dialog', () => {
    let firstFocused = false
    let outsideFocused = false
    const first = {
      focus: () => { firstFocused = true },
      hasAttribute: () => false,
      getAttribute: () => null,
    }
    const last = {
      focus: () => { outsideFocused = true },
      hasAttribute: () => false,
      getAttribute: () => null,
    }
    const tree = SessionExpiredDialog({ visible: true, onLogin: () => {} })
    const dialog = findByRole(tree, 'dialog')
    let defaultPrevented = false

    expect(dialog).toBeDefined()
    ;(dialog?.props.onKeyDown as (event: unknown) => void)({
      key: 'Tab',
      shiftKey: false,
      target: last,
      currentTarget: {
        querySelectorAll: () => [first, last],
      },
      preventDefault: () => {
        defaultPrevented = true
      },
    })

    expect(defaultPrevented).toBe(true)
    expect(firstFocused).toBe(true)
    expect(outsideFocused).toBe(false)
  })
})
