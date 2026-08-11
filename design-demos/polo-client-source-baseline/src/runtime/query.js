import catalog from '../../scene-catalog.json'

export const DEFAULT_QUERY = Object.freeze({ scene: 'home', state: 'normal', theme: 'light', lang: 'zh-Hans' })
const THEMES = new Set(['light', 'dark'])
const LANGUAGES = new Set(['zh-Hans', 'en', 'es', 'ja', 'hu', 'de', 'pl'])
const SCENES = new Map(catalog.scenes.map((scene) => [scene.id, scene]))

function firstState(scene) {
  return scene?.states?.[0] ?? DEFAULT_QUERY.state
}

export function getScene(id) { return SCENES.get(id) ?? null }
export function getCatalog() { return catalog }

export function normalizeQuery(input = {}) {
  const scene = getScene(input.scene) ?? getScene(DEFAULT_QUERY.scene)
  const normalizedScene = scene?.id ?? DEFAULT_QUERY.scene
  const requestedState = typeof input.state === 'string' ? input.state : ''
  const state = scene?.states?.includes(requestedState) ? requestedState : firstState(scene)
  const theme = THEMES.has(input.theme) ? input.theme : DEFAULT_QUERY.theme
  const lang = LANGUAGES.has(input.lang) ? input.lang : DEFAULT_QUERY.lang
  return { scene: normalizedScene, state, theme, lang }
}

export function readQuery(url = window.location.href) {
  const params = new URL(url).searchParams
  return normalizeQuery({
    scene: params.get('scene') ?? undefined,
    state: params.get('state') ?? undefined,
    theme: params.get('theme') ?? undefined,
    lang: params.get('lang') ?? undefined,
  })
}

export function writeQuery(next, { replace = true } = {}) {
  const normalized = normalizeQuery(next)
  const url = new URL(window.location.href)
  Object.entries(normalized).forEach(([key, value]) => url.searchParams.set(key, value))
  if (replace) window.history.replaceState({}, '', url)
  else window.history.pushState({}, '', url)
  return normalized
}

export function queryOptions() {
  return { scenes: [...SCENES.keys()], themes: [...THEMES], languages: [...LANGUAGES] }
}
