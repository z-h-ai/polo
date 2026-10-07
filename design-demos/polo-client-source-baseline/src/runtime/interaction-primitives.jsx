import React, { useEffect, useRef, useState } from 'react'

export function Menu({ label, children, align = 'left', className = '', onClose }) {
  const [internalOpen, setOpen] = useState(false)
  const open = label ? internalOpen : true
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const close = (event) => { if (!ref.current?.contains(event.target)) { setOpen(false); onClose?.() } }
    const escape = (event) => { if (event.key === 'Escape') { setOpen(false); onClose?.() } }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  const content = typeof children === 'function' ? children({ close: () => { setOpen(false); onClose?.() } }) : children
  return <div className="menu-anchor" ref={ref}>
    {label && <button className="ghost-button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{label}</button>}
    {open && <div className={className || ('menu-panel menu-' + align)}>{content}</div>}
  </div>
}

export function Dialog({ open, title, description, onClose, children, danger = false }) {
  const headingId = 'dialog-' + title.replace(/\s+/g, '-').toLowerCase()
  useEffect(() => {
    if (!open) return undefined
    const escape = (event) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="dialog-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={'dialog-card ' + (danger ? 'dialog-danger' : '')} role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <header className="dialog-header">
          <div><h2 id={headingId}>{title}</h2>{description && <p>{description}</p>}</div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="dialog-body">{children}</div>
      </section>
    </div>
  )
}

export function Toast({ message }) {
  return message ? <div className="toast" role="status" aria-live="polite">{message}</div> : null
}
