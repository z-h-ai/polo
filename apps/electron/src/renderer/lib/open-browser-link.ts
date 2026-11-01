import type { ElectronAPI } from '../../shared/types'

type BrowserLinkAPI = Pick<ElectronAPI['browserPane'], 'create' | 'focus' | 'navigate' | 'list'>

/** Chat/resource links restore the session's current browser presentation. */
export async function openBrowserLink(api: BrowserLinkAPI, url: string, options: {
  sessionId?: string
  isScopeCurrent: () => boolean
}): Promise<void> {
  if (!options.isScopeCurrent()) return
  const id = await api.create({ show: false, bindToSessionId: options.sessionId })
  if (!options.isScopeCurrent()) return
  await api.focus(id)
  if (!options.isScopeCurrent()) return
  const current = (await api.list()).find(instance => instance.id === id)
  if (!options.isScopeCurrent()) return
  if (current && sameBrowserUrl(current.url, url)) return
  await api.navigate(id, url)
}

function sameBrowserUrl(current: string, target: string): boolean {
  try { return new URL(current).href === new URL(target).href } catch { return current === target }
}
