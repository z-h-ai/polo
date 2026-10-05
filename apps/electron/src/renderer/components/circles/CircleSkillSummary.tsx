import { useTranslation } from 'react-i18next'
import type { MemberCircleEntitlement } from '@polo-ai/shared/admin'

/**
 * POO-70 C4 (P70-CIRCLE-CONTENT-02) — the READ-ONLY circle skill summary.
 *
 * Batch boundary (POO-70 parent card + §13.11/13.13): circle skills render as
 * existing, already-authorized entries with their summary — this batch does
 * NOT implement skill detail, management, enablement, installation or any
 * jump into the assistant. The component therefore renders NO action at all:
 * an unbuilt entry must not pretend to succeed (the same rule that keeps the
 * prototype's 查看并安装 / 管理本机版本 buttons out of this batch — they
 * target the deferred skills-management pages).
 *
 * Projection source: the C1 trusted member-circle receipt (`me/circles`
 * entitlements, consumed through C2 `getCircle`), filtered to skill-type
 * artifacts. This is the F1/C1 authoritative read-only material the card
 * names for content outside the Catalog. Projection from trusted Catalog
 * `kind=skill` rows with creator_circle sources is UPSTREAM-EXPECTED: the
 * renderer catalog cache currently projects only `kind='app'` rows
 * (`useAppCatalog` `mapProductSpaceCatalogToCacheEntry`), so until that
 * upstream surface lands the C1 receipt is the only authoritative skill
 * material — consumed strictly read-only, with no identity ever guessed
 * (no artifactId→artifactInstanceId mapping is attempted anywhere here).
 */

/** One read-only skill row projected from a skill-type entitlement. */
export interface CircleSkillSummaryEntry {
  /** The entitlement row id — stable UI key, never an authorization input. */
  entitlementId: string
  /** Verbatim receipt identifiers, kept for tests; never used as identity. */
  artifactId: string
  /**
   * Nullable per the verified provider shape (C1 ab9df8d8: Artifact.name /
   * Artifact.summary are nullable DB columns passed through verbatim).
   * Presentation is null-safe: a null renders as empty — never a fabricated
   * fallback value.
   */
  name: string | null
  summary: string | null
  /** Raw provider artifact status, carried verbatim — never interpreted. */
  artifactStatus: string
  /** The receipt's stable-version fact (may be null while none is published). */
  stableVersionId: string | null
  /** The authorized version string recorded by the receipt. */
  version: string | null
}

/**
 * Pure selection of the circle's skill-type entitlements, in receipt order.
 * An empty result is a legitimate fact (the circle distributes no skills) —
 * never an error and never filled with anything.
 */
export function selectCircleSkillSummaries(
  entitlements: ReadonlyArray<MemberCircleEntitlement>,
): CircleSkillSummaryEntry[] {
  return entitlements
    .filter(entitlement => entitlement.artifact.type === 'skill')
    .map(entitlement => ({
      entitlementId: entitlement.id,
      artifactId: entitlement.artifactId,
      name: entitlement.artifact.name,
      summary: entitlement.artifact.summary,
      artifactStatus: entitlement.artifact.status,
      stableVersionId: entitlement.artifact.currentStableVersionId,
      version: entitlement.artifactVersion?.version ?? null,
    }))
}

/** Count of entitlements that are NOT skill-type (the app-class rows). */
export function countCircleAppClassEntitlements(
  entitlements: ReadonlyArray<MemberCircleEntitlement>,
): number {
  return entitlements.filter(entitlement => entitlement.artifact.type !== 'skill').length
}

export interface CircleSkillSummaryProps {
  skills: ReadonlyArray<CircleSkillSummaryEntry>
}

/**
 * The 技能 section body. §13.13: the install-purpose note stays on the skill
 * entries (once per entry); with no install capability this batch the note is
 * the honest statement of what a circle skill is for, not an action invite.
 */
export function CircleSkillSummary({ skills }: CircleSkillSummaryProps) {
  const { t } = useTranslation()
  return (
    <ul
      className="m-0 grid list-none gap-[12px] p-0"
      data-testid="circle-content-skills"
    >
      {skills.map(skill => (
        <li
          key={skill.entitlementId}
          data-testid={`circle-content-skill-${skill.entitlementId}`}
          data-artifact-id={skill.artifactId}
          data-artifact-status={skill.artifactStatus}
          data-stable-version-id={skill.stableVersionId ?? ''}
          className="flex items-start gap-[14px] rounded-[14px] border border-foreground/10 bg-surface px-[16px] py-[14px]"
        >
          <span
            aria-hidden="true"
            className="mt-[2px] grid size-[38px] flex-none place-items-center rounded-[12px] bg-[color-mix(in_srgb,var(--success)_11%,transparent)] text-[15px] font-semibold text-success"
          >
            {(skill.name ?? '').slice(0, 1)}
          </span>
          <div className="min-w-0">
            <h3 className="m-0 text-[14px] font-bold leading-[1.4]">{skill.name}</h3>
            {skill.summary && (
              <p className="m-0 mt-[2px] text-[12px] leading-[1.6] text-muted-foreground">
                {skill.summary}
              </p>
            )}
            <p className="m-0 mt-[6px] text-[11px] leading-[1.5] text-foreground-50">
              {skill.version
                ? t('poo70.c4.content.versionValue', { version: skill.version })
                : null}
              {skill.version ? ' · ' : ''}
              {t('poo70.c4.skills.purpose')}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}
