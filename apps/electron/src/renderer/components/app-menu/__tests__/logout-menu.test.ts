import { describe, expect, it } from 'bun:test'
import { buildMobileMenuPages } from '../mobile-menu-pages'

describe('app menu logout item', () => {
  it('includes a visible logout item in the mobile root menu', () => {
    const pages = buildMobileMenuPages({
      hasNewWindow: true,
      isDebugMode: false,
      platformMode: false,
    })

    const root = pages.find((page) => page.id === 'root')

    expect(root?.rows).toContainEqual(expect.objectContaining({
      id: 'logout',
      iconName: 'LogOut',
      labelKey: 'menu.logout',
      action: { kind: 'callback', key: 'logout' },
    }))
  })
})
