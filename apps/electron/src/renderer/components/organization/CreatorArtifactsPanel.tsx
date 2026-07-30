import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Download,
  FileArchive,
  Globe2,
  PackagePlus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@polo-ai/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { emitAdminAuthFailure } from '@/lib/admin-auth-failure'
import type {
  CreatorArtifact,
  CreatorArtifactDetail,
  CreatorArtifactVersion,
  CreatorSkillInstallInput,
  CreatorSkillOperationProgress,
  SkillValidationIssue,
} from '../../../shared/types'

interface CreatorArtifactsPanelProps {
  organizationId: string
  canManage: boolean
  workspaceId: string | null
  workingDirectory?: string
}

type ActionState =
  | 'create-artifact'
  | 'create-version'
  | 'upload'
  | 'publish'
  | 'install'
  | 'archive'
  | 'delete'
  | 'revoke'
  | 'open-web-app'
  | null

function idempotencyKey(action: string): string {
  return `polo-${action}-${crypto.randomUUID()}`
}

function resultMessage(
  t: ReturnType<typeof useTranslation>['t'],
  result: { errorCode?: string; message?: string },
): string {
  emitAdminAuthFailure(result)
  return t(`creatorSkills.errors.${result.errorCode ?? 'unknown'}`, {
    defaultValue: result.message || t('creatorSkills.errors.unknown'),
  })
}

