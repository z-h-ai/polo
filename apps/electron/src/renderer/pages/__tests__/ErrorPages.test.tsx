import React from 'react'
import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ServerErrorPage, { type ServerErrorPageProps } from '../ServerErrorPage'
import ConfigErrorPage, { type ConfigErrorPageProps } from '../ConfigErrorPage'

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

function renderServerErrorPage(props: Partial<ServerErrorPageProps> = {}) {
  return renderToStaticMarkup(
    <ServerErrorPage
      serverUrl="https://admin.example.com"
      onRetry={() => {}}
      {...props}
    />,
  )
}

function renderConfigErrorPage(props: Partial<ConfigErrorPageProps> = {}) {
  return renderToStaticMarkup(
    <ConfigErrorPage
      onRetry={() => {}}
      {...props}
    />,
  )
}

describe('ServerErrorPage', () => {
  it('renders the authentication server connection error', () => {
    const html = renderServerErrorPage()

    expect(html).toContain('无法连接')
    expect(html).toContain('认证服务器')
  })

  it('shows the configured server URL', () => {
    const html = renderServerErrorPage()

    expect(html).toContain('https://admin.example.com')
  })

  it('has a retry button', () => {
    const html = renderServerErrorPage()

    expect(html).toContain('重试')
    expect(html).toContain('type="button"')
  })

  it('calls onRetry when retry is clicked', () => {
    const onRetry = mock(() => {})
    const tree = ServerErrorPage({ serverUrl: 'https://admin.example.com', onRetry })
    const button = findButton(tree, '重试')

    expect(button).toBeDefined()
    ;(button?.props.onClick as () => void)()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('disables the retry button and shows a spinner while retrying', () => {
    const html = renderServerErrorPage({ isRetrying: true })

    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('data-testid="server-error-retry-spinner"')
  })

  it('marks the error message as an alert', () => {
    const html = renderServerErrorPage()

    expect(html).toContain('role="alert"')
  })
})

describe('ConfigErrorPage', () => {
  it('renders the config loading error', () => {
    const html = renderConfigErrorPage()

    expect(html).toContain('配置加载失败')
  })

  it('has a retry button', () => {
    const html = renderConfigErrorPage()

    expect(html).toContain('重试')
    expect(html).toContain('type="button"')
  })

  it('calls onRetry when retry is clicked', () => {
    const onRetry = mock(() => {})
    const tree = ConfigErrorPage({ onRetry })
    const button = findButton(tree, '重试')

    expect(button).toBeDefined()
    ;(button?.props.onClick as () => void)()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('disables the retry button and shows a spinner while retrying', () => {
    const html = renderConfigErrorPage({ isRetrying: true })

    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('data-testid="config-error-retry-spinner"')
  })
})
