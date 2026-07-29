import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  AlertTriangle,
  Building2,
  Check,
  ChevronLeft,
  Sparkles,
  Users,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@polo-ai/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type {
  OrganizationJoinPreview,
  OrganizationSummary,
  OrganizationType,
} from '../../../shared/types'
import type {
  OrganizationFlowError,
  OrganizationFlowState,
} from '@/hooks/useOrganizationContext'

interface OrganizationOnboardingProps {
  flowState: OrganizationFlowState
  organizations: OrganizationSummary[]
  joinPreview: OrganizationJoinPreview | null
  error: OrganizationFlowError | null
  onCreate: (input: {
    type: OrganizationType
    name: string
    purpose: string
    idempotencyKey: string
  }) => Promise<unknown>
  onAcceptJoin: () => Promise<unknown>
  onDismissJoin: () => void
  onSelect: (organizationId: string) => void
  onShowCreate: () => void
  onShowSelect: () => void
  onRetry: () => void
}

export function OrganizationOnboarding(props: OrganizationOnboardingProps) {
  const { t } = useTranslation()

  return (
    <main
      data-testid="organization-onboarding-page"
      className="flex h-screen min-h-0 items-center justify-center overflow-auto bg-background p-6 text-foreground"
    >
      <div className="w-full max-w-xl">
        {props.flowState === 'loading' || props.flowState === 'idle' ? (
          <div className="flex flex-col items-center gap-3 py-16" role="status">
            <Spinner />
            <p className="text-sm text-muted-foreground">{t('organization.loading')}</p>
            {props.error ? <OrganizationError error={props.error} /> : null}
            {props.error ? (
              <Button type="button" variant="outline" onClick={props.onRetry}>
                {t('organization.refresh')}
              </Button>
            ) : null}
          </div>
        ) : props.flowState === 'join' ? (
          <JoinOrganizationCard {...props} />
        ) : props.flowState === 'select' ? (
          <SelectOrganizationCard {...props} />
        ) : (
          <CreateOrganizationCard {...props} />
        )}
      </div>
    </main>
  )
}

function CreateOrganizationCard(props: OrganizationOnboardingProps) {
  const { t } = useTranslation()
  const [type, setType] = useState<OrganizationType>('creator_space')
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const idempotencyKeyRef = useRef<string | null>(null)

  const markInputChanged = () => {
    idempotencyKeyRef.current = null
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting || !name.trim() || !purpose.trim()) return
    setSubmitting(true)
    try {
      idempotencyKeyRef.current ??= crypto.randomUUID()
      await props.onCreate({
        type,
        name: name.trim(),
        purpose: purpose.trim(),
        idempotencyKey: idempotencyKeyRef.current,
      })
    } catch {
      // The organization hook retains the form and exposes the safe RPC error.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="rounded-2xl border border-border/60 bg-background p-6 shadow-minimal">
      {props.organizations.length > 0 ? (
        <button
          type="button"
          onClick={props.onShowSelect}
          className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          {t('organization.backToOrganizations')}
        </button>
      ) : null}
      <div className="text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Users className="size-6" />
        </div>
        <h1 className="mt-4 text-xl font-semibold">{t('organization.create.title')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('organization.create.subtitle')}</p>
      </div>

      <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
        <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <legend className="sr-only">{t('organization.create.typeLabel')}</legend>
          <TypeCard
            selected={type === 'creator_space'}
            icon={Sparkles}
            title={t('organization.type.creator')}
            description={t('organization.type.creatorDescription')}
            onClick={() => {
              setType('creator_space')
              markInputChanged()
            }}
          />
          <TypeCard
            selected={type === 'enterprise_workspace'}
            icon={Building2}
            title={t('organization.type.enterprise')}
            description={t('organization.type.enterpriseDescription')}
            onClick={() => {
              setType('enterprise_workspace')
              markInputChanged()
            }}
          />
        </fieldset>

        <div className="space-y-2">
          <Label htmlFor="organization-name">{t('organization.create.name')}</Label>
          <Input
            id="organization-name"
            data-testid="organization-name-input"
            value={name}
            maxLength={128}
            disabled={submitting}
            placeholder={t('organization.create.namePlaceholder')}
            onChange={event => {
              setName(event.target.value)
              markInputChanged()
            }}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="organization-purpose">{t('organization.create.purpose')}</Label>
          <textarea
            id="organization-purpose"
            data-testid="organization-purpose-input"
            value={purpose}
            maxLength={512}
            disabled={submitting}
            placeholder={t('organization.create.purposePlaceholder')}
            onChange={event => {
              setPurpose(event.target.value)
              markInputChanged()
            }}
            className="min-h-24 w-full resize-none rounded-md border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-foreground/30 disabled:opacity-50"
          />
        </div>

        {props.error ? <OrganizationError error={props.error} /> : null}

        <Button
          data-testid="organization-create-submit"
          type="submit"
          disabled={submitting || !name.trim() || !purpose.trim()}
          className="h-11 w-full"
        >
          {submitting ? <Spinner className="mr-2" /> : null}
          {submitting ? t('organization.create.submitting') : t('organization.create.submit')}
        </Button>
      </form>
    </section>
  )
}

