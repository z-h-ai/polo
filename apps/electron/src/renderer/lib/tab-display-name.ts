import type { TFunction } from 'i18next'
import {
  BUILTIN_APP_IDS,
  KNOWLEDGE_BASE_APP_ID,
  POLO_APP_ID,
  type AppDefinition,
  type TabInstance,
} from '../../shared/tab-browser-types'

/**
 * product-closure U7 (LV-E02): the built-in app display names are i18n keys
 * resolved at RENDER time — the persisted `title`/`name` (historically the
 * zh-Hans literal 'Polo 助手' / '企业知识库') is only a non-secret fallback for
 * persistence debugging. Overrides by built-in app id, so a tab restored from
 * an old localStorage snapshot displays in the CURRENT language and flips
 * immediately on language change; third-party and user-renamed apps keep
 * their stored names untouched.
 */
export function localizedTabTitle(
  tab: Pick<TabInstance, 'appId' | 'title' | 'type'>,
  t: TFunction,
): string {
  if (tab.appId === POLO_APP_ID || tab.type === 'polo') return t('tabName.poloAssistant')
  if (tab.appId === KNOWLEDGE_BASE_APP_ID || tab.type === 'knowledge-base') {
    return t('tabName.knowledgeBase')
  }
  return tab.title
}

/** Same override for catalog/home-app surfaces that render an AppDefinition name. */
export function localizedAppName(
  app: Pick<AppDefinition, 'id' | 'name'>,
  t: TFunction,
): string {
  if (BUILTIN_APP_IDS.has(app.id)) {
    return app.id === POLO_APP_ID ? t('tabName.poloAssistant') : t('tabName.knowledgeBase')
  }
  return app.name
}
