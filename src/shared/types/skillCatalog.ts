/**
 * Skill catalog protocol — the single source of truth for the bundled/remote
 * catalog format. Zod schemas serve as both runtime validators and the
 * TypeScript types the loader, synchronizer and Data API all share.
 *
 * This module is pure: no filesystem or network access. Path, hash and
 * compatibility rules live here so every consumer validates identically.
 */

import * as semver from 'semver'
import * as z from 'zod'

// ============================================================================
// Locales
// ============================================================================

/** Locales the catalog protocol supports. Stage 1 ships only these two. */
export const CatalogLocaleSchema = z.enum(['zh-CN', 'en-US'])
export type CatalogLocale = z.infer<typeof CatalogLocaleSchema>

/** The locale used when a requested locale has no translation. */
export const DEFAULT_CATALOG_LOCALE: CatalogLocale = 'zh-CN'

// ============================================================================
// Hashes and relative paths
// ============================================================================

const SHA256_REGEX = /^sha256:[0-9a-f]{64}$/

/** A `sha256:<64 hex lowercase>` digest. */
export const Sha256Schema = z.string().regex(SHA256_REGEX, 'must be "sha256:" followed by 64 lowercase hex characters')
export type Sha256 = z.infer<typeof Sha256Schema>

/**
 * A normalized relative path: no leading slash, no Windows drive, no `file:`
 * scheme, and no empty / `.` / `..` segments. Used for both logo and artifact
 * locations — the synchronizer resolves them against the snapshot root, and a
 * path that escapes it must be rejected before any filesystem call.
 */
export const RelativePathSchema = z
  .string()
  .min(1, 'location must not be empty')
  .refine((p) => !/^[\\/]/.test(p) && !/^[a-zA-Z]:[\\/]/.test(p), 'absolute path not allowed')
  .refine((p) => !p.toLowerCase().startsWith('file:'), 'file URL not allowed')
  .refine(
    (p) => p.split(/[\\/]/).every((seg) => seg.length > 0 && seg !== '.' && seg !== '..'),
    'path must have no empty, "." or ".." segments'
  )
export type RelativePath = z.infer<typeof RelativePathSchema>

// ============================================================================
// Enums shared by the protocol and the SQLite mirror
// ============================================================================

export const IndustryScopeSchema = z.enum(['universal', 'specific'])
export type IndustryScope = z.infer<typeof IndustryScopeSchema>

export const CatalogSkillStatusSchema = z.enum(['draft', 'published', 'disabled'])
export type CatalogSkillStatus = z.infer<typeof CatalogSkillStatusSchema>

/** Which release chain produced a mirrored row. */
export const SnapshotSourceSchema = z.enum(['bundled', 'override'])
export type SnapshotSource = z.infer<typeof SnapshotSourceSchema>

export const SyncStateStatusSchema = z.enum(['ready', 'failed'])
export type SyncStateStatus = z.infer<typeof SyncStateStatusSchema>

// ============================================================================
// Logo and artifact
// ============================================================================

export const SkillLogoSchema = z.object({
  type: z.enum(['snapshot']),
  location: RelativePathSchema,
  sha256: Sha256Schema
})
export type SkillLogo = z.infer<typeof SkillLogoSchema>

export const SkillArtifactSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('directory'),
    location: RelativePathSchema,
    version: z.string().min(1, 'version must not be empty'),
    sha256: Sha256Schema
  }),
  z.object({
    type: z.literal('archive'),
    location: RelativePathSchema,
    version: z.string().min(1, 'version must not be empty'),
    sha256: Sha256Schema
  })
])
export type SkillArtifact = z.infer<typeof SkillArtifactSchema>

// ============================================================================
// Translations
// ============================================================================

export const IndustryTranslationSchema = z.object({ name: z.string().min(1) })
export type IndustryTranslation = z.infer<typeof IndustryTranslationSchema>

export const ProfessionalDimensionTranslationSchema = z.object({ name: z.string().min(1) })
export type ProfessionalDimensionTranslation = z.infer<typeof ProfessionalDimensionTranslationSchema>

