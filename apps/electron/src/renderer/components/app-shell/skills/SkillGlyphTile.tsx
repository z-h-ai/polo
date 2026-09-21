import * as React from 'react'
import { Sparkles } from 'lucide-react'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import type { LoadedSkill } from '../../../../shared/types'

export interface SkillGlyphTileProps {
  /** Raw skill for real icon loading, when available. */
  skill?: LoadedSkill
  workspaceId?: string
  /** Fallback glyph (prototype uses ✧). */
  glyph?: string
  compact?: boolean
  className?: string
}

/**
 * SkillGlyphTile — the square art tile shown beside skill names (g4
 * `app-art`). Uses the real SkillAvatar when a LoadedSkill is attached,
 * otherwise a token-styled glyph tile so demos render standalone.
 */
export function SkillGlyphTile({
  skill,
  workspaceId,
  glyph,
  compact = false,
  className,
}: SkillGlyphTileProps) {
  const size = compact ? 'h-7 w-7 text-hifi-md' : 'h-10 w-10 text-hifi-lg'
  if (skill) {
    return (
      <SkillAvatar
        skill={skill}
        size="sm"
        workspaceId={workspaceId}
        className={`${compact ? 'h-7 w-7' : 'h-10 w-10'} shrink-0 ${className ?? ''}`}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={`inline-flex ${size} shrink-0 items-center justify-center rounded-hifi-md bg-hifi-fg-5 text-hifi-fg-70 ${className ?? ''}`}
    >
      {glyph ? <span>{glyph}</span> : <Sparkles className="h-4 w-4" />}
    </span>
  )
}
