/** Checks source and translated catalog values before changes merge. */
import * as fs from 'fs'
import * as path from 'path'

/** Catalogs are flat: every key is a dotted path mapping straight to its translated string. */
type I18N = { [key: string]: string }
type Glossary = { doNotTranslate: string[] }

const ROOT = path.resolve(__dirname, '..')
const BASE_LOCALE = process.env.TRANSLATION_BASE_LOCALE ?? 'en-us'
const CATALOG_DIRECTORIES = ['src/renderer/i18n/locales', 'src/main/i18n/locales']
const ALLOWED_EMPTY_SOURCE_KEYS = new Set(['src/renderer/i18n/locales:settings.provider.oauth.provided_by_suffix'])

const APPLICATION_BRAND_KEYS = new Set([
  'agent.builtin.cherry_support.diagnostics.prepared',
  'chat.default.name',
  'miniApp.detail.pending_hint',
  'miniApp.install.source_builtin',
  'ovms.description',
  'selection.settings.filter_modal.user_tips.windows',
  'settings.about.diagnostics.mail.subject',
  'settings.about.feedback.agent_error',
  'settings.data.app_data.select_error',
  'settings.data.clear_cache.waiting_for_legacy_database',
  'settings.data.s3.root.placeholder',
  'settings.data.siyuan.root_path_placeholder',
  'settings.dependencies.removeConfirmMessage',
  'settings.dependencies.removeDefinitionOnlyConfirmMessage',
  'settings.dependencies.removeRuntimeConfirmMessage',
  'settings.general.common.menu.presentation_mode.cherry',
  'settings.skills.enableToTry.description'
])

export const validateApplicationBrand = (key: string, value: string): string | null => {
  if (key === 'chat.default.name' && value !== 'MEA Cowork') {
    return 'default builtin Agent display name must be exactly "MEA Cowork"'
  }
  if (!APPLICATION_BRAND_KEYS.has(key)) return null
  return /cherry(?:[\s_-]*studio|[\s_-]*assistant|[\s_-]*support)?/iu.test(value)
    ? 'legacy Cherry application branding remains in a user-visible value'
    : null
}

const interpolations = (text: string) => (text.match(/{{[^}]*}}/g) ?? []).sort()
const tagPlaceholders = (text: string) => (text.match(/<\/?[\w-]+\s*\/?>/g) ?? []).sort()
const nestedKeys = (text: string) => (text.match(/\$t\([^)]*\)/g) ?? []).sort()

/** Case and separators vary legitimately: "Github", "MEA-Cowork-Diagnose". Spelling does not. */
const foldForTermMatch = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

export const validateSource = (source: string): string | null => {
  const text = source.trim()

  if (!text) return 'empty source value'
  if (/to be translated/i.test(text)) return 'placeholder marker leaked into the source locale'

  return null
}

export const validate = (english: string, translation: string, doNotTranslate: string[] = []): string | null => {
  const text = translation.trim()

  if (!text) return /[\p{L}\p{N}]/u.test(english) ? 'empty' : null
  if (/to be translated/i.test(text)) return 'placeholder marker leaked into the translation'
  if (text.startsWith('[') && !english.trim().startsWith('[')) {
    return 'starts with a bracketed note instead of the translation'
  }
  if (text.length > Math.max(80, english.length * 4)) {
    return 'suspiciously long - likely an explanation, not a translation'
  }

  const sameList = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b)
  if (!sameList(interpolations(english), interpolations(translation))) {
    return `interpolation mismatch: expected ${interpolations(english).join(' ') || '(none)'}`
  }
  if (!sameList(tagPlaceholders(english), tagPlaceholders(translation))) {
    return `tag placeholder mismatch: expected ${tagPlaceholders(english).join(' ') || '(none)'}`
  }
  if (!sameList(nestedKeys(english), nestedKeys(translation))) {
    return `$t() reference mismatch: expected ${nestedKeys(english).join(' ') || '(none)'}`
  }

  const foldedEnglish = foldForTermMatch(english)
  const foldedTranslation = foldForTermMatch(text)
  for (const term of doNotTranslate) {
    const foldedTerm = foldForTermMatch(term)
    if (foldedEnglish.includes(foldedTerm) && !foldedTranslation.includes(foldedTerm)) {
      return `dropped untranslatable term "${term}"`
    }
  }

  return null
}

const readJson = (filePath: string): I18N => JSON.parse(fs.readFileSync(filePath, 'utf-8'))

export const checkTranslationValues = (): { checked: number; failures: string[] } => {
  const glossary = JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n-glossary.json'), 'utf-8')) as Glossary
  const failures: string[] = []
  let checked = 0

  for (const catalogDirectory of CATALOG_DIRECTORIES) {
    const catalogPath = path.join(ROOT, catalogDirectory)
    const basePath = path.join(catalogPath, `${BASE_LOCALE}.json`)
    const base = readJson(basePath)

    for (const [key, source] of Object.entries(base)) {
      checked++
      const allowedEmpty = !source.trim() && ALLOWED_EMPTY_SOURCE_KEYS.has(`${catalogDirectory}:${key}`)
      const reason = allowedEmpty ? null : validateSource(source)
      if (reason) failures.push(`${catalogDirectory}/${BASE_LOCALE}.json ${key}: ${reason}`)
      const brandReason = validateApplicationBrand(key, source)
      if (brandReason) failures.push(`${catalogDirectory}/${BASE_LOCALE}.json ${key}: ${brandReason}`)
    }

    for (const filename of fs.readdirSync(catalogPath).filter((file) => file.endsWith('.json'))) {
      if (filename === `${BASE_LOCALE}.json`) continue

      const target = readJson(path.join(catalogPath, filename))
      for (const [key, translation] of Object.entries(target)) {
        const english = base[key]
        if (english === undefined) continue

        checked++
        const reason = validate(english, translation, glossary.doNotTranslate)
        if (reason) failures.push(`${catalogDirectory}/${filename} ${key}: ${reason}`)
        const brandReason = validateApplicationBrand(key, translation)
        if (brandReason) failures.push(`${catalogDirectory}/${filename} ${key}: ${brandReason}`)
      }
    }
  }

  return { checked, failures }
}
