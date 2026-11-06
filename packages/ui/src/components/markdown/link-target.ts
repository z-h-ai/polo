import { isFilePathTarget } from './linkify'

export type ResolvedMarkdownLinkTarget =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }

function normalizeFileUrlPath(path: string): string {
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
}

function resolveFileUrlPath(target: string): string | null {
  if (!/^file:/i.test(target)) return null

  try {
    const parsed = new URL(target)
    if (parsed.protocol !== 'file:') return null

    const pathname = decodeURIComponent(parsed.pathname || '')
    if (!pathname && !parsed.hostname) return null

    if (parsed.hostname) {
      const hostname = decodeURIComponent(parsed.hostname)
      return normalizeFileUrlPath(`//${hostname}${pathname}`)
    }

    return normalizeFileUrlPath(pathname)
  } catch {
    return null
  }
}

/**
 * Resolve markdown link targets for click dispatch.
 *
 * - Raw filesystem paths are routed through onFileClick
 * - Explicit file:// URLs are normalized to filesystem paths and also routed through onFileClick
 * - Everything else is treated as a URL and routed through onUrlClick
 */
export function resolveMarkdownLinkTarget(target: string): ResolvedMarkdownLinkTarget {
  const trimmed = target.trim()

  const fileUrlPath = resolveFileUrlPath(trimmed)
  if (fileUrlPath) {
    return { kind: 'file', path: fileUrlPath }
  }

  if (isFilePathTarget(trimmed)) {
    return { kind: 'file', path: trimmed }
  }

  return { kind: 'url', url: trimmed }
}

/**
 * Backward-compatible classifier for tests and existing callers that only need the kind.
 */
export function classifyMarkdownLinkTarget(target: string): 'file' | 'url' {
  return resolveMarkdownLinkTarget(target).kind
}

/** Schemes that must never stand in as an openable fallback link target. */
const UNSAFE_FALLBACK_SCHEME = /^(?:javascript|data|vbscript|blob):/i

/**
 * Whether anchor text that has to stand in for a missing href is actually
 * openable (POO-172/CITE-02). Plain-text citation references ("Source 1",
 * "见来源 A") resolve to nothing openable and must render as non-interactive
 * text instead of a misleading fake link — only a filesystem path or a URL
 * with an explicit, non-dangerous scheme qualifies.
 */
export function isOpenableMarkdownLinkText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (resolveMarkdownLinkTarget(trimmed).kind === 'file') return true
  if (UNSAFE_FALLBACK_SCHEME.test(trimmed)) return false
  try {
    return new URL(trimmed).protocol !== ''
  } catch {
    return false
  }
}
