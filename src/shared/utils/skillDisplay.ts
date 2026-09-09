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

/**
 * Description for a system skill candidate. English locales prefer
 * `descriptionEn`, then `description`.
 */
export function getSystemSkillDescription(
  skill: Pick<SystemSkillCandidate, 'description' | 'descriptionEn'>,
  locale?: string | null
): string | null {
  if (locale?.toLowerCase().startsWith('en') && skill.descriptionEn) return skill.descriptionEn
  return skill.description ?? null
}
