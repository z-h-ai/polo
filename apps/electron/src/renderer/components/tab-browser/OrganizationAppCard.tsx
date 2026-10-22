import type { CatalogApp } from '@polo-ai/shared/admin'

/** Shared Catalog artwork only; runtime controls belong to POO-47. */
export function AppArtwork({ app }: { app: CatalogApp }) {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-foreground/10 bg-[var(--background-elevated)] shadow-xs">
      {app.iconUrl ? (
        <img src={app.iconUrl} alt="" className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center bg-gradient-to-br from-sky-500 to-indigo-600 text-lg font-semibold text-white">
          {app.name.trim().slice(0, 1).toUpperCase() || '?'}
        </span>
      )}
    </div>
  )
}
