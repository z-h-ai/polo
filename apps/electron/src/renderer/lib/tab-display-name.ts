import type { TFunction } from 'i18next'
import {
  POLO_APP_ID,
  type AppDefinition,
  type TabInstance,
} from '../../shared/tab-browser-types'

/**
 * product-closure U7 (LV-E02): the built-in app display name is an i18n key
 * resolved at RENDER time — the persisted `title`/`name` (historically the
 * zh-Hans literal 'Polo 助手') is only a non-secret fallback for persistence
 * debugging. Overridden by built-in app id, so a tab restored from an old
 * localStorage snapshot displays in the CURRENT language and flips
 * immediately on language change; third-party and user-renamed apps keep
 * their stored names untouched. (POO-205: the enterprise-KB built-in
 * retired — the assistant is the only built-in left.)
 */
export function localizedTabTitle(
  tab: Pick<TabInstance, 'appId' | 'title' | 'type'>,
  t: TFunction,
): string {
  if (tab.appId === POLO_APP_ID || tab.type === 'polo') return t('tabName.poloAssistant')
  return tab.title
}

/** Same override for catalog/home-app surfaces that render an AppDefinition name. */
export function localizedAppName(
  app: Pick<AppDefinition, 'id' | 'name'>,
  t: TFunction,
): string {
  if (app.id === POLO_APP_ID) return t('tabName.poloAssistant')
  return app.name
}
