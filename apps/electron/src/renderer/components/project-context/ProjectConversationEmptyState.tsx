import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ProjectContextTabs, type ProjectContextTab } from '@/components/project-context/ProjectContextTabs'
import { ProjectFileLibrary } from '@/components/project-context/ProjectFileLibrary'
import { ProjectPinPane } from '@/components/project-context/ProjectPinPane'
import {
  ProjectMembersEntryLabel,
  ProjectMembersPanel,
} from '@/components/project-context/ProjectMembersPanel'
import { useProjectMembersPanelHost } from '@/components/project-context/useProjectMembersPanelHost'
import { useCollaborationRoster } from '@/components/project-context/useCollaborationRoster'
import { FreeFormInput } from '@/components/app-shell/input/FreeFormInput'
import { useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { readProjectPurpose } from '@/lib/project-directory'
import { createEnterpriseWorkflowUrl } from '@/lib/enterprise-workflow-url'
import type { ClientMemberRole } from '@polo-ai/shared/admin/client-enterprise-contract'
import type { FileAttachment } from '../../../shared/types'
import type { WebElementReference } from '@polo-ai/core/types'
import type { ProjectAssetMentionDraft } from '@/atoms/project-context'

/**
 * POO-196 R3 (adjudication D14) — the project conversation empty state.
 *
 * Entering a project with no account history lands here instead of the
 * generic "no session selected" panel: a REAL conversation layout (header,
 * 消息/文件/Pin tabs, members entry and the trusted composer) that lets the
 * user start talking. Entering stays zero-write — the session is created
 * ONLY by the user's first explicit send through the trusted
 * onCreateSession→onSendMessage path, and only after the created session's
 * committed scope re-matches this project (never a blind send into an
 * unverified scope). Drafts persist per account+project in memory so a
 * failed create keeps everything the user typed.
 *
 * The members entry mounts the SAME panel host as ChatPage (P9: one members
 * surface, no second dialog).
 */

interface ScopeDraft {
  input: string
  attachments: FileAttachment[]
  elementReferences: WebElementReference[]
  projectAssetRefs: ProjectAssetMentionDraft[]
}

const scopeDrafts = new Map<string, ScopeDraft>()

function readScopeDraft(key: string): ScopeDraft {
  const existing = scopeDrafts.get(key)
  if (existing) return existing
  const fresh: ScopeDraft = { input: '', attachments: [], elementReferences: [], projectAssetRefs: [] }
  scopeDrafts.set(key, fresh)
  return fresh
}

export interface ProjectConversationEmptyStateProps {
  accountId: string
  workspaceId: string
  productSpaceId: string
  projectName: string
  viewerRole: ClientMemberRole
  enterpriseId: string
}

export function ProjectConversationEmptyState({
  accountId,
  workspaceId,
  productSpaceId,
  projectName,
  viewerRole,
  enterpriseId,
}: ProjectConversationEmptyStateProps) {
  const { t } = useTranslation()
  const { onCreateSession, onSendMessage, filePreview, filePreviewVisible } = useAppShellContext()
  const [projectTab, setProjectTab] = useState<ProjectContextTab>('messages')
  const draftKey = `${accountId}:${productSpaceId}`
  const draft = readScopeDraft(draftKey)
  const submittingRef = useRef(false)

  // The panel host (push/drawer + suspension) and the P9 entry roster — the
  // empty state has no session, so no tool pane can occupy the right column.
  const laneRef = useRef<HTMLDivElement | null>(null)
  const membersTriggerRef = useRef<HTMLButtonElement | null>(null)
  const membersPanelHost = useProjectMembersPanelHost({
    enabled: true,
    laneRef,
    toolPaneOccupied: Boolean(filePreview && filePreviewVisible),
    triggerRef: membersTriggerRef,
  })
  const membersRoster = useCollaborationRoster({ accountId, productSpaceId })

  const handleInputChange = useCallback((value: string) => {
    draft.input = value
  }, [draft])

  const handleAttachmentsChange = useCallback((attachments: FileAttachment[]) => {
    draft.attachments = attachments
  }, [draft])

  const handleElementReferencesChange = useCallback((references: WebElementReference[]) => {
    draft.elementReferences = references
  }, [draft])

  const handleProjectAssetRefsChange = useCallback((references: ProjectAssetMentionDraft[]) => {
    draft.projectAssetRefs = references
  }, [draft])

  const handleFirstSend = useCallback((
    message: string,
    attachments?: FileAttachment[],
    skillSlugs?: string[],
    kbOptions?: { kbCollectionIds?: string[] },
    elementReferences?: WebElementReference[],
    projectAssetRefs?: ProjectAssetMentionDraft[],
  ) => {
    // Single-submit lock: a double click or Enter repeat must never mint two
    // sessions for one message (D14 first-send discipline).
    if (submittingRef.current) return
    submittingRef.current = true
    void (async () => {
      try {
        // P12-5: the created session carries THIS project's authoritative
        // context metadata (title + cached introduction) so every model
        // request of the session speaks with the project's context.
        const session = await onCreateSession(workspaceId, {
          projectContext: {
            name: projectName,
            purpose: readProjectPurpose(accountId, productSpaceId),
          },
        })
        // Scope fence (D14): the created session's immutable bindings must
        // match THIS project before anything is sent into it.
        if (session.productSpaceId !== productSpaceId || (session.accountId && session.accountId !== accountId)) {
          toast.error(t('project.entry.scopeChanged'))
          return
        }
        // Hand the conversation to the real ChatPage, then deliver the
        // first message through the trusted send path (the deep-link flow's
        // short delay lets the panel mount and register the session).
        navigate(routes.view.allSessions(session.id))
        window.setTimeout(() => {
          onSendMessage(
            session.id,
            message,
            attachments,
            skillSlugs,
            undefined,
            kbOptions?.kbCollectionIds,
            elementReferences,
            projectAssetRefs,
          )
        }, 100)
        // The draft's purpose is served; start the project conversation clean.
        scopeDrafts.delete(draftKey)
      } catch {
        // Create failed: keep every draft byte and let the user retry —
        // no session row was created on this path's failures.
        toast.error(t('project.entry.historyFailed'))
      } finally {
        submittingRef.current = false
      }
    })()
  }, [accountId, draftKey, onCreateSession, onSendMessage, productSpaceId, t, workspaceId])

  // D-C handoff semantics (same fail-closed click-time checks ChatPage uses):
  // the desktop Bearer never rides the URL and a stale admin session fails
  // visibly instead of opening a half-authenticated management page.
  const handleOpenEnterpriseManagement = useCallback(async () => {
    if (viewerRole !== 'owner' && viewerRole !== 'manager') return
    try {
      const status = await window.electronAPI.adminGetStatus()
      if (!status.loggedIn || !status.adminUrl || status.userId !== accountId) {
        toast.error(t('topbar.account.enterpriseOpenFailed'), { description: t('homeApps.errors.staleContext') })
        return
      }
      await window.electronAPI.openUrl(
        createEnterpriseWorkflowUrl(status.adminUrl, enterpriseId, 'members'),
      )
    } catch {
      toast.error(t('topbar.account.enterpriseOpenFailed'))
    }
  }, [accountId, enterpriseId, t, viewerRole])

  const projectAssetMention = useMemo(() => ({
    search: (q: string) => window.electronAPI.pcSearchAssets({
      workspaceId,
      productSpaceId,
      q,
      limit: 20,
    }),
  }), [productSpaceId, workspaceId])

  const projectPaneVisible = projectTab !== 'messages'
  const projectPaneKey = `${accountId}:${productSpaceId}`

  return (
    // The chat lane (D8 measurement node) — same contract as ChatPage.
    <div ref={laneRef} className="h-full flex min-h-0 min-w-0">
      <div className="h-full flex min-h-0 min-w-0 flex-1 flex-col" data-testid="project-entry-empty">
        <PanelHeader
          title={projectName}
          actions={(
            <button
              type="button"
              ref={membersTriggerRef}
              data-testid="pc-members-button"
              aria-label={t('projectMembers.buttonAria')}
              aria-haspopup="dialog"
              aria-expanded={membersPanelHost.open}
              onClick={membersPanelHost.openPanel}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] border border-transparent px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-foreground-5 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              <ProjectMembersEntryLabel roster={membersRoster} />
            </button>
          )}
        />
        <ProjectContextTabs
          value={projectTab}
          onValueChange={setProjectTab}
        />
        <div className={projectPaneVisible ? 'hidden' : 'flex flex-1 flex-col items-center justify-center gap-2 px-6'}>
          <h2 className="m-0 text-[18px] font-bold tracking-[-0.02em]">{t('project.entry.emptyTitle')}</h2>
          <p className="m-0 max-w-[460px] text-center text-[13px] leading-[1.6] text-muted-foreground">
            {t('project.entry.emptyHint')}
          </p>
          <div className="mt-4 w-full max-w-[720px]">
            <FreeFormInput
              placeholder={t('project.entry.emptyHint')}
              onSubmit={handleFirstSend}
              currentModel=""
              inputValue={draft.input}
              onInputChange={handleInputChange}
              attachmentsValue={draft.attachments}
              onAttachmentsChange={handleAttachmentsChange}
              elementReferencesValue={draft.elementReferences}
              onElementReferencesChange={handleElementReferencesChange}
              projectAssetMention={projectAssetMention}
              projectAssetRefsValue={draft.projectAssetRefs}
              onProjectAssetRefsChange={handleProjectAssetRefsChange}
              disabled={submittingRef.current}
            />
          </div>
        </div>
        {projectPaneVisible && (
          <>
            <div className={projectTab === 'files' ? 'flex-1 flex flex-col min-h-0' : 'hidden'}>
              <ProjectFileLibrary
                key={projectPaneKey}
                scope={{ workspaceId, productSpaceId }}
                currentUserId={accountId}
                active={projectTab === 'files'}
                pinMutations={0}
              />
            </div>
            <div className={projectTab !== 'files' ? 'flex-1 flex flex-col min-h-0' : 'hidden'}>
              <ProjectPinPane
                key={projectPaneKey}
                scope={{ workspaceId, productSpaceId }}
                active={projectTab !== 'files'}
                onChanged={() => {}}
              />
            </div>
          </>
        )}
      </div>
      <ProjectMembersPanel
        open={membersPanelHost.open}
        mode={membersPanelHost.mode}
        scope={{ accountId, productSpaceId }}
        projectName={projectName}
        viewerRole={viewerRole}
        assertedEnterpriseId={enterpriseId}
        roster={membersRoster}
        onClose={membersPanelHost.closePanel}
        onOpenEnterpriseManagement={() => { void handleOpenEnterpriseManagement() }}
      />
    </div>
  )
}
