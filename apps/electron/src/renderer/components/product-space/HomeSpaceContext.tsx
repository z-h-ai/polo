import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import type { CreatorCircleRelation } from '@/hooks/useAppCatalog'

interface HomeSpaceContextProps {
  /** Currently committed ProductSpace name (context title). */
  spaceName: string
  /** personal spaces carry the CreatorCircle relation entry; enterprise never. */
  spaceKind: 'personal' | 'enterprise' | null
  /** CreatorCircle relations visible in the active space's Catalog (REQ-022). */
  creatorCircles: CreatorCircleRelation[]
  /**
   * Stable ProductSpace identity (account+space context key). A change —
   * including a flip to enterprise or empty relations — resets the mounted
   * view back to `context`, so the circles relation view can never linger
   * across a space transition.
   */
  spaceKey?: string
}

/**
 * POO-41 frozen home context block (§4.3): the current ProductSpace title
 * with a "我的圈子" relation entry for personal spaces. CreatorCircle lives
 * ONLY here — never inside the ProductSpace switcher. The entry is
 * data-driven: it renders only for a personal space with at least one
 * visible creator_circle relation, and opens the in-place circles relation
 * view (no top-level route).
 */
export function HomeSpaceContext({
  spaceName,
  spaceKind,
  creatorCircles,
  spaceKey,
}: HomeSpaceContextProps) {
  const { t } = useTranslation()
  const [view, setView] = useState<'context' | 'circles'>('context')
  const showCirclesEntry = spaceKind === 'personal' && creatorCircles.length > 0

  // Fail-closed transitions: a ProductSpace identity change or a lost guard
  // (non-personal / relations emptied) always collapses back to the context
  // view — the circles relation view never lingers across a transition.
  useEffect(() => {
    setView('context')
  }, [spaceKey])
  useEffect(() => {
    if (spaceKind !== 'personal' || creatorCircles.length === 0) {
      setView('context')
    }
  }, [spaceKind, creatorCircles])

  return (
    <section
      aria-label={t('homeSpace.context.ariaLabel')}
      data-testid="home-space-context"
      className="mb-4 rounded-xl border border-foreground/10 px-4 py-3"
    >
      {/* Fail-closed render predicate: the circles branch requires BOTH the
          persisted view state AND the live guard (personal + non-empty
          relations). The effects below only normalize state after render —
          this predicate guarantees an invalid branch can never render, not
          even for the first frame after an identity change or guard loss. */}
      {view === 'circles' && showCirclesEntry ? (
        <div data-testid="product-space-relation-my-circles-view">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">
                {t('homeSpace.context.myCircles')}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('homeSpace.context.circlesSubtitle', {
                  count: creatorCircles.length,
                })}
              </p>
            </div>
            <button
              type="button"
              data-testid="product-space-relation-my-circles-back"
              className="rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-foreground/4"
              onClick={() => { setView('context') }}
            >
              {t('homeSpace.context.back')}
            </button>
          </div>
          <ul className="mt-3 flex flex-col gap-1.5">
            {creatorCircles.map(circle => (
              <li
                key={circle.circleId}
                data-testid="product-space-relation-my-circles-item"
                className="flex items-center justify-between gap-3 rounded-lg border border-border/40 px-3 py-2 text-sm"
              >
                <span className="truncate font-medium">{circle.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t('homeSpace.context.circleRelation')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div>
          <h2 className="text-base font-semibold">{spaceName}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {spaceKind === 'enterprise'
              ? t('homeSpace.context.enterpriseDescription')
              : t('homeSpace.context.personalDescription')}
          </p>
          {showCirclesEntry && (
            <button
              type="button"
              data-testid="product-space-relation-my-circles"
              className="mt-3 flex w-full items-center gap-3 rounded-lg border border-foreground/10 px-3 py-2.5 text-left hover:bg-foreground/4"
              onClick={() => { setView('circles') }}
            >
              <Icons.Circle className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">
                  {t('homeSpace.context.myCircles')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('homeSpace.context.circlesCount', {
                    count: creatorCircles.length,
                  })}
                </span>
              </span>
              <Icons.ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          )}
        </div>
      )}
    </section>
  )
}
