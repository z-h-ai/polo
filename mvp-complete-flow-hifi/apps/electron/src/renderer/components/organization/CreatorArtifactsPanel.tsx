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
import { zipSync } from 'fflate'
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
import { creatorSkillConflictConfirmation } from '@/lib/creator-skill-conflicts'
import {
  creatorSkillErrorDiagnostic,
  translateCreatorSkillError,
} from '@/lib/creator-skill-errors'
import { translateCreatorSkillValidationIssue } from '@/lib/creator-skill-validation-issues'
import { compareStableCreatorSkillVersion } from '@/lib/creator-skill-version'
import type { CreatorAppPublishMode } from '@polo-ai/shared/admin'
import {
  CreatorSkillUploadError,
  prepareCreatorSkillUploadFile,
  uploadCreatorSkillArchive,
} from '@/lib/creator-skill-upload'
import type {
  CreatorArtifact,
  CreatorArtifactDetail,
  CreatorArtifactVersion,
  CreatorSkillOperationProgress,
  SkillValidationIssue,
} from '../../../shared/types'

interface CreatorArtifactsPanelProps {
  organizationId: string
  canManage: boolean
  workspaceId: string | null
  sessionId: string | null
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
  return translateCreatorSkillError(t, result)
}

export function CreatorArtifactsPanel({
  organizationId,
  canManage,
  workspaceId,
  sessionId,
}: CreatorArtifactsPanelProps) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [artifacts, setArtifacts] = useState<CreatorArtifact[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CreatorArtifactDetail | null>(null)
  const [versionDetails, setVersionDetails] = useState<
    Record<string, CreatorArtifactDetail>
  >({})
  const [versionDetailLoading, setVersionDetailLoading] = useState<string | null>(null)
  const [referencePreview, setReferencePreview] = useState<{
    path: string
    content?: string
    downloadUrl?: string
  } | null>(null)
  const [referenceLoading, setReferenceLoading] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [action, setAction] = useState<ActionState>(null)
  const [error, setError] = useState<string | null>(null)
  const [issues, setIssues] = useState<SkillValidationIssue[]>([])
  const [newArtifactType, setNewArtifactType] = useState<'web_app' | 'skill' | null>(null)
  const [webAppPublishMode, setWebAppPublishMode] = useState<CreatorAppPublishMode | null>(null)
  const [webAppName, setWebAppName] = useState('')
  const [webAppUrl, setWebAppUrl] = useState('')
  const [webAppFile, setWebAppFile] = useState<File | null>(null)
  const [webAppFiles, setWebAppFiles] = useState<File[]>([])
  const [webAppEntryCandidates, setWebAppEntryCandidates] = useState<Array<{ runtime: 'static' | 'python' | 'js'; path: string }>>([])
  const [webAppSelectedEntry, setWebAppSelectedEntry] = useState<{ runtime: 'static' | 'python' | 'js'; path: string } | null>(null)
  const [slug, setSlug] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [changelog, setChangelog] = useState('')
  const [draftVersionId, setDraftVersionId] = useState<string | null>(null)
  const [installVersion, setInstallVersion] = useState('')
  const [progress, setProgress] = useState<CreatorSkillOperationProgress | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [uploadOperationId, setUploadOperationId] = useState<string | null>(null)
  const uploadAbortControllerRef = useRef<AbortController | null>(null)
  const [target, setTarget] = useState<{
    name: string
    path: string
    writable: boolean
  } | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const requestGeneration = useRef(0)
  const detailRequestGeneration = useRef(0)
  const referenceRequestGeneration = useRef(0)
  const detailInFlightRef = useRef<{
    key: string
    generation: number
    request: Promise<void>
  } | null>(null)
  const selectedIdRef = useRef(selectedId)
  const organizationIdRef = useRef(organizationId)
  const detailArtifactIdRef = useRef(detail?.artifact.id ?? null)
  const installVersionRef = useRef(installVersion)
  selectedIdRef.current = selectedId
  organizationIdRef.current = organizationId
  detailArtifactIdRef.current = detail?.artifact.id ?? null
  installVersionRef.current = installVersion

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
      setNextCursor(result.nextCursor ?? null)
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

  const loadMoreArtifacts = useCallback(async () => {
    const cursor = nextCursor
    if (!cursor || loadingMore) return
    const generation = requestGeneration.current
    setLoadingMore(true)
    try {
      const capability = await window.electronAPI.creatorArtifactGetCapabilities()
      if (!capability.success || generation !== requestGeneration.current) return
      const result = await window.electronAPI.creatorArtifactList({
        organizationId,
        ...(!capability.creatorSkillArtifacts ? { type: 'web_app' as const } : {}),
        includeDrafts: canManage,
        cursor,
      })
      if (!result.success || generation !== requestGeneration.current) return
      setArtifacts(current => {
        const known = new Set(current.map(item => item.id))
        return [...current, ...result.artifacts.filter(item => !known.has(item.id))]
      })
      setNextCursor(result.nextCursor ?? null)
    } catch (caught) {
      if (generation === requestGeneration.current) {
        emitAdminAuthFailure(caught && typeof caught === 'object' ? caught as { code?: string; errorCode?: string; status?: number } : {})
        setError(t('creatorSkills.errors.unknown'))
      }
    } finally {
      if (generation === requestGeneration.current) setLoadingMore(false)
    }
  }, [canManage, loadingMore, nextCursor, organizationId, t])

  const loadDetail = useCallback((artifactId: string): Promise<void> => {
    const requestedOrganizationId = organizationId
    if (
      organizationIdRef.current !== requestedOrganizationId
      || selectedIdRef.current !== artifactId
    ) return Promise.resolve()
    const requestKey = `${requestedOrganizationId}\0${artifactId}`
    const existing = detailInFlightRef.current
    if (
      existing?.key === requestKey
      && existing.generation === detailRequestGeneration.current
    ) return existing.request

    const generation = ++detailRequestGeneration.current
    const request = (async () => {
      referenceRequestGeneration.current += 1
      setReferencePreview(null)
      setReferenceLoading(null)
      const isCurrentRequest = () => (
        generation === detailRequestGeneration.current
        && organizationIdRef.current === requestedOrganizationId
        && selectedIdRef.current === artifactId
      )
      setDetailLoading(true)
      setDetail(current => current?.artifact.id === artifactId ? current : null)
      setError(null)
      try {
        const result = await window.electronAPI.creatorArtifactGet({
          organizationId: requestedOrganizationId,
          artifactId,
        })
        if (!isCurrentRequest()) return
        if (!result.success) {
          setDetail(null)
          setError(resultMessage(t, result))
          return
        }
        if (
          result.artifact.id !== artifactId
          || result.artifact.organizationId !== requestedOrganizationId
        ) {
          setDetail(null)
          setError(t('creatorSkills.errors.unknown'))
          return
        }
        setDetail({
          artifact: result.artifact,
          versions: result.versions,
          selectedVersion: result.selectedVersion,
          skillContent: result.skillContent,
          fileTree: result.fileTree,
          reference: result.reference,
        })
        setVersionDetails({})
        const published = result.versions
          .filter(item => item.status === 'published')
          .sort((left, right) => (
            compareStableCreatorSkillVersion(right.version, left.version)
          ))
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
        if (!isCurrentRequest()) return
        emitAdminAuthFailure(
          caught && typeof caught === 'object'
            ? caught as { code?: string; errorCode?: string; status?: number }
            : {},
        )
        setDetail(null)
        setError(t('creatorSkills.errors.unknown'))
      } finally {
        if (isCurrentRequest()) setDetailLoading(false)
      }
    })()
    detailInFlightRef.current = { key: requestKey, generation, request }
    void request.finally(() => {
      if (detailInFlightRef.current?.request === request) {
        detailInFlightRef.current = null
      }
    })
    return request
  }, [organizationId, t])

  useEffect(() => {
    if (!detail || !installVersion) return
    const artifactId = detail.artifact.id
    const key = `${artifactId}\0${installVersion}`
    if (versionDetails[key]) return
    let active = true
    setVersionDetailLoading(key)
    window.electronAPI.creatorArtifactGet({
      organizationId,
      artifactId,
      version: installVersion,
    }).then(result => {
      if (!active) return
      if (!result.success) {
        setError(resultMessage(t, result))
        return
      }
      setVersionDetails(current => ({
        ...current,
        [key]: {
          artifact: result.artifact,
          versions: result.versions,
          selectedVersion: result.selectedVersion ?? installVersion,
          skillContent: result.skillContent,
          fileTree: result.fileTree,
          reference: result.reference,
        },
      }))
    }).catch(() => {
      if (active) setError(t('creatorSkills.errors.unknown'))
    }).finally(() => {
      if (active) setVersionDetailLoading(current => current === key ? null : current)
    })
    return () => {
      active = false
    }
  }, [detail, installVersion, organizationId, t, versionDetails])

  useEffect(() => {
    void loadArtifacts()
    return () => {
      requestGeneration.current += 1
    }
  }, [loadArtifacts])

  useEffect(() => () => {
    uploadAbortControllerRef.current?.abort()
  }, [])

  useEffect(() => {
    const selected = artifacts.find(item => item.id === selectedId)
    if (
      selected?.type === 'skill'
      && selected.organizationId === organizationId
    ) {
      void loadDetail(selected.id)
    } else {
      detailRequestGeneration.current += 1
      setDetail(null)
      setDetailLoading(false)
    }
    return () => {
      detailRequestGeneration.current += 1
    }
  }, [artifacts, loadDetail, organizationId, selectedId])

  useEffect(() => {
    referenceRequestGeneration.current += 1
    setReferencePreview(null)
    setReferenceLoading(null)
  }, [installVersion, organizationId, selectedId])

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

  const pollingArtifactId = detail?.versions.some(item => (
      item.id === draftVersionId
      && (item.status === 'uploaded' || item.status === 'validating')
    ))
    ? detail.artifact.id
    : null

  useEffect(() => {
    if (!pollingArtifactId) return
    let active = true
    let timer: number | undefined
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (!active) return
        void loadDetail(pollingArtifactId).finally(() => {
          if (active) schedule()
        })
      }, 2_000)
    }
    schedule()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [loadDetail, pollingArtifactId])

  const selectedVersion = useMemo(
    () => {
      if (!detail) return undefined
      const key = `${detail.artifact.id}\0${installVersion}`
      return versionDetails[key]?.versions.find(item => item.version === installVersion)
        ?? detail.versions.find(item => item.version === installVersion)
    },
    [detail, installVersion, versionDetails],
  )
  const selectedVersionDetail = useMemo(() => (
    detail ? versionDetails[`${detail.artifact.id}\0${installVersion}`] : undefined
  ), [detail, installVersion, versionDetails])
  const draftVersion = useMemo(
    () => detail?.versions.find(item => item.id === draftVersionId),
    [detail, draftVersionId],
  )
  const selectedArtifact = useMemo(
    () => artifacts.find(item => item.id === selectedId) ?? null,
    [artifacts, selectedId],
  )

  const openWebAppManagement = async (publishMode?: CreatorAppPublishMode) => {
    setAction('open-web-app')
    setError(null)
    try {
      const status = await window.electronAPI.adminGetStatus()
      if (!status.adminUrl) {
        setError(t('creatorSkills.errors.webAppManagementUnavailable'))
        return
      }
      const managementUrl = publishMode
        ? new URL('/organization-apps/publish', status.adminUrl)
        : new URL('/organization-apps', status.adminUrl)
      managementUrl.searchParams.set('organizationId', organizationId)
      if (publishMode) managementUrl.searchParams.set('mode', publishMode)
      if (publishMode) {
        managementUrl.searchParams.set('name', webAppName.trim())
        managementUrl.searchParams.set('visibility', 'all_members')
      }
      if (publishMode === 'website') {
        const websiteUrl = new URL(webAppUrl.trim())
        if (websiteUrl.protocol !== 'https:') {
          setError(t('creatorSkills.errors.webAppHttpsRequired'))
          return
        }
        managementUrl.searchParams.set('websiteUrl', websiteUrl.toString())
      }
      if (publishMode === 'upload' && webAppFile) {
        managementUrl.searchParams.set('payloadName', webAppFile.name)
      }
      await window.electronAPI.openUrl(managementUrl.toString())
    } catch {
      setError(t('creatorSkills.errors.webAppManagementUnavailable'))
    } finally {
      setAction(null)
    }
  }

  const publishWebApp = async (entryOverride?: { runtime: 'static' | 'python' | 'js'; path: string }) => {
    if (!webAppPublishMode || !webAppName.trim()) return
    setAction('open-web-app')
    setError(null)
    try {
      if (webAppPublishMode === 'website') {
        const websiteUrl = new URL(webAppUrl.trim())
        if (websiteUrl.protocol !== 'https:') {
          setError(t('creatorSkills.errors.webAppHttpsRequired'))
          return
        }
        const result = await window.electronAPI.creatorAppPublish({
          organizationId,
          name: webAppName.trim(),
          visibility: 'all_members',
          mode: 'website',
          websiteUrl: websiteUrl.toString(),
        })
        if (!result.success) {
          setError(resultMessage(t, result))
          return
        }
      } else {
        const files = webAppFiles.length > 0 ? webAppFiles : webAppFile ? [webAppFile] : []
        if (files.length === 0) return
        const payload = files.length === 1 && files[0]!.name.toLowerCase().endsWith('.zip')
          ? new Uint8Array(await files[0]!.arrayBuffer())
          : zipSync(Object.fromEntries(await Promise.all(files.map(async file => [
              file.webkitRelativePath || file.name,
              new Uint8Array(await file.arrayBuffer()),
            ]))), { level: 9 })
        let binary = ''
        for (let offset = 0; offset < payload.length; offset += 0x8000) {
          binary += String.fromCharCode(...payload.subarray(offset, offset + 0x8000))
        }
        const selectedEntry = entryOverride ?? webAppSelectedEntry
        const result = await window.electronAPI.creatorAppPublish({
          organizationId,
          name: webAppName.trim(),
          visibility: 'all_members',
          mode: 'upload',
          payloadBase64: btoa(binary),
          ...(selectedEntry ? { selectedEntry } : {}),
        })
        if (!result.success) {
          setError(resultMessage(t, result))
          return
        }
        if ('status' in result && result.status === 'needs_entry_selection') {
          setWebAppEntryCandidates(result.candidates)
          return
        }
      }
      setWebAppPublishMode(null)
      setWebAppName('')
      setWebAppUrl('')
      setWebAppFile(null)
      setWebAppFiles([])
      setWebAppEntryCandidates([])
      setWebAppSelectedEntry(null)
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
    if (!detail || !draftVersionId || !draftVersion) return
    setAction('upload')
    const nextUploadOperationId = crypto.randomUUID()
    setUploadOperationId(nextUploadOperationId)
    const controller = new AbortController()
    uploadAbortControllerRef.current = controller
    setError(null)
    setIssues([])
    try {
      const prepared = await prepareCreatorSkillUploadFile(file, detail.artifact.slug, {
        signal: controller.signal,
      })
      const granted = await window.electronAPI.creatorArtifactCreateUploadGrant({
        organizationId,
        artifactId: detail.artifact.id,
        version: draftVersion.version,
        sizeBytes: prepared.sizeBytes,
        archiveChecksum: prepared.archiveChecksum,
        idempotencyKey: idempotencyKey('version-upload-grant'),
      })
      if (!granted.success) {
        setError(resultMessage(t, granted))
        return
      }
      const uploadGrant = granted.grant
      const uploaded = await uploadCreatorSkillArchive(file, uploadGrant, prepared, {
        signal: controller.signal,
      })
      const result = await window.electronAPI.creatorArtifactCompleteUpload({
        organizationId,
        artifactId: detail.artifact.id,
        version: draftVersion.version,
        uploadGeneration: uploadGrant.uploadGeneration,
        sizeBytes: uploaded.sizeBytes,
        archiveChecksum: uploaded.archiveChecksum,
        idempotencyKey: idempotencyKey('version-upload-complete'),
      })
      if (!result.success) {
        setIssues(result.validationIssues ?? [])
        setError(resultMessage(t, result))
        return
      }
      await loadDetail(detail.artifact.id)
    } catch (caught) {
      if (caught instanceof CreatorSkillUploadError) {
        setError(resultMessage(t, { errorCode: caught.errorCode }))
      } else {
        setError(t('creatorSkills.errors.unknown'))
      }
    } finally {
      if (uploadAbortControllerRef.current === controller) uploadAbortControllerRef.current = null
      setAction(null)
      setUploadOperationId(null)
    }
  }

  const publishVersion = async () => {
    if (!detail || !draftVersionId || !draftVersion) return
    setAction('publish')
    setError(null)
    try {
      const result = await window.electronAPI.creatorArtifactPublishVersion({
        organizationId,
        artifactId: detail.artifact.id,
        version: draftVersion.version,
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
    if (!detail || !draftVersionId || !draftVersion) return
    if (!window.confirm(t('creatorSkills.version.confirmDelete'))) return
    setAction('delete')
    setError(null)
    try {
      const result = await window.electronAPI.creatorArtifactDeleteVersionDraft({
        organizationId,
        artifactId: detail.artifact.id,
        version: draftVersion.version,
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

  const install = async (confirmations?: {
    replaceExisting?: boolean
    confirmGlobalOverride?: boolean
    backupLocalChanges?: boolean
  }) => {
    if (
      !detail
      || !workspaceId
      || !sessionId
      || !selectedVersion
      || !selectedVersionDetail
      || !target?.writable
    ) return
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
        const accepted = window.confirm(creatorSkillConflictConfirmation(t, {
          conflicts: result.conflicts,
          conflictDetails: result.conflictDetails,
        }))
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
        const diagnostic = creatorSkillErrorDiagnostic(result)
        setError([resultMessage(t, result), diagnostic].filter(Boolean).join('\n'))
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

  const previewReference = async (path: string) => {
    if (!detail || !installVersion || !path.startsWith('references/')) return
    const requested = {
      organizationId,
      artifactId: detail.artifact.id,
      version: installVersion,
      path,
    }
    const generation = ++referenceRequestGeneration.current
    const isCurrentRequest = () => (
      generation === referenceRequestGeneration.current
      && organizationIdRef.current === requested.organizationId
      && selectedIdRef.current === requested.artifactId
      && detailArtifactIdRef.current === requested.artifactId
      && installVersionRef.current === requested.version
    )
    setReferenceLoading(path)
    setError(null)
    try {
      const result = await window.electronAPI.creatorArtifactGet({
        organizationId: requested.organizationId,
        artifactId: requested.artifactId,
        version: requested.version,
        referencePath: requested.path,
      })
      if (!isCurrentRequest()) return
      if (!result.success) {
        setError(resultMessage(t, result))
        return
      }
      if (
        result.artifact.id !== requested.artifactId
        || result.artifact.organizationId !== requested.organizationId
        || result.selectedVersion !== requested.version
        || !result.reference
        || result.reference.path !== requested.path
      ) {
        setError(t('creatorSkills.errors.reference_unavailable'))
        return
      }
      setReferencePreview(result.reference)
    } catch {
      if (isCurrentRequest()) {
        setError(t('creatorSkills.errors.reference_unavailable'))
      }
    } finally {
      if (isCurrentRequest()) setReferenceLoading(null)
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
        version: item.version,
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
              value={newArtifactType ?? ''}
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
                  placeholder={t('creatorSkills.artifact.slugPlaceholder')}
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
              <div
                data-testid="web-app-publishing-guide"
                className="space-y-3 rounded-lg bg-foreground/[0.035] p-3"
              >
                <div>
                  <p className="text-sm font-medium">
                    {t('creatorSkills.artifact.webAppGuide.title')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('creatorSkills.artifact.webAppGuide.description')}
                  </p>
                </div>
                <div className="space-y-2">
                  <button
                    type="button"
                    data-testid="web-app-publish-mode-website"
                    aria-pressed={webAppPublishMode === 'website'}
                    className="w-full rounded-lg border border-border/60 bg-background/60 p-2.5 text-left transition-colors hover:border-accent/60 aria-[pressed=true]:border-accent aria-[pressed=true]:bg-accent/5"
                    onClick={() => setWebAppPublishMode('website')}
                  >
                    <div className="flex items-center gap-2">
                      <Globe2 className="size-3.5 text-accent" />
                      <span className="text-xs font-medium">
                        {t('creatorSkills.artifact.webAppGuide.remoteTitle')}
                      </span>
                      <span className="ml-auto rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                        {t('creatorSkills.artifact.webAppGuide.recommended')}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      {t('creatorSkills.artifact.webAppGuide.remoteDescription')}
                    </p>
                  </button>
                  <button
                    type="button"
                    data-testid="web-app-publish-mode-upload"
                    aria-pressed={webAppPublishMode === 'upload'}
                    className="w-full rounded-lg border border-border/60 bg-background/60 p-2.5 text-left transition-colors hover:border-accent/60 aria-[pressed=true]:border-accent aria-[pressed=true]:bg-accent/5"
                    onClick={() => setWebAppPublishMode('upload')}
                  >
                    <div className="flex items-center gap-2">
                      <Upload className="size-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium">
                        {t('creatorSkills.artifact.webAppGuide.bundleTitle')}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      {t('creatorSkills.artifact.webAppGuide.bundleDescription')}
                    </p>
                  </button>
                </div>
                {webAppPublishMode ? (
                  <div className="space-y-2 rounded-lg border border-border/60 p-3">
                    <Label htmlFor="creator-web-app-name">
                      {t('creatorSkills.artifact.webAppGuide.name')}
                    </Label>
                    <Input
                      id="creator-web-app-name"
                      data-testid="creator-web-app-name"
                      maxLength={128}
                      value={webAppName}
                      onChange={event => setWebAppName(event.target.value)}
                    />
                    {webAppPublishMode === 'website' ? (
                      <>
                        <Label htmlFor="creator-web-app-url">
                          {t('creatorSkills.artifact.webAppGuide.url')}
                        </Label>
                        <Input
                          id="creator-web-app-url"
                          data-testid="creator-web-app-url"
                          type="url"
                          value={webAppUrl}
                          placeholder="https://app.example.com"
                          onChange={event => setWebAppUrl(event.target.value)}
                        />
                      </>
                    ) : (
                      <>
                        <Label htmlFor="creator-web-app-file">
                          {t('creatorSkills.artifact.webAppGuide.file')}
                        </Label>
                        <Input
                          id="creator-web-app-file"
                          data-testid="creator-web-app-file"
                          type="file"
                          accept=".zip,application/zip"
                          onChange={event => {
                            const files = Array.from(event.target.files ?? [])
                            setWebAppFiles(files)
                            setWebAppFile(files[0] ?? null)
                          }}
                        />
                        <Label htmlFor="creator-web-app-folder">
                          {t('creatorSkills.artifact.webAppGuide.file')}
                        </Label>
                        <Input
                          id="creator-web-app-folder"
                          data-testid="creator-web-app-folder"
                          type="file"
                          multiple
                          ref={node => node?.setAttribute('webkitdirectory', '')}
                          onChange={event => {
                            const files = Array.from(event.target.files ?? [])
                            setWebAppFiles(files)
                            setWebAppFile(files[0] ?? null)
                          }}
                        />
                      </>
                    )}
                    {webAppEntryCandidates.length > 0 ? (
                      <div data-testid="creator-web-app-entry-selection" className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          {t('creatorSkills.artifact.webAppGuide.entryPrompt')}
                        </p>
                        {webAppEntryCandidates.map(candidate => (
                          <Button key={`${candidate.runtime}:${candidate.path}`} type="button" size="sm" variant="outline"
                            onClick={() => { setWebAppSelectedEntry(candidate); void publishWebApp(candidate) }}>
                            {candidate.path}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      className="w-full"
                      disabled={
                        action !== null
                        || !webAppName.trim()
                        || (webAppPublishMode === 'website' ? !webAppUrl.trim() : !webAppFile)
                      }
                      onClick={() => { void publishWebApp() }}
                    >
                      {action === 'open-web-app'
                        ? <Spinner className="mr-1.5" />
                        : <Globe2 className="mr-1.5 size-3.5" />}
                      {t('creatorSkills.artifact.continueWebApp')}
                    </Button>
                  </div>
                ) : null}
              </div>
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
          {nextCursor ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 w-full"
              disabled={loadingMore}
              onClick={() => { void loadMoreArtifacts() }}
            >
              {loadingMore ? <Spinner className="mr-1.5" /> : null}
              {t('creatorSkills.artifacts.loadMore')}
            </Button>
          ) : null}
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
              <div
                role="alert"
                className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
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
                  <Select
                    value={installVersion}
                    onValueChange={value => {
                      referenceRequestGeneration.current += 1
                      setInstallVersion(value)
                      setReferencePreview(null)
                      setReferenceLoading(null)
                    }}
                  >
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
                    <p className="mt-1 font-mono">
                      {selectedVersion.contentDigest || '—'}
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
                {versionDetailLoading === `${detail.artifact.id}\0${installVersion}` ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Spinner />
                    {t('creatorSkills.version.loadingDetails')}
                  </div>
                ) : null}
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
                    disabled={
                      action !== null
                      || !workspaceId
                      || !sessionId
                      || !target?.writable
                      || !selectedVersionDetail
                    }
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
                          uploadAbortControllerRef.current?.abort()
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
                      <strong>
                        {item.path || t('creatorSkills.validation.archiveRoot')}
                      </strong>
                      {item.field ? ` · ${item.field}` : ''}
                      {' — '}
                      {translateCreatorSkillValidationIssue(t, item.code)}
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

            {selectedVersionDetail?.skillContent ? (
              <details className="rounded-xl border border-border/60">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                  SKILL.md
                </summary>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border/60 p-4 text-xs">
                  {selectedVersionDetail.skillContent}
                </pre>
              </details>
            ) : null}

            {selectedVersionDetail?.fileTree?.length ? (
              <details className="rounded-xl border border-border/60">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                  {t('creatorSkills.files.title', {
                    count: selectedVersionDetail.fileTree.length,
                  })}
                </summary>
                <div className="max-h-56 overflow-auto border-t border-border/60 p-3 font-mono text-xs">
                  {selectedVersionDetail.fileTree.map(file => (
                    <div key={file.path} className="flex items-center justify-between gap-3 py-1">
                      <span className="min-w-0 truncate">{file.path}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        {file.size} B
                      </span>
                      {file.path.startsWith('references/') ? (
                        <button
                          type="button"
                          disabled={referenceLoading !== null}
                          className="shrink-0 rounded px-2 py-0.5 text-accent hover:bg-accent/10 disabled:opacity-50"
                          onClick={() => { void previewReference(file.path) }}
                        >
                          {referenceLoading === file.path
                            ? t('creatorSkills.references.loading')
                            : t('creatorSkills.references.preview')}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </details>
            ) : null}

            {referencePreview ? (
              <section className="rounded-xl border border-border/60">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <h3 className="truncate text-sm font-medium">
                    {referencePreview.path}
                  </h3>
                  {referencePreview.downloadUrl ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void window.electronAPI.openUrl(referencePreview.downloadUrl!)
                      }}
                    >
                      <Download className="mr-1.5 size-3.5" />
                      {t('creatorSkills.references.download')}
                    </Button>
                  ) : null}
                </div>
                {referencePreview.content !== undefined ? (
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border/60 p-4 text-xs">
                    {referencePreview.content}
                  </pre>
                ) : (
                  <p className="border-t border-border/60 p-4 text-xs text-muted-foreground">
                    {t('creatorSkills.references.downloadOnly')}
                  </p>
                )}
              </section>
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
              <div
                role="alert"
                className="whitespace-pre-wrap rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
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
