export type HomeRecentAppKind = 'builtin' | 'external' | 'organization'

export interface HomeRecentAppPreference {
  id: string
  kind: HomeRecentAppKind
  openedAt: number
}

export type HomeRecentAppsByContext = Record<
  string,
  HomeRecentAppPreference[]
>

const MAX_ADMIN_ENTITY_ID_LENGTH = 512
const MAX_ESCAPED_ENTITY_ID_LENGTH = MAX_ADMIN_ENTITY_ID_LENGTH * 6

// JSON renders one NUL code unit as six characters. These ceilings cover the
// exact worst case for v2:<account, organization> and the complete Catalog
// scope tuple without weakening the shared 512-character entity ID contract.
export const MAX_HOME_RECENT_CONTEXT_KEY_LENGTH =
  'v2:'.length + JSON.stringify(['', '']).length
  + (2 * MAX_ESCAPED_ENTITY_ID_LENGTH)

export const MAX_HOME_RECENT_APP_ID_LENGTH =
  JSON.stringify(['catalog', '', '', '']).length
  + (3 * MAX_ESCAPED_ENTITY_ID_LENGTH)