export const SkillTranslationSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1)
})
export type SkillTranslation = z.infer<typeof SkillTranslationSchema>

/**
 * A per-entity translation map. Keys are locales; every locale is optional so a
 * snapshot may ship a partial set and let the Data API fall back per the
 * protocol's whole-entity fallback rule. `z.record(enum, value)` would wrongly
 * require every locale, so we use an object of optional locale keys instead.
 */
const i18nObject = <V extends z.ZodTypeAny>(value: V) =>
  z.object({
    'zh-CN': value.optional(),
    'en-US': value.optional()
  })

export const IndustryTranslationsSchema = i18nObject(IndustryTranslationSchema)
export type IndustryTranslations = z.infer<typeof IndustryTranslationsSchema>

export const ProfessionalDimensionTranslationsSchema = i18nObject(ProfessionalDimensionTranslationSchema)
export type ProfessionalDimensionTranslations = z.infer<typeof ProfessionalDimensionTranslationsSchema>

export const SkillTranslationsSchema = i18nObject(SkillTranslationSchema)
export type SkillTranslations = z.infer<typeof SkillTranslationsSchema>

// ============================================================================
// Catalog entities
// ============================================================================

export const CatalogIndustrySchema = z.object({
  code: z.string().min(1),
  sortOrder: z.number().int().finite(),
  isEnabled: z.boolean(),
  translations: IndustryTranslationsSchema
})
export type CatalogIndustry = z.infer<typeof CatalogIndustrySchema>

export const CatalogProfessionalDimensionSchema = z.object({
  code: z.string().min(1),
  sortOrder: z.number().int().finite(),
  isEnabled: z.boolean(),
  translations: ProfessionalDimensionTranslationsSchema
})
export type CatalogProfessionalDimension = z.infer<typeof CatalogProfessionalDimensionSchema>

export const CatalogSkillSchema = z
  .object({
    id: z.string().min(1),
    industryScope: IndustryScopeSchema,
    industryCodes: z.array(z.string().min(1)),
    professionalDimensionCodes: z.array(z.string().min(1)),
    logo: SkillLogoSchema.nullable(),
    artifact: SkillArtifactSchema,
    status: CatalogSkillStatusSchema,
    sortOrder: z.number().int().finite(),
    translations: SkillTranslationsSchema
  })
  .superRefine((skill, ctx) => {
    if (skill.industryScope === 'universal' && skill.industryCodes.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'universal skills must not have industryCodes'
      })
    }
    if (skill.industryScope === 'specific' && skill.industryCodes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'specific skills must have at least one industryCode'
      })
    }
  })
export type CatalogSkill = z.infer<typeof CatalogSkillSchema>

// ============================================================================
// Catalog snapshot
// ============================================================================

export const SkillCatalogSnapshotSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    defaultLocale: CatalogLocaleSchema,
    supportedLocales: z.array(CatalogLocaleSchema).min(1),
    industries: z.array(CatalogIndustrySchema),
    professionalDimensions: z.array(CatalogProfessionalDimensionSchema),
    skills: z.array(CatalogSkillSchema)
  })
  .superRefine((catalog, ctx) => {
    const industryCodes = new Set<string>()
    for (const ind of catalog.industries) {
      if (industryCodes.has(ind.code)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate industry code: ${ind.code}` })
      }
      industryCodes.add(ind.code)
    }

    const pdCodes = new Set<string>()
    for (const pd of catalog.professionalDimensions) {
      if (pdCodes.has(pd.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate professional dimension code: ${pd.code}`
        })
      }
      pdCodes.add(pd.code)
    }

    const skillIds = new Set<string>()
    for (const skill of catalog.skills) {
      if (skillIds.has(skill.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate skill id: ${skill.id}` })
      }
      skillIds.add(skill.id)
    }

    if (!catalog.supportedLocales.includes(catalog.defaultLocale)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'defaultLocale must be in supportedLocales' })
    }

    for (const skill of catalog.skills) {
      for (const code of skill.industryCodes) {
        if (!industryCodes.has(code)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown industry code: ${code}` })
        }
      }
      for (const code of skill.professionalDimensionCodes) {
        if (!pdCodes.has(code)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `unknown professional dimension code: ${code}`
          })
        }
      }
    }

    // Only rows that are actually shown must carry the defaultLocale text.
    const def = catalog.defaultLocale
    const requiresDefault = (translations: Record<string, unknown>, label: string, ref: string) => {
      if (!translations[def]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} ${ref} is missing the defaultLocale (${def}) translation`
        })
      }
    }
    for (const ind of catalog.industries) {
      if (ind.isEnabled) requiresDefault(ind.translations, 'industry', ind.code)
    }
    for (const pd of catalog.professionalDimensions) {
      if (pd.isEnabled) requiresDefault(pd.translations, 'professional dimension', pd.code)
    }
    for (const skill of catalog.skills) {
      if (skill.status === 'published') requiresDefault(skill.translations, 'skill', skill.id)
    }
  })
export type SkillCatalogSnapshot = z.infer<typeof SkillCatalogSnapshotSchema>

// ============================================================================
// Manifest
// ============================================================================

export const CatalogManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  generatedAt: z.string(),
  minAppVersion: z.string().min(1),
  files: z.record(z.string(), z.string())
})
export type CatalogManifest = z.infer<typeof CatalogManifestSchema>

// ============================================================================
// Combined validation: manifest + catalog consistency + version compatibility
// ============================================================================

export interface CatalogValidationOptions {
  /** Current client version; when provided, the catalog's minAppVersion must be satisfied. */
  currentAppVersion?: string
}

export type CatalogValidationResult =
  | { ok: true; manifest: CatalogManifest; snapshot: SkillCatalogSnapshot }
  | { ok: false; errors: string[] }

export interface CatalogValidationOptionsShape {
  currentAppVersion?: string
}

/**
 * Validate a manifest + catalog pair as one indivisible published unit.
 *
 * A candidate snapshot is only usable when both documents parse under their own
 * schemas AND agree on `schemaVersion`/`revision`, AND the client is new enough
 * for `minAppVersion`. Any single failure rejects the whole pair — the loader
 * must never surface a partially valid catalog.
 */
export function validateSkillCatalog(
  manifest: unknown,
  snapshot: unknown,
  options: CatalogValidationOptions = {}
): CatalogValidationResult {
  const errors: string[] = []

  const parsedManifest = CatalogManifestSchema.safeParse(manifest)
  if (!parsedManifest.success) {
    errors.push(...parsedManifest.error.issues.map((i) => `manifest: ${i.path.join('.') || '<root>'}: ${i.message}`))
  }

  const parsedSnapshot = SkillCatalogSnapshotSchema.safeParse(snapshot)
  if (!parsedSnapshot.success) {
    errors.push(...parsedSnapshot.error.issues.map((i) => `catalog: ${i.path.join('.') || '<root>'}: ${i.message}`))
  }

  if (!parsedManifest.success || !parsedSnapshot.success) {
    return { ok: false, errors }
  }

  const m = parsedManifest.data
  const c = parsedSnapshot.data

  if (m.schemaVersion !== c.schemaVersion) {
    errors.push(`schemaVersion mismatch: manifest=${m.schemaVersion}, catalog=${c.schemaVersion}`)
  }
  if (m.revision !== c.revision) {
    errors.push(`revision mismatch: manifest=${m.revision}, catalog=${c.revision}`)
  }
  if (options.currentAppVersion !== undefined && !isVersionCompatible(m.minAppVersion, options.currentAppVersion)) {
    errors.push(`client ${options.currentAppVersion} is older than minAppVersion ${m.minAppVersion}`)
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return { ok: true, manifest: m, snapshot: c }
}

/** True when `current` is greater than or equal to `min` according to semver. */
export function isVersionCompatible(min: string, current: string): boolean {
  if (!semver.valid(min) || !semver.valid(current)) return false
  return semver.gte(current, min)
}
