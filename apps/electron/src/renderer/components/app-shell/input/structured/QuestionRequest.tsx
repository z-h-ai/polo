import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { QuestionRequest as QuestionRequestType, QuestionResponse } from '../../../../../shared/types'

/** UI-reserved id for the auto-added free-text "Other" option. */
const OTHER_OPTION_ID = '__other__'
const MAX_OTHER_TEXT = 2000

export interface QuestionRequestProps {
  request: QuestionRequestType
  onSubmit: (response: QuestionResponse) => void | Promise<void>
  onCancel: (requestId: string) => void | Promise<void>
  disabled?: boolean
  submitting?: boolean
  error?: string
  unstyled?: boolean
}

/**
 * QuestionRequest - controlled structured input for agent questions.
 *
 * Pure presentation + local answer state:
 * - Renders 1-3 questions with a Back / Next stepper and progress counter
 * - Single-select (radio) and multi-select (checkbox) questions
 * - Auto-appends an "Other" free-text option (UI-reserved __other__ id)
 * - Honors explicit `exclusive` options (bidirectional mutual exclusion)
 * - Emits QuestionResponse via onSubmit; triggers onCancel for "skip"
 * - Never calls Electron APIs — RPC and pending state live in the container
 */
export function QuestionRequest({
  request,
  onSubmit,
  onCancel,
  disabled = false,
  submitting: submittingProp,
  error: errorProp,
  unstyled = false,
}: QuestionRequestProps) {
  const { t } = useTranslation()
  const inactive = disabled

  // Per-question selection state. `__other__` is stored as a pseudo option id.
  const [answers, setAnswers] = React.useState<Record<string, string[]>>({})
  const [otherTexts, setOtherTexts] = React.useState<Record<string, string>>({})
  const [step, setStep] = React.useState(0)

  // A new requestId must reset all local answer state (P0 contract).
  React.useEffect(() => {
    setAnswers({})
    setOtherTexts({})
    setStep(0)
    setInternalError(undefined)
    setInternalSubmitting(false)
  }, [request.requestId])

  // Container-managed states take precedence over the internal ones so the
  // component can be fully controlled (Playground, tests) or self-managed (chat).
  const [internalSubmitting, setInternalSubmitting] = React.useState(false)
  const [internalError, setInternalError] = React.useState<string | undefined>(undefined)
  const submitting = submittingProp ?? internalSubmitting
  const error = errorProp ?? internalError

  const question = request.questions[Math.min(step, request.questions.length - 1)]
  const otherInputRef = React.useRef<HTMLInputElement>(null)
  const otherSelected = (answers[question.id] ?? []).includes(OTHER_OPTION_ID)

  // Auto-focus the Other text input whenever it becomes selected on the
  // current question (and when navigating back to a question with Other active).
  React.useEffect(() => {
    if (otherSelected && !inactive && !submitting) {
      otherInputRef.current?.focus()
    }
  }, [otherSelected, inactive, submitting, step, question.id])

  const isQuestionComplete = React.useCallback((targetQuestionId: string): boolean => {
    const selected = answers[targetQuestionId] ?? []
    return selected.length > 0
      && (!selected.includes(OTHER_OPTION_ID) || Boolean((otherTexts[targetQuestionId] ?? '').trim()))
  }, [answers, otherTexts])

  const currentComplete = isQuestionComplete(question.id)
  const allComplete = request.questions.every(q => isQuestionComplete(q.id))

  const selectOption = (optionId: string) => {
    if (inactive || submitting) return
    const multiple = question.multiple === true
    const clickedExclusive = optionId !== OTHER_OPTION_ID
      && question.options.find(o => o.id === optionId)?.exclusive === true

    // Compute inside the functional updater so rapid successive selections
    // (batched clicks) compose instead of overwriting each other with a
    // stale render-closure snapshot.
    setAnswers(current => {
      const selected = current[question.id] ?? []
      let next: string[]

      if (!multiple) {
        // Single-select: clicking Other again deselects it (allows going back
        // to a preset option without leaving an empty Other input behind).
        next = selected.includes(optionId) && optionId === OTHER_OPTION_ID ? [] : [optionId]
      } else if (clickedExclusive) {
        // Exclusive option: mutually exclusive with everything else, both ways.
        next = selected.includes(optionId) ? [] : [optionId]
      } else {
        // Normal option / Other: composing is allowed, but any exclusive
        // selection is dropped when a compatible choice is made.
        const compatible = selected.filter(id => !question.options.some(o => o.exclusive && o.id === id))
        next = compatible.includes(optionId)
          ? compatible.filter(id => id !== optionId)
          : [...compatible, optionId]
      }

      return { ...current, [question.id]: next }
    })

    if (clickedExclusive) {
      // Exclusive selection excludes the Other free text as well.
      setOtherTexts(current => ({ ...current, [question.id]: '' }))
    }
  }

  const moveToStep = (nextStep: number) => {
    if (inactive || submitting || nextStep === step) return
    if (nextStep < 0 || nextStep >= request.questions.length) return
    setStep(nextStep)
  }

  const buildResponse = (): QuestionResponse => ({
    requestId: request.requestId,
    answers: request.questions.map(item => {
      const selected = answers[item.id] ?? []
      const hasOther = selected.includes(OTHER_OPTION_ID)
      const otherText = (otherTexts[item.id] ?? '').trim()
      return {
        questionId: item.id,
        selectedOptionIds: selected.filter(id => id !== OTHER_OPTION_ID),
        ...(hasOther && otherText ? { otherText } : {}),
      }
    }),
  })

  const handleSubmit = async () => {
    if (inactive || submitting || !allComplete) return
    setInternalSubmitting(true)
    setInternalError(undefined)
    try {
      await onSubmit(buildResponse())
      // Terminal results unmount this component via the container.
    } catch (err) {
      // transient_failure: keep selections, step, and Other text; allow retry.
      setInternalError(err instanceof Error ? err.message : String(err))
    } finally {
      setInternalSubmitting(false)
    }
  }

  const handleCancel = async () => {
    if (inactive || submitting) return
    setInternalSubmitting(true)
    setInternalError(undefined)
    try {
      await onCancel(request.requestId)
    } catch (err) {
      setInternalError(err instanceof Error ? err.message : String(err))
      setInternalSubmitting(false)
    }
  }

  const renderChoice = (
    id: string,
    label: string,
    description: string | undefined,
    opts: { multiple: boolean; recommended?: boolean; selected: boolean; controlsId?: string },
  ) => {
    const { multiple, recommended, selected, controlsId } = opts
    const optionTestId = `question-option-${question.id}-${id}`
    return (
      <button
        key={id}
        type="button"
        role={multiple ? 'checkbox' : 'radio'}
        aria-checked={selected}
        {...(controlsId ? { 'aria-controls': controlsId } : {})}
        data-testid={optionTestId}
        disabled={inactive || submitting}
        onClick={() => selectOption(id)}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-3 text-left outline-none transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
          selected ? 'bg-foreground/5' : 'hover:bg-foreground/[0.03]',
          (inactive || submitting) && 'cursor-default opacity-70',
        )}
      >
        {/* Radio dot / checkbox square */}
        <span
          aria-hidden="true"
          className={cn(
            'mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center border bg-background',
            multiple ? 'rounded-[4px]' : 'rounded-full',
            selected ? 'border-accent border-2' : 'border-foreground/30 border-[1.5px]',
          )}
        >
          {multiple && selected && <Check className="h-2.5 w-2.5 text-accent" strokeWidth={3} />}
          {!multiple && selected && <span className="h-2 w-2 rounded-full bg-accent" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium leading-tight text-foreground">{label}</span>
            {recommended && (
              <span
                className="inline-flex items-center rounded-[4px] border border-accent/50 bg-accent/5 px-1.5 text-[10px] font-medium leading-[18px] text-accent"
                data-testid={`question-recommended-${question.id}-${id}`}
              >
                {t('chat.questionRecommended')}
              </span>
            )}
          </span>
          {description && (
            <span className="mt-0.5 block text-xs leading-[18px] text-muted-foreground">{description}</span>
          )}
        </span>
      </button>
    )
  }

  return (
    <div
      data-testid="question-request"
      className={cn(
        'flex h-full w-full flex-col overflow-hidden bg-background',
        unstyled ? '' : 'rounded-[8px] border border-border shadow-middle',
      )}
    >
      {/* Scrollable question content — footer stays pinned below */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{question.header}</span>
              {question.multiple && (
                <span className="text-[10px] font-medium text-muted-foreground">{t('chat.questionMultiple')}</span>
              )}
            </div>
            <div className="text-[13px] leading-[18px] text-muted-foreground">{question.question}</div>
          </div>
          {request.questions.length > 1 && (
            <span
              data-testid="question-step-counter"
              className="inline-flex h-[22px] min-w-[42px] shrink-0 items-center justify-center rounded-full bg-foreground/5 px-2 text-[11px] font-medium text-muted-foreground"
            >
              {step + 1} / {request.questions.length}
            </span>
          )}
        </div>

        <div
          role={question.multiple ? 'group' : 'radiogroup'}
          aria-label={question.header}
          className="overflow-hidden rounded-lg border border-border"
        >
          {question.options.map((option, index) => (
            <React.Fragment key={option.id}>
              {index > 0 && <div className="h-px bg-border" />}
              {renderChoice(option.id, option.label, option.description, {
                multiple: question.multiple === true,
                recommended: option.recommended === true,
                selected: (answers[question.id] ?? []).includes(option.id),
              })}
            </React.Fragment>
          ))}
          <div className="h-px bg-border" />
          <div>
            {renderChoice(OTHER_OPTION_ID, t('chat.questionOther'), undefined, {
              multiple: question.multiple === true,
              selected: otherSelected,
              controlsId: `question-other-input-${question.id}`,
            })}
            {/* Sibling of the option button (never nested inside it): an
                interactive control inside a radio/checkbox would make Tab,
                typing, and screen-reader semantics unreliable. Associated with
                the button via aria-controls + an explicit <label>. */}
            {otherSelected && (
              <div className="bg-background px-4 pb-3">
                <label
                  htmlFor={`question-other-input-${question.id}`}
                  className="mb-1.5 block text-xs font-medium text-muted-foreground"
                >
                  {t('chat.questionOtherPlaceholder')}
                </label>
                <input
                  ref={otherInputRef}
                  id={`question-other-input-${question.id}`}
                  type="text"
                  value={otherTexts[question.id] ?? ''}
                  onChange={e => setOtherTexts(current => ({ ...current, [question.id]: e.target.value }))}
                  maxLength={MAX_OTHER_TEXT}
                  disabled={inactive || submitting}
                  placeholder={t('chat.questionOtherPlaceholder')}
                  data-testid={`question-other-input-${question.id}`}
                  className="block h-9 w-full rounded-md border border-foreground/20 bg-background px-3 text-sm text-foreground outline-none focus:border-accent/60 focus:ring-1 focus:ring-ring/40 disabled:opacity-70"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer actions — always visible (content scrolls above) */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border bg-background px-3 py-2">
        <span
          aria-live="polite"
          data-testid="question-status"
          className={cn(
            'min-w-0 flex-1 text-[10px] leading-[1.35]',
            error ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {submitting
            ? t('chat.questionSubmitting')
            : error
              ? error
              : ''}
        </span>

        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 border border-foreground/10 hover:bg-foreground/5"
          disabled={inactive || submitting}
          onClick={handleCancel}
          data-testid="question-cancel"
        >
          {t('chat.questionSkip')}
        </Button>

        {step > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 border border-foreground/10 hover:bg-foreground/5"
            disabled={inactive || submitting}
            onClick={() => moveToStep(step - 1)}
            data-testid="question-back"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('chat.questionBack')}
          </Button>
        )}

        {step < request.questions.length - 1 ? (
          <Button
            size="sm"
            className="h-7 gap-1.5"
            disabled={inactive || submitting || !currentComplete}
            onClick={() => moveToStep(step + 1)}
            data-testid="question-next"
          >
            {t('chat.questionNext')}
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-7 gap-1.5"
            disabled={inactive || submitting || !allComplete}
            onClick={handleSubmit}
            data-testid="question-confirm"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {error ? t('chat.questionRetry') : t('chat.questionConfirm')}
          </Button>
        )}
      </div>
    </div>
  )
}
