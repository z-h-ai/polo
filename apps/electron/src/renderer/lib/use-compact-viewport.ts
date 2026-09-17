import { useEffect, useState } from 'react'

const COMPACT_VIEWPORT_QUERY = '(max-width: 1100px)'

/**
 * True when the All Apps inspector should render as an inline expanded row
 * instead of a side panel. The POO-41 frozen 640px window guard sits below
 * this range, so "compact" only applies to medium desktop widths.
 */
export function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(
    () => window.matchMedia(COMPACT_VIEWPORT_QUERY).matches,
  )

  useEffect(() => {
    const query = window.matchMedia(COMPACT_VIEWPORT_QUERY)
    const update = () => { setCompact(query.matches) }
    update()
    query.addEventListener('change', update)
    return () => { query.removeEventListener('change', update) }
  }, [])

  return compact
}
