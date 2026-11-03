import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, ChevronRight, Copy, ExternalLink, Loader2, UserPlus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  clientWorkbenchButtonClassName,
  clientWorkbenchDialogClassName,
  clientWorkbenchOverlayClassName,
  clientWorkbenchPrimaryClassName,
  useClientWorkbenchStyle,
} from '@/components/ui/client-workbench'
import { productSpaceAvatarGlyph } from '@/lib/space-initial'
import { cn } from '@/lib/utils'
import type { ClientMemberRole } from '@polo-ai/shared/admin/client-enterprise-contract'
import { useProjectMembers } from './useProjectMembers'

/**
 * POO-196 追加轮 project-members dialog (adjudication D-C / D-D 2-4).
 *
 * One project-level entry at the END of the project tab strip (a button, not
 * a fourth tab), opened identically from both ChatPage branches. The panel
 * renders by the VIEWER's space role:
 * - owner/manager: project name, active roster (read-only role badges),
 *   targeted-invitation records, the「邀请成员…」compose step INSIDE this
 *   dialog (never a stacked modal wizard), and the「前往企业管理」controlled
 *   external handoff.
 * - member: own role + "ask a project owner" note. NO management call is
 *   issued — the admin 403 stays the authority, and when it does arrive the
 *   panel clears instead of falling back to a previous cache.
 *
 * HIG: single primary action per step; Escape closes an uncommitted compose
 * step; the copy action requires a click and reports failure; the invitation
 * link lives only in memory for the result step.
 */

export interface ProjectMembersDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: { accountId: string; productSpaceId: string }
  projectName: string
  /** The space role from the ProductSpace summary — display shape only. */
  viewerRole: ClientMemberRole
  /** D-D 3: the controlled external enterprise-management handoff. */
  onOpenEnterpriseManagement: () => void
}

function roleBadgeClass(role: ClientMemberRole): string {
  return role === 'owner'
    ? 'bg-[var(--accent-soft)] text-accent'
    : role === 'manager'
      ? 'bg-foreground-5 text-foreground-60'
      : 'bg-foreground-5 text-foreground-60'
}

