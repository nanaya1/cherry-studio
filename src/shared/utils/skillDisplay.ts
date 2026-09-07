import type { SystemSkillCandidate } from '@shared/types/skill'

/**
 * Display label for a system skill candidate. English locales prefer
 * `displayNameEn`, then `displayName`, else `name`.
 */
export function getSystemSkillDisplayName(
  skill: Pick<SystemSkillCandidate, 'displayName' | 'displayNameEn' | 'name'>,
  locale?: string | null
): string {
  if (locale?.toLowerCase().startsWith('en') && skill.displayNameEn) return skill.displayNameEn
  return skill.displayName ?? skill.name
}
