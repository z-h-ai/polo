/**
 * POO-162 primitives render harness: real Electron window rendering the
 * production styled primitives with the POO-162 defaults (submenu
 * sideOffset 4, hover foreground/10→[0.03], WorkbenchMenu token adapter,
 * WorkbenchSelect). Keyboard-driven (Radix synthetic pointer events are
 * unreliable — same discipline as the interaction tests): Enter opens the
 * menu, ArrowRight opens the submenu; window.__poo162 reports element rects
 * for main to assert the submenu stays inside the viewport (no clipping).
 */
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { setupI18n } from '@polo-ai/shared/i18n'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { ThemeProvider } from '@/context/ThemeContext'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuItem,
  DropdownMenuSub,
  StyledDropdownMenuSubTrigger,
} from '@/components/ui/styled-dropdown'
import { WorkbenchMenuContent, WorkbenchMenuSubContent, WorkbenchSelect } from '@/components/ui/workbench-controls'
import '@/index.css'

await setupI18n([initReactI18next])
await i18n.changeLanguage('zh-Hans')

function Harness() {
  const [selectValue, setSelectValue] = useState<'a' | 'b'>('a')
  const [phase, setPhase] = useState<'idle' | 'menu-open' | 'submenu-open' | 'select-open' | 'done'>('idle')
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const selectTriggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const w = window as unknown as { __poo162Phase?: string }
    w.__poo162Phase = phase
  }, [phase])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const w = window as unknown as { __poo162Cmd?: string }
      const cmd = w.__poo162Cmd
      if (!cmd) return
      delete w.__poo162Cmd
      const press = (el: Element | null, key: string) => el?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      if (cmd === 'open-menu') {
        press(menuTriggerRef.current, 'Enter')
        setPhase('menu-open')
      } else if (cmd === 'open-submenu') {
        // Menu opens with focus already on the first item (通知设置): one
        // ArrowDown reaches the 编辑 sub-trigger, ArrowRight opens it.
        setTimeout(() => press(document.activeElement, 'ArrowDown'), 120)
        setTimeout(() => press(document.activeElement, 'ArrowRight'), 320)
        setPhase('submenu-open')
      } else if (cmd === 'open-select') {
        const trigger = document.querySelector('[data-testid="poo162-select-trigger"]')
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        setPhase('select-open')
      } else if (cmd === 'report') {
        const sub = document.querySelector('[data-poo162-subcontent]') as HTMLElement | null
        const content = document.querySelector('[data-poo162-content]') as HTMLElement | null
        const option = document.querySelector('[role="option"]') as HTMLElement | null
        const rect = (el: HTMLElement | null) => {
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        }
        ;(window as unknown as { __poo162Report?: unknown }).__poo162Report = {
          viewport: { w: window.innerWidth, h: window.innerHeight },
          content: rect(content),
          subContent: rect(sub),
          option: rect(option),
          phase,
          selectValue,
        }
      }
    }, 200)
    return () => window.clearInterval(timer)
  }, [phase, selectValue])

  return (
    <div style={{ display: 'flex', gap: 24, padding: 24, alignItems: 'flex-start' }}>
      <DropdownMenu>
        <DropdownMenuTrigger ref={menuTriggerRef} data-testid="poo162-menu-trigger">
          账户菜单
        </DropdownMenuTrigger>
        <WorkbenchMenuContent data-poo162-content>
          <StyledDropdownMenuItem>通知设置</StyledDropdownMenuItem>
          <DropdownMenuSub>
            <StyledDropdownMenuSubTrigger>编辑</StyledDropdownMenuSubTrigger>
            <WorkbenchMenuSubContent data-poo162-subcontent>
              <StyledDropdownMenuItem>剪切</StyledDropdownMenuItem>
              <StyledDropdownMenuItem>复制</StyledDropdownMenuItem>
              <StyledDropdownMenuItem>粘贴</StyledDropdownMenuItem>
            </WorkbenchMenuSubContent>
          </DropdownMenuSub>
          <StyledDropdownMenuItem>锁定工作台</StyledDropdownMenuItem>
        </WorkbenchMenuContent>
      </DropdownMenu>
      <WorkbenchSelect<'a' | 'b'>
        ref={selectTriggerRef as never}
        data-testid="poo162-select-trigger"
        value={selectValue}
        onValueChange={v => setSelectValue(v as 'a' | 'b')}
        options={[
          { value: 'a', label: '来源一' },
          { value: 'b', label: '来源二' },
        ]}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider defaultMode="light">
    <Harness />
  </ThemeProvider>,
)