export function ProjectMembersDialog({
  open,
  onOpenChange,
  scope,
  projectName,
  viewerRole: spaceRole,
  onOpenEnterpriseManagement,
}: ProjectMembersDialogProps) {
  const { t } = useTranslation()
  const workbenchStyle = useClientWorkbenchStyle()
  const members = useProjectMembers({
    accountId: scope.accountId,
    productSpaceId: scope.productSpaceId,
    projectName,
    viewerRole: spaceRole,
  })

  // Every open re-enters the overview step: fresh data for managers, none
  // for a plain member.
  useEffect(() => {
    if (open) members.openOverview()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps -- openOverview identity changes with scope; the scope guard inside the hook resets state already.

  // Escape during compose OR the result page closes the UNCOMMITTED STEP
  // (back to the roster), not the whole dialog (HIG sheets: one related task
  // per sheet). Only the overview Esc actually dismisses the dialog.
  // X2-4: while an invitation submit is in flight, NO entry can dismiss the
  // compose step — a late response must never hijack the panel back to a
  // result page the user already walked away from (the hook also keeps a
  // generation guard for the entries that bypass this dialog-level block).
  const composeSubmitting = members.composeSubmitting
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next && members.step !== 'overview') {
      if (composeSubmitting) return
      if (members.step === 'compose') members.cancelCompose()
      else members.closeResult()
      return
    }
    onOpenChange(next)
  }, [composeSubmitting, members.step, members.cancelCompose, members.closeResult, onOpenChange])

  const rosterCount = members.roster.items.length

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid="project-members-dialog"
        data-step={members.step}
        data-viewer-role={members.viewerRole}
        style={workbenchStyle}
        overlayStyle={workbenchStyle}
        overlayClassName={clientWorkbenchOverlayClassName}
        className={clientWorkbenchDialogClassName}
        // X2-4: an in-flight invitation submit cannot be dismissed (Escape,
        // clicking outside, or the X) — the same discipline the upload dialog
        // applies while its form is writing.
        onEscapeKeyDown={event => { if (composeSubmitting) event.preventDefault() }}
        onInteractOutside={event => { if (composeSubmitting) event.preventDefault() }}
        showCloseButton={!composeSubmitting}
      >
        <DialogHeader>
          <DialogTitle data-testid="project-members-title">
            {members.step === 'compose'
              ? t('projectMembers.invite.title')
              : members.step === 'result'
                ? t('projectMembers.invite.successTitle')
                : t('projectMembers.title')}
          </DialogTitle>
          <DialogDescription>
            {members.step === 'compose'
              ? t('projectMembers.invite.description')
              : members.step === 'result'
                ? t('projectMembers.invite.successNote')
                : projectName}
          </DialogDescription>
        </DialogHeader>

        <div className="px-[20px] pb-[6px]">
          {members.step === 'overview' ? (
            members.viewerRole === 'member' ? (
              <div className="flex flex-col gap-[12px]" data-testid="project-members-member-surface">
                <div className="rounded-[10px] border border-border bg-foreground-5 px-[12px] py-[12px] text-[12px] leading-[1.55]">
                  <span className="block font-medium text-foreground" data-testid="project-members-your-role">
                    {t('projectMembers.member.yourRole', { role: t(members.roleKeyOf(members.viewerRole)) })}
                  </span>
                  <span className="mt-[4px] block text-muted-foreground" data-testid="project-members-contact-owner">
                    {t('projectMembers.member.contactOwner')}
                  </span>
                </div>
                {members.manageErrorKey ? (
                  <p
                    role="status"
                    className="text-[11px] leading-[1.45] text-destructive"
                    data-testid="project-members-manage-error"
                  >
                    {t(members.manageErrorKey)}
                  </p>
                ) : null}
                {/* X2-10: the roster/invitation description is manager-panel
                    content — a plain member sees only their own role and the
                    contact note, never a list they cannot read. */}
              </div>
            ) : (
              <div className="flex min-h-[220px] flex-col gap-[12px]" data-testid="project-members-manage-surface">
                <p className="text-[11px] leading-[1.45] text-foreground-50" data-testid="project-members-subtitle">
                  {t('projectMembers.subtitle')}
                </p>
                {members.manageErrorKey ? (
                  <div
                    role="status"
                    data-testid="project-members-manage-error"
                    className="flex items-start gap-[8px] rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
                  >
                    <AlertCircle className="mt-[2px] size-[14px] shrink-0" aria-hidden="true" />
                    <span>{t(members.manageErrorKey)}</span>
                  </div>
                ) : null}

                {/* Roster */}
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-foreground">{t('projectMembers.roster.heading')}</span>
                    {!members.roster.loading && !members.roster.errorKey ? (
                      <span className="text-[11px] text-foreground-50" data-testid="project-members-roster-count">
                        {t('projectMembers.roster.count', { count: rosterCount })}
                      </span>
                    ) : null}
                  </div>
                  {members.roster.loading ? (
                    <p className="mt-[8px] flex items-center gap-[6px] text-[12px] text-muted-foreground" data-testid="project-members-roster-loading">
                      <Loader2 className="size-[13px] shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      <span>{t('projectMembers.loadingMore')}</span>
                    </p>
                  ) : members.roster.errorKey ? (
                    <div className="mt-[8px] flex items-center gap-[10px]" data-testid="project-members-roster-error">
                      <p className="text-[12px] text-destructive">
                        {t(members.roster.errorKey)}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        className={clientWorkbenchButtonClassName}
                        data-testid="project-members-roster-retry"
                        onClick={members.retryRoster}
                      >
                        {t('projectMembers.retry')}
                      </Button>
                    </div>
                  ) : members.roster.items.length === 0 ? (
                    <p className="mt-[8px] text-[12px] text-muted-foreground" data-testid="project-members-roster-empty">
                      {t('projectMembers.roster.empty')}
                    </p>
                  ) : (
                    <ul className="mt-[6px] flex flex-col rounded-[10px] border border-border" data-testid="project-members-roster">
                      {members.roster.items.map(member => (
                        <li
                          key={member.membershipId}
                          data-testid="project-members-roster-row"
                          data-member-role={member.role}
                          className="flex items-center gap-[10px] border-b border-border px-[11px] py-[8px] last:border-b-0"
                        >
                          <span className="flex size-[24px] shrink-0 items-center justify-center rounded-[6px] bg-[var(--accent-soft)] text-[11px] font-semibold text-accent" aria-hidden="true">
                            {(() => {
                              const glyph = productSpaceAvatarGlyph(member.displayName || '?', 'enterprise')
                              return glyph.kind === 'letter' ? glyph.letter : t(glyph.key)
                            })()}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                            {member.displayName}
                          </span>
                          <span className={cn('shrink-0 rounded-full px-[7px] py-[1px] text-[11px] leading-[1.6]', roleBadgeClass(member.role))}>
                            {t(members.roleKeyOf(member.role))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {members.roster.nextCursor ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className={clientWorkbenchButtonClassName + ' mt-[8px]'}
                      data-testid="project-members-roster-more"
                      disabled={members.roster.loadingMore}
                      onClick={members.loadMoreRoster}
                    >
                      {members.roster.loadingMore ? t('projectMembers.loadingMore') : t('projectMembers.loadMore')}
                    </Button>
                  ) : null}
                </div>

                {/* Targeted invitation records (owner/manager only surface) */}
                <div>
                  <span className="text-[12px] font-semibold text-foreground">{t('projectMembers.invitations.heading')}</span>
                  {members.invitations.loading ? (
                    <p className="mt-[8px] flex items-center gap-[6px] text-[12px] text-muted-foreground" data-testid="project-members-invitations-loading">
                      <Loader2 className="size-[13px] shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      <span>{t('projectMembers.loadingMore')}</span>
                    </p>
                  ) : members.invitations.errorKey ? (
                    <div className="mt-[8px] flex items-center gap-[10px]" data-testid="project-members-invitations-error">
                      <p className="text-[12px] text-destructive">
                        {t(members.invitations.errorKey)}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        className={clientWorkbenchButtonClassName}
                        data-testid="project-members-invitations-retry"
                        onClick={members.retryInvitations}
                      >
                        {t('projectMembers.retry')}
                      </Button>
                    </div>
                  ) : members.invitations.items.length === 0 ? (
                    <p className="mt-[8px] text-[12px] text-muted-foreground" data-testid="project-members-invitations-empty">
                      {t('projectMembers.invitations.empty')}
                    </p>
                  ) : (
                    <ul className="mt-[6px] flex flex-col rounded-[10px] border border-border" data-testid="project-members-invitations">
                      {members.invitations.items.map(invitation => {
                        const target = invitation.maskedPhone ?? invitation.maskedEmail ?? ''
                        return (
                          <li
                            key={invitation.invitationId}
                            data-testid="project-members-invitation-row"
                            data-invitation-status={invitation.status}
                            className="flex flex-col gap-[2px] border-b border-border px-[11px] py-[8px] last:border-b-0"
                          >
                            <span className="flex items-center gap-[8px]">
                              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{target}</span>
                              <span className="shrink-0 rounded-full bg-foreground-5 px-[7px] py-[1px] text-[11px] leading-[1.6] text-foreground-60">
                                {t(members.statusKeyOf(invitation.status))}
                              </span>
                            </span>
                            <span className="text-[11px] leading-[1.45] text-foreground-50">
                              {invitation.acceptedAt
                                ? t('projectMembers.invitations.acceptedAt', { date: new Date(invitation.acceptedAt).toLocaleString() })
                                : t('projectMembers.invitations.expiresAt', { date: new Date(invitation.expiresAt).toLocaleString() })}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  {members.invitations.nextCursor ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className={clientWorkbenchButtonClassName + ' mt-[8px]'}
                      data-testid="project-members-invitations-more"
                      disabled={members.invitations.loadingMore}
                      onClick={members.loadMoreInvitations}
                    >
                      {members.invitations.loadingMore ? t('projectMembers.loadingMore') : t('projectMembers.loadMore')}
                    </Button>
                  ) : null}
                </div>

                <p className="mt-auto text-[11px] leading-[1.45] text-foreground-50" data-testid="project-members-manage-note">
                  {t('projectMembers.manage.note')}
                </p>
              </div>
            )
          ) : members.step === 'compose' ? (
            <form
              id="project-invite-form"
              className="flex flex-col gap-[10px]"
              data-testid="project-members-compose"
              onSubmit={event => {
                event.preventDefault()
                void members.submitInvitation()
              }}
              noValidate
            >
              <label className="block">
                <span className="mb-[5px] block text-[12px] font-medium text-foreground">
                  {t('projectMembers.invite.targetLabel')}
                </span>
                <Input
                  data-testid="project-members-invite-target"
                  value={members.composeTarget}
                  // X2-9: a deployment without email delivery composes by
                  // phone only — the placeholder says so before any input.
                  placeholder={t(members.emailDeliveryAvailable
                    ? 'projectMembers.invite.targetPlaceholder'
                    : 'projectMembers.invite.targetPlaceholderPhone')}
                  disabled={members.composeSubmitting}
                  onChange={event => {
                    members.editComposeTarget(event.target.value)
                  }}
                  aria-invalid={Boolean(members.composeErrorKey)}
                  // X2-18: the validation message is reachable as THIS
                  // control's description (same pattern as the create form).
                  aria-describedby="project-members-invite-target-error"
                />
                <span
                  id="project-members-invite-target-error"
                  className="mt-[4px] block text-[11px] leading-[1.45] text-destructive"
                  role={members.composeErrorKey ? 'alert' : undefined}
                >
                  {members.composeErrorKey ? t(members.composeErrorKey) : ''}
                </span>
              </label>
            </form>
          ) : members.outcome ? (
            <div className="flex flex-col gap-[10px]" data-testid="project-members-invite-result" data-result={members.outcome.result}>
              {members.outcome.result === 'credential_unrecoverable' ? (
                <div
                  role="status"
                  className="rounded-[10px] bg-[var(--destructive-soft)] px-[12px] py-[10px] text-[12px] leading-[1.55] text-destructive"
                  data-testid="project-members-invite-unrecoverable"
                >
                  <span>{t('projectMembers.invite.linkUnavailable')}</span>
                </div>
              ) : members.outcome.result === 'state_changed' ? (
                <div
                  role="status"
                  className="rounded-[10px] bg-foreground-5 px-[12px] py-[10px] text-[12px] leading-[1.55] text-foreground-60"
                  data-testid="project-members-invite-state-changed"
                >
                  {t('projectMembers.invite.stateChanged')}
                </div>
              ) : members.outcome.result === 'existing' ? (
                <div
                  role="status"
                  className="rounded-[10px] bg-foreground-5 px-[12px] py-[10px] text-[12px] leading-[1.55] text-foreground-60"
                  data-testid="project-members-invite-existing"
                >
                  {t('projectMembers.invite.existingActive')}
                </div>
              ) : (
                <>
                  {members.outcome.invitationUrl ? (
                    <>
                      <Button
                        type="button"
                        className={clientWorkbenchPrimaryClassName}
                        data-testid="project-members-copy-link"
                        onClick={() => { void members.copyLink() }}
                      >
                        {members.copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
                        {members.copied ? t('projectMembers.invite.copied') : t('projectMembers.invite.copyLink')}
                      </Button>
                      {members.copyFailed ? (
                        <p className="text-[11px] leading-[1.45] text-destructive" role="alert" data-testid="project-members-copy-failed">
                          {t('projectMembers.invite.copyFailed')}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </>
              )}
              {/* X2-13: a result WITHOUT a copyable link still needs its
                  management destination — the same controlled handoff the
                  overview uses (live permission re-checked at click time). */}
              {members.outcome.result !== 'created' && members.outcome.result !== 'replayed' ? (
                <Button
                  type="button"
                  variant="ghost"
                  className={clientWorkbenchButtonClassName}
                  data-testid="project-members-result-management"
                  onClick={onOpenEnterpriseManagement}
                >
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  {t('projectMembers.manage.open')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {members.step === 'overview' ? (
            members.viewerRole === 'member' ? (
              <Button
                type="button"
                className={clientWorkbenchPrimaryClassName}
                data-testid="project-members-close"
                onClick={() => onOpenChange(false)}
              >
                {t('common.close')}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  className={clientWorkbenchButtonClassName}
                  data-testid="project-members-open-management"
                  onClick={onOpenEnterpriseManagement}
                >
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  {t('projectMembers.manage.open')}
                </Button>
                <Button
                  type="button"
                  className={clientWorkbenchPrimaryClassName}
                  data-testid="project-members-invite-action"
                  onClick={members.openCompose}
                >
                  <UserPlus className="size-3.5" aria-hidden="true" />
                  {t('projectMembers.invite.action')}
                </Button>
              </>
            )
          ) : members.step === 'compose' ? (
            <>
              <Button
                type="button"
                variant="ghost"
                className={clientWorkbenchButtonClassName}
                data-testid="project-members-compose-back"
                disabled={members.composeSubmitting}
                onClick={members.cancelCompose}
              >
                {t('projectMembers.invite.backToRoster')}
              </Button>
              <Button
                type="submit"
                form="project-invite-form"
                className={clientWorkbenchPrimaryClassName}
                data-testid="project-members-invite-submit"
                disabled={members.composeSubmitting}
              >
                {members.composeSubmitting
                  ? t('projectMembers.invite.submitting')
                  : t('projectMembers.invite.submit')}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              className={clientWorkbenchPrimaryClassName}
              data-testid="project-members-result-back"
              onClick={members.closeResult}
            >
              <ChevronRight className="size-3.5 rotate-180" aria-hidden="true" />
              {t('projectMembers.invite.backToRoster')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
