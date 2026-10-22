import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ProductSpaceCatalogResponseSchema, ProductSpaceCatalogEntrySchema } from '@polo-ai/shared/product-spaces'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { clientWorkbenchButtonClassName, clientWorkbenchDialogClassName } from '@/components/ui/client-workbench'

type SkillEntry = Extract<ReturnType<typeof ProductSpaceCatalogResponseSchema.parse>['entries'][number], { kind: 'skill' }>
type View = { scope: string; withdrawn?: string[]; entries: SkillEntry[]; prepared: Record<string, string>; loading: boolean; error: string | null }

/** Authorization, personal enablement and native preparation remain separate.
 * Main owns account identity, fresh grants and installation; this view only
 * addresses a row in the current committed space. */
export function ProductSpaceSkillsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const context = useOptionalProductSpaceContext()
  const workspace = useActiveWorkspace()
  const active = context?.activeProductSpace
  const scope = JSON.stringify([context?.accountId, active?.id, context?.contextVersion, workspace?.id])
  const currentScope = useRef(scope)
  const generation = useRef(0)
  const pending = useRef(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState<View>({ scope, entries: [], prepared: {}, loading: true, error: null })
  useLayoutEffect(() => {
    currentScope.current = scope
    generation.current += 1
    pending.current = false
    setBusy(null)
    return () => { generation.current += 1 }
  }, [scope])
  const read = useCallback(async () => {
    const invocation = ++generation.current
    const isCurrent = () => invocation === generation.current && scope === currentScope.current
    if (!context?.accountId || !active || !workspace) {
      setView({ scope, entries: [], prepared: {}, loading: false, error: 'scope_unavailable' })
      return
    }
    setView(old => ({ ...old, scope, loading: true, error: null, ...(old.scope !== scope ? { entries: [], prepared: {} } : {}) }))
    try {
      const result = await window.electronAPI.productSpaceListSkills(active.id)
      if (!isCurrent()) return
      if (!result.success) throw new Error(result.errorCode)
      if (result.productSpaceId !== active.id) throw new Error('catalog_scope_invalid')
      const entries = [...result.entries,...result.withdrawnEntries].map(entry => ProductSpaceCatalogEntrySchema.parse(entry)).filter((entry):entry is SkillEntry => entry.kind === 'skill')
      const installed = result.accessMode === 'active' ? await window.electronAPI.getSkills(workspace.id) : []
      if (!isCurrent()) return
      const prepared: Record<string, string> = {}
      for (const skill of installed) {
        const native = skill.canonicalInstallation
        if (native?.canonicalSource.accountId === context.accountId && native.canonicalSource.productSpaceId === active.id) prepared[native.canonicalSource.subjectId] = native.canonicalSource.versionId
      }
      setView({ scope, entries, withdrawn: result.withdrawnEntries.map(entry => String(entry.artifactInstanceId)), prepared, loading: false, error: null })
    } catch (error) {
      if (!isCurrent()) return
      // Authority failures clear old private metadata; transient failures are
      // visible and none of the retained records can perform a mutation.
      setView(old => ({ ...old, scope, loading: false, error: error instanceof Error ? error.message : 'request_failed', entries: [], prepared: {} }))
    }
  }, [scope, context?.accountId, active?.id, workspace?.id])
  useEffect(() => { void read() }, [read])
  const mutate = async (entry: SkillEntry, action: 'toggle' | 'prepare') => {
    if (pending.current || view.scope !== scope || view.loading || view.error || !active || !workspace) return
    if ((action === 'prepare' || !entry.enabled) && (active.accessMode !== 'active' || entry.availability !== 'available')) return
    if (action === 'prepare' && !entry.enabled) return
    pending.current = true
    const invocation = ++generation.current
    const isCurrent = () => invocation === generation.current && currentScope.current === scope
    setBusy(entry.artifactInstanceId)
    try {
      if (action === 'toggle') {
        const result = await window.electronAPI.productSpaceSetSkillEnablement(active.id, entry.artifactInstanceId, !entry.enabled)
        if (!isCurrent()) return
        if (!result.success) throw new Error(result.errorCode)
        if (result.mutation.productSpaceId !== active.id || result.mutation.artifactInstanceId !== entry.artifactInstanceId || result.mutation.enabled !== !entry.enabled) throw new Error('enablement_scope_invalid')
      } else {
        const result = await window.electronAPI.productSpaceInstallSkill({ workspaceId: workspace.id, catalogEntryId: entry.catalogEntryId, operationId: crypto.randomUUID() })
        if (!isCurrent()) return
        if (!result.success) throw new Error(result.errorCode)
      }
      await read()
    } catch (error) {
      if (isCurrent()) setView(old => ({ ...old, error: error instanceof Error ? error.message : 'request_failed' }))
    } finally {
      if (scope === currentScope.current) { pending.current = false; setBusy(null) }
    }
  }
  const visible = view.scope === scope ? view : { scope, entries: [], prepared: {}, loading: true, error: null }
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className={`${clientWorkbenchDialogClassName} max-h-[85vh] overflow-y-auto sm:max-w-[720px]`}>
      <DialogHeader>
        <DialogTitle>{t('productSpaceSkills.title', { defaultValue: 'Manage skills' })}</DialogTitle>
        <DialogDescription>{active?.name ?? ''} · {t('productSpaceSkills.description', { defaultValue: 'Enable a skill for yourself, then prepare its current version on this device.' })}</DialogDescription>
      </DialogHeader>
      {visible.loading && <p role="status">{t('productSpaceSkills.loading', { defaultValue: 'Loading skills…' })}</p>}
      {visible.error && <div role="alert"><p>{t('productSpaceSkills.failed', { defaultValue: 'Could not confirm the skill state. Check your connection and retry.' })}</p><Button className={clientWorkbenchButtonClassName} onClick={() => { void read() }} disabled={!!busy}>{t('productSpaceSkills.retry', { defaultValue: 'Retry' })}</Button></div>}
      {!visible.loading && !visible.error && visible.entries.length === 0 && <p>{t('productSpaceSkills.empty', { defaultValue: 'No skills are available in this space.' })}</p>}
      {visible.entries.map(entry => <article key={entry.artifactInstanceId} data-testid="product-space-skill-row" className="rounded-xl border border-border p-4">
        <h3 className="font-semibold break-words">{entry.name}</h3>
        <p className="mt-1 text-sm text-muted-foreground break-words whitespace-pre-wrap">{entry.description}</p>
        {visible.withdrawn?.includes(entry.artifactInstanceId) && <p className="mt-2 text-sm">{t('productSpaceSkills.withdrawn', {defaultValue:'Authorization ended. You can clear your previous enablement choice.'})}</p>}
        <p className="mt-2 text-xs text-muted-foreground">{entry.sources.map(source => source.name).join(' · ')} · {entry.version.version}</p>
        <p className="mt-2 text-sm">{entry.availability !== 'available' ? t('productSpaceSkills.unavailable', { defaultValue: 'Authorization unavailable' }) : entry.enabled ? t('productSpaceSkills.enabled', { defaultValue: 'Enabled for me' }) : t('productSpaceSkills.disabled', { defaultValue: 'Disabled for me' })} · {visible.prepared[entry.artifactInstanceId] === entry.version.versionId ? t('productSpaceSkills.prepared', { defaultValue: 'Current version prepared' }) : t('productSpaceSkills.unprepared', { defaultValue: 'Current version not prepared' })}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button className={clientWorkbenchButtonClassName} disabled={!!busy || visible.loading || !!visible.error || (!entry.enabled && (active?.accessMode !== 'active' || entry.availability !== 'available'))} onClick={() => { void mutate(entry, 'toggle') }}>{t(entry.enabled ? 'productSpaceSkills.disable' : 'productSpaceSkills.enable', { defaultValue: entry.enabled ? 'Disable' : 'Enable' })}</Button>
          <Button className={clientWorkbenchButtonClassName} disabled={!!busy || visible.loading || !!visible.error || !entry.enabled || active?.accessMode !== 'active' || entry.availability !== 'available'} onClick={() => { void mutate(entry, 'prepare') }}>{busy === entry.artifactInstanceId ? t('productSpaceSkills.processing', { defaultValue: 'Processing…' }) : t('productSpaceSkills.prepare', { defaultValue: 'Download / update' })}</Button>
        </div>
      </article>)}
    </DialogContent>
  </Dialog>
}