export function CreatorArtifactsPanel({
  organizationId,
  canManage,
  workspaceId,
  workingDirectory,
}: CreatorArtifactsPanelProps) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [artifacts, setArtifacts] = useState<CreatorArtifact[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CreatorArtifactDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [action, setAction] = useState<ActionState>(null)
  const [error, setError] = useState<string | null>(null)
  const [issues, setIssues] = useState<SkillValidationIssue[]>([])
  const [newArtifactType, setNewArtifactType] = useState<'web_app' | 'skill' | null>(null)
  const [slug, setSlug] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [changelog, setChangelog] = useState('')
  const [draftVersionId, setDraftVersionId] = useState<string | null>(null)
  const [installVersion, setInstallVersion] = useState('')
  const [progress, setProgress] = useState<CreatorSkillOperationProgress | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [uploadOperationId, setUploadOperationId] = useState<string | null>(null)
  const [target, setTarget] = useState<{
    name: string
    path: string
    writable: boolean
  } | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const requestGeneration = useRef(0)

  const loadArtifacts = useCallback(async () => {
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(null)
    try {
      const capability = await window.electronAPI.creatorArtifactGetCapabilities()
      if (generation !== requestGeneration.current) return
      if (!capability.success) {
        setEnabled(false)
        setError(resultMessage(t, capability))
        return
      }
      setEnabled(capability.creatorSkillArtifacts)
      if (!capability.creatorSkillArtifacts) {
        setNewArtifactType(current => current === 'skill' ? null : current)
      }
      const result = await window.electronAPI.creatorArtifactList({
        organizationId,
        ...(!capability.creatorSkillArtifacts ? { type: 'web_app' as const } : {}),
        includeDrafts: canManage,
      })
      if (generation !== requestGeneration.current) return
      if (!result.success) {
        setError(resultMessage(t, result))
        return
      }
      setArtifacts(result.artifacts)
      setSelectedId(current => (
        current && result.artifacts.some(item => item.id === current)
          ? current
          : result.artifacts[0]?.id ?? null
      ))
    } catch (caught) {
      if (generation !== requestGeneration.current) return
      emitAdminAuthFailure(
        caught && typeof caught === 'object'
          ? caught as { code?: string; errorCode?: string; status?: number }
          : {},
      )
      setError(t('creatorSkills.errors.unknown'))
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }, [canManage, organizationId, t])

  const loadDetail = useCallback(async (artifactId: string) => {
    setDetailLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.creatorArtifactGet({
        organizationId,
        artifactId,
      })
      if (!result.success) {
        setDetail(null)
        setError(resultMessage(t, result))
        return
      }
      setDetail({
        artifact: result.artifact,
        versions: result.versions,
        skillContent: result.skillContent,
        fileTree: result.fileTree,
      })
      const published = result.versions
        .filter(item => item.status === 'published')
        .sort((left, right) => right.version.localeCompare(left.version))
      setInstallVersion(current => (
        published.some(item => item.version === current)
          ? current
          : result.artifact.latestPublishedVersion ?? published[0]?.version ?? ''
      ))
      const draft = result.versions.find(item => (
        item.status !== 'published'
        && item.status !== 'revoked'
        && item.status !== 'expired'
      ))
      setDraftVersionId(draft?.id ?? null)
      setIssues(draft?.validationIssues ?? [])
      setVersion('1.0.0')
      setChangelog(
        result.versions.length === 0
          ? t('creatorSkills.version.initialChangelog')
          : '',
      )
    } catch (caught) {
      emitAdminAuthFailure(
        caught && typeof caught === 'object'
          ? caught as { code?: string; errorCode?: string; status?: number }
          : {},
      )
      setDetail(null)
      setError(t('creatorSkills.errors.unknown'))
    } finally {
      setDetailLoading(false)
    }
  }, [organizationId, t])

  useEffect(() => {
    void loadArtifacts()
    return () => {
      requestGeneration.current += 1
    }
  }, [loadArtifacts])

  useEffect(() => {
    const selected = artifacts.find(item => item.id === selectedId)
    if (selected?.type === 'skill') {
      void loadDetail(selected.id)
    } else {
      setDetail(null)
      setDetailLoading(false)
    }
  }, [artifacts, loadDetail, selectedId])

  useEffect(() => {
    if (!workspaceId) {
      setTarget(null)
      return
    }
    let active = true
    window.electronAPI.creatorSkillGetTarget({ workspaceId }).then(result => {
      if (!active) return
      setTarget(result.success
        ? { name: result.name, path: result.path, writable: result.writable }
        : null)
    }).catch(() => {
      if (active) setTarget(null)
    })
    return () => {
      active = false
    }
  }, [workspaceId])

  useEffect(() => {
    const subscribe = window.electronAPI.onCreatorSkillProgress
    if (!subscribe) return
    return subscribe(next => {
      if (next.operationId === operationId) setProgress(next)
    })
  }, [operationId])

  useEffect(() => {
    const validating = detail?.versions.find(item => (
      item.id === draftVersionId
      && (item.status === 'uploaded' || item.status === 'validating')
    ))
    if (!validating || !detail) return
    const timer = window.setInterval(() => {
      void loadDetail(detail.artifact.id)
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [detail, draftVersionId, loadDetail])

  const selectedVersion = useMemo(
    () => detail?.versions.find(item => item.version === installVersion),
    [detail, installVersion],
  )
  const draftVersion = useMemo(
    () => detail?.versions.find(item => item.id === draftVersionId),
    [detail, draftVersionId],
  )
  const selectedArtifact = useMemo(
    () => artifacts.find(item => item.id === selectedId) ?? null,
    [artifacts, selectedId],
  )

  const openWebAppManagement = async () => {
    setAction('open-web-app')
    setError(null)
    try {
      const status = await window.electronAPI.adminGetStatus()
      if (!status.adminUrl) {
        setError(t('creatorSkills.errors.webAppManagementUnavailable'))
        return
      }
      const managementUrl = new URL('/organization-apps', status.adminUrl)
      managementUrl.searchParams.set('organizationId', organizationId)
      await window.electronAPI.openUrl(managementUrl.toString())
    } catch {
      setError(t('creatorSkills.errors.webAppManagementUnavailable'))
    } finally {
      setAction(null)
    }
  }

  const createArtifact = async () => {
    const normalized = slug.trim()
    if (!normalized) return
    setAction('create-artifact')
    setError(null)
    try {
      const result = await window.electronAPI.creatorArtifactCreate({
        organizationId,
        type: 'skill',
        slug: normalized,
        idempotencyKey: idempotencyKey('artifact-create'),
      })
      if (!result.success) {
        setError(resultMessage(t, result))
        return
      }
      setSlug('')
      await loadArtifacts()
      setSelectedId(result.artifact.id)
    } finally {
      setAction(null)
    }
  }

  const createVersion = async () => {
    if (!detail) return
    setAction('create-version')
    setError(null)
    try {
      const result = await window.electronAPI.creatorArtifactCreateVersion({
        organizationId,
        artifactId: detail.artifact.id,
        version: version.trim(),
        ...(changelog.trim() ? { changelog: changelog.trim() } : {}),
        idempotencyKey: idempotencyKey('version-create'),
      })
      if (!result.success) {
        setError(resultMessage(t, result))
        return
      }
      setDraftVersionId(result.version.id)
      await loadDetail(detail.artifact.id)
    } finally {
      setAction(null)
    }
  }

  const uploadArchive = async (file: File) => {
    if (!detail || !draftVersionId) return
    const archivePath = window.electronAPI.getFilePath(file)
    if (!archivePath) {
      setError(t('creatorSkills.errors.localFileRequired'))
      return
    }
    setAction('upload')
    const nextUploadOperationId = crypto.randomUUID()
    setUploadOperationId(nextUploadOperationId)
    setError(null)
    setIssues([])
    try {
      const result = await window.electronAPI.creatorArtifactUploadArchive({
        organizationId,
        artifactId: detail.artifact.id,
        versionId: draftVersionId,
        archivePath,
        operationId: nextUploadOperationId,
        idempotencyKey: idempotencyKey('version-upload'),
      })
      if (!result.success) {
        setIssues(result.validationIssues ?? [])
        setError(resultMessage(t, result))
        return
      }
      setIssues(result.warnings ?? [])
      await loadDetail(detail.artifact.id)
    } finally {
      setAction(null)
      setUploadOperationId(null)
    }
  }

  const publishVersion = async () => {
    if (!detail || !draftVersionId) return
    setAction('publish')
    setError(null)
    try {
      const result = await window.electronAPI.creatorArtifactPublishVersion({
        organizationId,
        artifactId: detail.artifact.id,
        versionId: draftVersionId,
        idempotencyKey: idempotencyKey('version-publish'),
      })
      if (!result.success) {
        setError(resultMessage(t, result))
        return
      }
      await Promise.all([loadArtifacts(), loadDetail(detail.artifact.id)])
    } finally {
      setAction(null)
    }
  }

  const deleteVersionDraft = async () => {
    if (!detail || !draftVersionId) return
    if (!window.confirm(t('creatorSkills.version.confirmDelete'))) return
    setAction('delete')
    setError(null)
    try {
      const result = await window.electronAPI.creatorArtifactDeleteVersionDraft({
        organizationId,
        artifactId: detail.artifact.id,
        versionId: draftVersionId,
        idempotencyKey: idempotencyKey('version-delete'),
      })
      if (!result.success) {
        setError(resultMessage(t, result))
        return
      }
      setDraftVersionId(null)
      await loadDetail(detail.artifact.id)
    } finally {
      setAction(null)
    }
  }

  const install = async (confirmations?: Partial<CreatorSkillInstallInput>) => {
    if (!detail || !workspaceId || !selectedVersion || !target?.writable) return
    setAction('install')
    setError(null)
    setProgress(null)
    const nextOperationId = operationId ?? crypto.randomUUID()
    setOperationId(nextOperationId)
    try {
      const grant = await window.electronAPI.creatorSkillGetDownloadGrant({
        organizationId,
        artifactId: detail.artifact.id,
        version: selectedVersion.version,
      })
      if (!grant.success) {
        setError(resultMessage(t, grant))
        return
      }
      const result = await window.electronAPI.creatorSkillInstall({
        workspaceId,
        ...(workingDirectory ? { workingDirectory } : {}),
        operationId: nextOperationId,
        grant: {
          artifactId: grant.artifactId,
          organizationId: grant.organizationId,
          slug: grant.slug,
          version: grant.version,
          url: grant.url,
          expiresAt: grant.expiresAt,
          archiveChecksum: grant.archiveChecksum,
          contentDigest: grant.contentDigest,
          manifest: grant.manifest,
          validationPolicy: grant.validationPolicy,
        },
        ...confirmations,
      })
      if (!result.success && result.conflicts?.length) {
        const accepted = window.confirm(
          t('creatorSkills.install.confirmConflict', {
            conflicts: result.conflicts
              .map(conflict => t(`creatorSkills.conflict.${conflict}`))
              .join('\n'),
          }),
        )
        if (accepted) {
          await install({
            replaceExisting: true,
            confirmGlobalOverride: true,
            backupLocalChanges: true,
          })
        }
        return
      }
      if (!result.success) {
        setError(`${result.message}\n${result.diagnostic}`)
        return
      }
      setProgress({
        operationId: nextOperationId,
        workspaceId,
        slug: detail.artifact.slug,
        stage: 'refresh',
        percent: 100,
        cancellable: false,
      })
    } catch {
      setError(t('creatorSkills.errors.unknown'))
    } finally {
      setAction(null)
      setOperationId(null)
    }
  }

  const setArchived = async (archived: boolean) => {
    if (!detail) return
    setAction('archive')
    try {
      const result = await window.electronAPI.creatorArtifactSetArchived({
        organizationId,
        artifactId: detail.artifact.id,
        archived,
        idempotencyKey: idempotencyKey(archived ? 'artifact-archive' : 'artifact-restore'),
      })
      if (!result.success) {
        setError(resultMessage(t, result))
        return
      }
      await Promise.all([loadArtifacts(), loadDetail(detail.artifact.id)])
    } finally {
      setAction(null)
    }
  }

  const deleteDraft = async () => {
    if (!detail) return
    if (!window.confirm(t('creatorSkills.artifact.confirmDelete'))) return
    setAction('delete')
    try {
      const result = await window.electronAPI.creatorArtifactDeleteDraft({
        organizationId,
        artifactId: detail.artifact.id,
        idempotencyKey: idempotencyKey('artifact-delete'),
      })
      if (!result.success) {
        setError(resultMessage(t, result))
        return
      }
      setSelectedId(null)
      await loadArtifacts()
    } finally {
      setAction(null)
    }
  }

  const revokeVersion = async (item: CreatorArtifactVersion) => {
    if (!detail || !revokeReason.trim()) return
    setAction('revoke')
    try {
      const result = await window.electronAPI.creatorArtifactRevokeVersion({
        organizationId,
        artifactId: detail.artifact.id,
        versionId: item.id,
        reason: revokeReason.trim(),
        idempotencyKey: idempotencyKey('version-revoke'),
      })
      if (!result.success) {
        setError(resultMessage(t, result))
        return
      }
      setRevokeReason('')
      await Promise.all([loadArtifacts(), loadDetail(detail.artifact.id)])
    } finally {
      setAction(null)
    }
  }

  if (loading || enabled === null) {
    return <div className="flex justify-center py-12"><Spinner /></div>
  }
  return (
    <div
      data-testid="creator-artifacts-panel"
      className="grid min-h-[440px] gap-4 pt-2 md:grid-cols-[220px_minmax(0,1fr)]"
    >
      <aside className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{t('creatorSkills.artifacts.title')}</h3>
          <Button type="button" variant="ghost" size="icon" onClick={() => { void loadArtifacts() }}>
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
        {canManage ? (
          <div className="space-y-2 rounded-xl border border-border/60 p-3">
            <Label>{t('creatorSkills.artifact.type')}</Label>
            <Select
              value={newArtifactType ?? undefined}
              onValueChange={value => setNewArtifactType(value as 'web_app' | 'skill')}
            >
              <SelectTrigger data-testid="creator-artifact-type-select">
                <SelectValue placeholder={t('creatorSkills.artifact.chooseType')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="web_app">
                  {t('creatorSkills.artifact.type.web_app')}
                </SelectItem>
                {enabled ? (
                  <SelectItem value="skill">
                    {t('creatorSkills.artifact.type.skill')}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            {newArtifactType === 'skill' ? (
              <>
                <Label htmlFor="creator-skill-slug">{t('creatorSkills.artifact.slug')}</Label>
                <Input
                  id="creator-skill-slug"
                  value={slug}
                  placeholder="my-skill"
                  onChange={event => setSlug(event.target.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  className="w-full"
                  disabled={action !== null || !slug.trim()}
                  onClick={() => { void createArtifact() }}
                >
                  {action === 'create-artifact'
                    ? <Spinner className="mr-1.5" />
                    : <PackagePlus className="mr-1.5 size-3.5" />}
                  {t('creatorSkills.artifact.create')}
                </Button>
              </>
            ) : newArtifactType === 'web_app' ? (
              <Button
                type="button"
                size="sm"
                className="w-full"
                disabled={action !== null}
                onClick={() => { void openWebAppManagement() }}
              >
                {action === 'open-web-app'
                  ? <Spinner className="mr-1.5" />
                  : <Globe2 className="mr-1.5 size-3.5" />}
                {t('creatorSkills.artifact.continueWebApp')}
              </Button>
            ) : null}
            {enabled === false ? (
              <p className="text-xs text-muted-foreground">
                {t('creatorSkills.featureDisabled')}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="max-h-[360px] space-y-1 overflow-auto">
          {artifacts.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              {t('creatorSkills.artifacts.empty')}
            </p>
          ) : artifacts.map(item => (
            <button
              type="button"
              key={item.id}
              data-testid="creator-artifact-row"
              className={[
                'w-full rounded-lg border px-3 py-2 text-left',
                item.id === selectedId
                  ? 'border-accent/40 bg-accent/5'
                  : 'border-transparent hover:bg-foreground/[0.04]',
              ].join(' ')}
              onClick={() => setSelectedId(item.id)}
            >
              <span className="block truncate text-sm font-medium">
                {item.displayIcon?.kind === 'emoji' ? `${item.displayIcon.value} ` : ''}
                {item.name || item.slug}
              </span>
              <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                {item.type === 'skill'
                  ? <FileArchive className="size-3" />
                  : <Globe2 className="size-3" />}
                <span>{t(`creatorSkills.artifact.type.${item.type}`)}</span>
                <span>·</span>
                {item.latestPublishedVersion ?? t(`creatorSkills.status.${item.status}`)}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section
        data-testid="creator-artifact-detail"
        className="min-w-0 max-h-[58vh] overflow-auto rounded-xl border border-border/60 p-4"
      >
        {detailLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : selectedArtifact?.type === 'web_app' ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-4 text-center">
            <Globe2 className="size-10 text-muted-foreground" />
            <div>
              <h2 className="text-lg font-semibold">
                {selectedArtifact.name || selectedArtifact.slug}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {selectedArtifact.summary || t('creatorSkills.artifact.webAppExistingFlow')}
              </p>
            </div>
            {canManage ? (
              <Button
                type="button"
                disabled={action !== null}
                onClick={() => { void openWebAppManagement() }}
              >
                {t('creatorSkills.artifact.manageWebApp')}
              </Button>
            ) : null}
            {error ? (
              <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
          </div>
        ) : !detail ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {t('creatorSkills.artifacts.select')}
          </p>
        ) : (
          <div className="space-y-5">
            <header className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold">
                  {detail.artifact.name || detail.artifact.slug}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {detail.artifact.summary || detail.artifact.slug}
                </p>
                <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] text-muted-foreground">
                  <FileArchive className="size-3" />
                  {t('creatorSkills.artifact.type.skill')}
                </span>
              </div>
              {canManage ? (
                <div className="flex gap-1">
                  {detail.artifact.status === 'draft' ? (
                    <Button type="button" size="icon" variant="ghost" onClick={() => { void deleteDraft() }}>
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => { void setArchived(detail.artifact.status !== 'archived') }}
                    >
                      {detail.artifact.status === 'archived'
                        ? <RotateCcw className="size-4" />
                        : <Archive className="size-4" />}
                    </Button>
                  )}
                </div>
              ) : null}
            </header>

            {detail.artifact.status === 'published' && selectedVersion ? (
              <div className="space-y-3 rounded-xl bg-foreground/[0.035] p-4">
                <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
                  <Select value={installVersion} onValueChange={setInstallVersion}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {detail.versions
                        .filter(item => item.status === 'published')
                        .map(item => (
                          <SelectItem key={item.id} value={item.version}>
                            {item.version}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <div className="min-w-0 text-xs text-muted-foreground">
                    <p>{selectedVersion.changelog || t('creatorSkills.version.noChangelog')}</p>
                    <p className="mt-1 font-mono">
                      {selectedVersion.archiveChecksum || '—'}
                    </p>
                    {selectedVersion.sizeBytes !== undefined ? (
                      <p className="mt-1">
                        {t('creatorSkills.metadata.size', {
                          size: selectedVersion.sizeBytes,
                        })}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="rounded-lg border border-border/50 px-3 py-2 text-xs">
                  {target ? (
                    <>
                      <strong>{target.name}</strong>
                      <span className="ml-2 break-all text-muted-foreground">{target.path}</span>
                    </>
                  ) : t('creatorSkills.install.noWorkspace')}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    disabled={action !== null || !workspaceId || !target?.writable}
                    onClick={() => { void install() }}
                  >
                    {action === 'install'
                      ? <Spinner className="mr-2" />
                      : <Download className="mr-2 size-4" />}
                    {t('creatorSkills.install.action')}
                  </Button>
                  {progress?.cancellable && operationId ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => { void window.electronAPI.creatorSkillCancel(operationId) }}
                    >
                      {t('common.cancel')}
                    </Button>
                  ) : null}
                  {progress ? (
                    <span className="text-xs text-muted-foreground">
                      {t(`creatorSkills.stage.${progress.stage}`)} · {progress.percent}%
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}

            {canManage && !draftVersion ? (
              <div className="space-y-3 rounded-xl border border-border/60 p-4">
                <h3 className="text-sm font-medium">{t('creatorSkills.version.create')}</h3>
                <div className="grid gap-3 sm:grid-cols-[140px_minmax(0,1fr)]">
                  <div>
                    <Label htmlFor="creator-skill-version">{t('creatorSkills.version.number')}</Label>
                    <Input
                      id="creator-skill-version"
                      className="mt-1.5"
                      value={version}
                      onChange={event => setVersion(event.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="creator-skill-changelog">{t('creatorSkills.version.changelog')}</Label>
                    <Input
                      id="creator-skill-changelog"
                      className="mt-1.5"
                      value={changelog}
                      maxLength={2_000}
                      onChange={event => setChangelog(event.target.value)}
                    />
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={action !== null || !version.trim()}
                  onClick={() => { void createVersion() }}
                >
                  {action === 'create-version' ? <Spinner className="mr-1.5" /> : null}
                  {t('creatorSkills.version.create')}
                </Button>
              </div>
            ) : null}

            {canManage && draftVersion ? (
              <div className="space-y-3 rounded-xl border border-border/60 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium">
                      {t('creatorSkills.version.draft', { version: draftVersion.version })}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(`creatorSkills.status.${draftVersion.status}`)}
                    </p>
                  </div>
                  {draftVersion.status === 'validated' ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={action !== null}
                      onClick={() => { void publishVersion() }}
                    >
                      {action === 'publish' ? <Spinner className="mr-1.5" /> : <CheckCircle2 className="mr-1.5 size-3.5" />}
                      {t('creatorSkills.version.publish')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={action !== null}
                    onClick={() => { void deleteVersionDraft() }}
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </div>
                {draftVersion.status !== 'validated' ? (
                  <div className="flex items-center gap-2">
                    <label className="inline-flex cursor-pointer items-center rounded-lg border border-border/60 px-3 py-2 text-sm hover:bg-foreground/[0.04]">
                      {action === 'upload' ? <Spinner className="mr-2" /> : <Upload className="mr-2 size-4" />}
                      {t('creatorSkills.version.chooseZip')}
                      <input
                        type="file"
                        accept=".zip,application/zip"
                        className="hidden"
                        disabled={action !== null}
                        onChange={event => {
                          const file = event.target.files?.[0]
                          if (file) void uploadArchive(file)
                          event.target.value = ''
                        }}
                      />
                    </label>
                    {action === 'upload' && uploadOperationId ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void window.electronAPI.creatorArtifactCancelUpload(uploadOperationId)
                        }}
                      >
                        {t('common.cancel')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {issues.length > 0 ? (
              <div className="space-y-2">
                {issues.map((item, index) => (
                  <div
                    key={`${item.code}-${item.path}-${index}`}
                    className={[
                      'flex gap-2 rounded-lg border px-3 py-2 text-xs',
                      item.severity === 'error'
                        ? 'border-destructive/20 bg-destructive/5 text-destructive'
                        : 'border-amber-500/20 bg-amber-500/5 text-amber-700',
                    ].join(' ')}
                  >
                    {item.severity === 'error'
                      ? <XCircle className="mt-0.5 size-3.5 shrink-0" />
                      : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
                    <span>
                      <strong>{item.path || 'ZIP'}</strong>
                      {item.field ? ` · ${item.field}` : ''}
                      {' — '}
                      {item.message}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {selectedVersion?.metadata ? (
              <div className="grid gap-2 text-xs sm:grid-cols-2">
                <MetadataRow label={t('creatorSkills.metadata.requiredSources')} value={selectedVersion.metadata.requiredSources} />
                <MetadataRow label={t('creatorSkills.metadata.alwaysAllow')} value={selectedVersion.metadata.alwaysAllow} />
                <MetadataRow label={t('creatorSkills.metadata.publisher')} value={selectedVersion.publishedByUserId} />
                <MetadataRow label={t('creatorSkills.metadata.publishedAt')} value={selectedVersion.publishedAt} />
              </div>
            ) : null}

            {detail.skillContent ? (
              <details className="rounded-xl border border-border/60">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                  SKILL.md
                </summary>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border/60 p-4 text-xs">
                  {detail.skillContent}
                </pre>
              </details>
            ) : null}

            {detail.fileTree?.length ? (
              <details className="rounded-xl border border-border/60">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                  {t('creatorSkills.files.title', { count: detail.fileTree.length })}
                </summary>
                <div className="max-h-56 overflow-auto border-t border-border/60 p-3 font-mono text-xs">
                  {detail.fileTree.map(file => (
                    <p key={file.path} className="flex justify-between gap-3 py-1">
                      <span className="truncate">{file.path}</span>
                      <span className="shrink-0 text-muted-foreground">{file.size} B</span>
                    </p>
                  ))}
                </div>
              </details>
            ) : null}

            {canManage ? detail.versions
              .filter(item => item.status === 'published')
              .map(item => (
                <div key={item.id} className="flex items-center gap-2 rounded-lg border border-border/60 p-3">
                  <ShieldAlert className="size-4 text-muted-foreground" />
                  <span className="text-sm">{item.version}</span>
                  <Input
                    className="ml-auto max-w-64"
                    value={revokeReason}
                    placeholder={t('creatorSkills.version.revokeReason')}
                    onChange={event => setRevokeReason(event.target.value)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={action !== null || !revokeReason.trim()}
                    onClick={() => { void revokeVersion(item) }}
                  >
                    {t('creatorSkills.version.revoke')}
                  </Button>
                </div>
              )) : null}

            {error ? (
              <div className="whitespace-pre-wrap rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}

function MetadataRow({
  label,
  value,
}: {
  label: string
  value?: string | string[]
}) {
  if (!value || (Array.isArray(value) && value.length === 0)) return null
  return (
    <div className="rounded-lg bg-foreground/[0.035] p-3">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 break-all">{Array.isArray(value) ? value.join(', ') : value}</p>
    </div>
  )
}
