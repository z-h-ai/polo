import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Clipboard,
  Link2,
  RotateCw,
  Trash2,
  UserMinus,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@polo-ai/ui'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useOrganizationContext } from '@/context/OrganizationContext'
import { createOrganizationJoinDeepLink } from '@/lib/organization-storage'
import type {
  OrganizationInvitation,
  OrganizationJoinLink,
  OrganizationMember,
} from '../../../shared/types'

interface OrganizationManagementDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOrganizationsChanged: () => Promise<unknown>
}

interface GeneratedLink {
  kind: 'invitation' | 'join_link'
  url: string
  joinLink?: OrganizationJoinLink
}

export function OrganizationManagementDialog({
  open,
  onOpenChange,
  onOrganizationsChanged,
}: OrganizationManagementDialogProps) {
  const { t } = useTranslation()
  const organization = useOrganizationContext()
  const active = organization.organizationSummaries.find(
    item => item.id === organization.activeOrganizationId,
  )
  const [members, setMembers] = useState<OrganizationMember[]>([])
  const [invitations, setInvitations] = useState<OrganizationInvitation[]>([])
  const [loading, setLoading] = useState(false)
  const [membersError, setMembersError] = useState<string | null>(null)
  const [invitationsError, setInvitationsError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [targetPhone, setTargetPhone] = useState('')
  const [maxUses, setMaxUses] = useState('1')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [generatedLink, setGeneratedLink] = useState<GeneratedLink | null>(null)

  const isOwner = organization.organizationMembershipRole === 'owner'
  const canManage = isOwner || organization.organizationMembershipRole === 'manager'
  const organizationErrorMessage = useCallback((result: {
    errorCode?: string
  }) => {
    const translated = result.errorCode
      ? t(`organization.errors.${result.errorCode}`, { defaultValue: '' })
      : ''
    return translated || t('organization.manage.actionFailed')
  }, [t])

  const loadData = useCallback(async () => {
    if (!open || !canManage) return
    setLoading(true)
    setMembersError(null)
    setInvitationsError(null)
    try {
      const [membersResult, invitationsResult] = await Promise.all([
        window.electronAPI.organizationListMembers(organization.activeOrganizationId),
        window.electronAPI.organizationListInvitations(organization.activeOrganizationId),
      ])
      if (membersResult.success) {
        setMembers(membersResult.members)
      } else {
        setMembers([])
        setMembersError(organizationErrorMessage(membersResult))
      }
      if (invitationsResult.success) {
        setInvitations(invitationsResult.invitations)
      } else {
        setInvitations([])
        setInvitationsError(organizationErrorMessage(invitationsResult))
      }
    } catch {
      setMembers([])
      setInvitations([])
      setMembersError(t('organization.manage.loadFailed'))
      setInvitationsError(t('organization.manage.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [
    canManage,
    open,
    organization.activeOrganizationId,
    organizationErrorMessage,
    t,
  ])

  useEffect(() => {
    if (open) void loadData()
  }, [loadData, open])

  useEffect(() => {
    setGeneratedLink(null)
    setActionError(null)
  }, [organization.activeOrganizationId])

  const runAction = async (
    action: string,
    callback: () => Promise<{ success: boolean; message?: string; errorCode?: string }>,
    after?: () => Promise<unknown> | unknown,
  ) => {
    if (busyAction) return
    setBusyAction(action)
    setActionError(null)
    try {
      const result = await callback()
      if (!result.success) {
        setActionError(organizationErrorMessage(result))
        return
      }
      await after?.()
    } catch {
      setActionError(t('organization.manage.actionFailed'))
    } finally {
      setBusyAction(null)
    }
  }

  const createInvitation = async () => {
    const uses = active?.type === 'enterprise_workspace'
      ? 1
      : Math.max(1, Math.min(1_000, Number.parseInt(maxUses, 10) || 1))
    await runAction('create-invitation', async () => {
      const result = await window.electronAPI.organizationCreateInvitation(
        organization.activeOrganizationId,
        {
          ...(targetPhone.trim() ? { targetPhone: targetPhone.trim() } : {}),
          maxUses: targetPhone.trim() ? 1 : uses,
        },
      )
      if (result.success) {
        setGeneratedLink({
          kind: 'invitation',
          url: createOrganizationJoinDeepLink(result.token),
        })
        setTargetPhone('')
      }
      return result
    }, loadData)
  }

  const createPublicLink = async () => {
    await runAction('create-public-link', async () => {
      const result = await window.electronAPI.organizationCreateJoinLink(
        organization.activeOrganizationId,
        { expiresAt: null, maxUses: null },
      )
      if (result.success) {
        setGeneratedLink({
          kind: 'join_link',
          url: createOrganizationJoinDeepLink(result.token),
          joinLink: result.joinLink,
        })
      }
      return result
    })
  }

  const copyGeneratedLink = async () => {
    if (!generatedLink) return
    try {
      await navigator.clipboard.writeText(generatedLink.url)
      toast.success(t('organization.manage.linkCopied'))
    } catch {
      setActionError(t('organization.manage.actionFailed'))
    }
  }

  const activeInvitationCount = useMemo(
    () => invitations.filter(item => item.effectiveStatus === 'active').length,
    [invitations],
  )

  if (!active) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="organization-management-dialog"
        className="max-h-[85vh] overflow-hidden sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>{t('organization.manage.title')}</DialogTitle>
          <DialogDescription>
            {active.name}
            {' · '}
            {t(`organization.role.${organization.organizationMembershipRole}`)}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue={isOwner ? 'members' : 'invitations'} className="min-h-0">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="members">{t('organization.manage.members')}</TabsTrigger>
            <TabsTrigger value="invitations">
              {t('organization.manage.invitations')}
              {activeInvitationCount > 0 ? ` (${activeInvitationCount})` : ''}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="members" className="max-h-[58vh] overflow-auto">
            {loading ? (
              <LoadingBlock />
            ) : membersError ? (
              <InlineError message={membersError} />
            ) : (
              <div className="space-y-2 pt-2">
                {isOwner ? (
                  <p className="px-1 pb-1 text-xs text-muted-foreground">
                    {t('organization.errors.last_owner_required')}
                  </p>
                ) : null}
                {members.map(member => (
                  <div
                    key={member.id}
                    data-testid="organization-member-row"
                    className="flex items-center gap-3 rounded-xl border border-border/60 p-3"
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent">
                      {(member.user.displayName || member.user.username).slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {member.user.displayName || member.user.username}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {member.user.phone || member.user.username}
                        {' · '}
                        {t(`organization.membershipStatus.${member.status}`)}
                      </p>
                    </div>
                    {isOwner && member.role !== 'owner' ? (
                      <>
                        <Select
                          value={member.role}
                          disabled={busyAction !== null}
                          onValueChange={value => {
                            void runAction(`role-${member.id}`, () =>
                              window.electronAPI.organizationUpdateMember(
                                organization.activeOrganizationId,
                                member.id,
                                { role: value as 'manager' | 'member' },
                              ), loadData)
                          }}
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="manager">{t('organization.role.manager')}</SelectItem>
                            <SelectItem value="member">{t('organization.role.member')}</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={t('organization.manage.removeMember')}
                          disabled={busyAction !== null}
                          onClick={() => {
                            void runAction(`remove-${member.id}`, () =>
                              window.electronAPI.organizationRemoveMember(
                                organization.activeOrganizationId,
                                member.id,
                              ), async () => {
                                await loadData()
                                await onOrganizationsChanged()
                              })
                          }}
                        >
                          <UserMinus className="size-4 text-destructive" />
                        </Button>
                      </>
                    ) : (
                      <span className="rounded-full bg-foreground/5 px-2.5 py-1 text-xs">
                        {t(`organization.role.${member.role}`)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="invitations" className="max-h-[58vh] overflow-auto">
            <div className="space-y-4 pt-2">
              <div className="rounded-xl border border-border/60 p-4">
                <h3 className="text-sm font-medium">{t('organization.manage.createInvitation')}</h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_120px_auto]">
                  <div className="space-y-1.5">
                    <Label htmlFor="organization-invite-phone">
                      {t('organization.manage.targetPhone')}
                    </Label>
                    <Input
                      id="organization-invite-phone"
                      value={targetPhone}
                      disabled={busyAction !== null}
                      placeholder={t('organization.manage.targetPhonePlaceholder')}
                      onChange={event => setTargetPhone(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="organization-invite-uses">{t('organization.manage.maxUses')}</Label>
                    <Input
                      id="organization-invite-uses"
                      type="number"
                      min={1}
                      max={1_000}
                      value={targetPhone.trim() || active.type === 'enterprise_workspace' ? '1' : maxUses}
                      disabled={busyAction !== null || Boolean(targetPhone.trim()) || active.type === 'enterprise_workspace'}
                      onChange={event => setMaxUses(event.target.value)}
                    />
                  </div>
                  <Button
                    type="button"
                    className="self-end"
                    disabled={busyAction !== null}
                    onClick={() => { void createInvitation() }}
                  >
                    {busyAction === 'create-invitation' ? <Spinner className="mr-2" /> : <Link2 className="mr-2 size-4" />}
                    {t('organization.manage.generate')}
                  </Button>
                </div>

                {active.type === 'creator_space' ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-3"
                    disabled={busyAction !== null}
                    onClick={() => { void createPublicLink() }}
                  >
                    {busyAction === 'create-public-link' ? <Spinner className="mr-2" /> : <Link2 className="mr-2 size-4" />}
                    {t('organization.manage.createPublicLink')}
                  </Button>
                ) : null}

                {generatedLink ? (
                  <div
                    data-testid="organization-invite-detail"
                    className="mt-4 rounded-lg bg-foreground/[0.04] p-3"
                  >
                    <div className="flex items-center gap-2">
                      <Input readOnly value={generatedLink.url} className="font-mono text-xs" />
                      <Button type="button" size="icon" variant="outline" onClick={() => { void copyGeneratedLink() }}>
                        <Clipboard className="size-4" />
                      </Button>
                      {generatedLink.joinLink ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          aria-label={t('organization.manage.revoke')}
                          disabled={busyAction !== null}
                          onClick={() => {
                            void runAction('revoke-public-link', () =>
                              window.electronAPI.organizationRevokeJoinLink(
                                organization.activeOrganizationId,
                                generatedLink.joinLink!.id,
                              ), () => setGeneratedLink(null))
                          }}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      ) : null}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('organization.manage.linkOnlyShownOnce')}
                    </p>
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">{t('organization.manage.invitationHistory')}</h3>
                <Button type="button" size="sm" variant="ghost" onClick={() => { void loadData() }}>
                  <RotateCw className="mr-1.5 size-3.5" />
                  {t('organization.refresh')}
                </Button>
              </div>

              {loading ? (
                <LoadingBlock />
              ) : invitationsError ? (
                <InlineError message={invitationsError} />
              ) : invitations.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {t('organization.manage.noInvitations')}
                </p>
              ) : (
                <div className="space-y-2">
                  {invitations.map(invitation => (
                    <div
                      key={invitation.id}
                      data-testid="organization-invitation-row"
                      className="flex items-center gap-3 rounded-xl border border-border/60 p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          {invitation.targetPhone || t('organization.manage.genericInvitation')}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t(`organization.join.status.${invitation.effectiveStatus}`)}
                          {' · '}
                          {invitation.useCount}/{invitation.maxUses}
                        </p>
                      </div>
                      {invitation.effectiveStatus === 'active' ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busyAction !== null}
                          onClick={() => {
                            void runAction(`cancel-${invitation.id}`, () =>
                              window.electronAPI.organizationCancelInvitation(
                                organization.activeOrganizationId,
                                invitation.id,
                              ), loadData)
                          }}
                        >
                          {busyAction === `cancel-${invitation.id}`
                            ? <Spinner className="mr-1.5" />
                            : <Trash2 className="mr-1.5 size-3.5" />}
                          {t('organization.manage.cancel')}
                        </Button>
                      ) : (
                        <Check className="size-4 text-muted-foreground" />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>

        {actionError ? <InlineError message={actionError} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function LoadingBlock() {
  return (
    <div className="flex justify-center py-10" role="status">
      <Spinner />
    </div>
  )
}

function InlineError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}