function TypeCard({
  selected,
  icon: Icon,
  title,
  description,
  onClick,
}: {
  selected: boolean
  icon: typeof Building2
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'relative rounded-xl border p-4 text-left transition-colors',
        selected
          ? 'border-accent bg-accent/5'
          : 'border-border/70 hover:border-foreground/30',
      )}
    >
      {selected ? (
        <span className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-accent text-background">
          <Check className="size-3" />
        </span>
      ) : null}
      <Icon className="size-5 text-accent" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
    </button>
  )
}

function JoinOrganizationCard(props: OrganizationOnboardingProps) {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const preview = props.joinPreview
  const isActive = preview?.join.effectiveStatus === 'active'

  const accept = async () => {
    if (submitting || !isActive) return
    setSubmitting(true)
    try {
      await props.onAcceptJoin()
    } catch {
      // The organization hook keeps the join context and exposes the safe RPC error.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="rounded-2xl border border-border/60 bg-background p-6 shadow-minimal">
      <div className="text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Users className="size-6" />
        </div>
        <h1 className="mt-4 text-xl font-semibold">{t('organization.join.title')}</h1>
      </div>

      {preview ? (
        <div className="mt-6 rounded-xl border border-border/60 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium">{preview.organization.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {preview.organization.type === 'creator_space'
                  ? t('organization.type.creator')
                  : t('organization.type.enterprise')}
              </p>
            </div>
            <span className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium',
              isActive ? 'bg-emerald-500/10 text-emerald-600' : 'bg-destructive/10 text-destructive',
            )}>
              {t(`organization.join.status.${preview.join.effectiveStatus}`)}
            </span>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">{preview.organization.purpose}</p>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">{t('organization.join.method')}</dt>
              <dd className="mt-1">
                {preview.join.kind === 'join_link'
                  ? t('organization.join.publicLink')
                  : t('organization.join.invitation')}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('organization.join.phoneMatch')}</dt>
              <dd className="mt-1">
                {preview.join.requiresPhoneMatch ? t('organization.yes') : t('organization.no')}
              </dd>
            </div>
          </dl>
        </div>
      ) : props.error ? (
        <div className="mt-6 space-y-3">
          <OrganizationError error={props.error} />
          <Button type="button" variant="outline" className="w-full" onClick={props.onRetry}>
            {t('organization.refresh')}
          </Button>
        </div>
      ) : (
        <div className="mt-6 flex justify-center py-8"><Spinner /></div>
      )}

      {props.error && preview ? <div className="mt-4"><OrganizationError error={props.error} /></div> : null}

      <div className="mt-6 flex gap-3">
        <Button type="button" variant="outline" className="flex-1" onClick={props.onDismissJoin}>
          {t('organization.join.dismiss')}
        </Button>
        <Button
          data-testid="organization-join-accept"
          type="button"
          className="flex-1"
          disabled={!isActive || submitting}
          onClick={accept}
        >
          {submitting ? <Spinner className="mr-2" /> : null}
          {submitting ? t('organization.join.accepting') : t('organization.join.accept')}
        </Button>
      </div>
    </section>
  )
}

function SelectOrganizationCard(props: OrganizationOnboardingProps) {
  const { t } = useTranslation()

  return (
    <section className="rounded-2xl border border-border/60 bg-background p-6 shadow-minimal">
      <div className="text-center">
        <h1 className="text-xl font-semibold">{t('organization.select.title')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('organization.select.subtitle')}</p>
      </div>
      <div className="mt-6 space-y-2">
        {props.organizations.map(organization => (
          <button
            key={organization.id}
            data-testid="organization-select-row"
            type="button"
            onClick={() => props.onSelect(organization.id)}
            className="flex w-full items-center gap-3 rounded-xl border border-border/60 p-4 text-left hover:border-foreground/30 hover:bg-foreground/[0.02]"
          >
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              {organization.type === 'creator_space'
                ? <Sparkles className="size-5" />
                : <Building2 className="size-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{organization.name}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {t(`organization.role.${organization.membership.role}`)}
                {' · '}
                {t('organization.memberCount', { value: organization.memberCount })}
              </p>
            </div>
          </button>
        ))}
      </div>
      <Button type="button" variant="outline" className="mt-4 w-full" onClick={props.onShowCreate}>
        {t('organization.createAnother')}
      </Button>
      {props.error ? <div className="mt-4"><OrganizationError error={props.error} /></div> : null}
    </section>
  )
}

function OrganizationError({ error }: { error: OrganizationFlowError }) {
  const { t } = useTranslation()
  const translated = error.code && t(`organization.errors.${error.code}`, {
    defaultValue: '',
  })

  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>{translated || t('organization.errors.request_failed')}</span>
    </div>
  )
}
