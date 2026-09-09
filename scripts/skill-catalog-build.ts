/**
 * skill-catalog-build
 * -------------------
 * One-time data-preparation generator for the bundled skill catalog snapshot at
 * `resources/skill-catalog/v1`. It reads the sedimentation template Excel and the
 * downloaded skill packages, validates each package against the catalog protocol
 * (unique root SKILL.md, no symlinks, regular files only), computes deterministic
 * SHA-256 content hashes, copies packages + logos into the snapshot, and writes
 * `catalog.json` + `manifest.json`.
 *
 * Hard rules (per the catalog design spec + task brief):
 *  - A published skill MUST point at an installable directory containing exactly
 *    ONE root SKILL.md. Directories that fail this (e.g. the `faa-series` aggregate)
 *    are reported as blocking and NEVER faked.
 *  - Entries with no installable package directory are reported as unresolved.
 *  - Nothing is guessed: unknown/ambiguous mappings abort that entry.
 *  - The source `Downloads/skills` and the Excel are read-only; this script only
 *    WRITES into `resources/skill-catalog/v1`.
 *
 * Run: `pnpm tsx scripts/skill-catalog-build.ts`
 * Override inputs with env: SKILL_XLSX, SKILL_SOURCE_DIR
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { XMLParser } from 'fast-xml-parser'
import JSZip from 'jszip'
import YAML from 'yaml'

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_XLSX = process.env.SKILL_XLSX || '/Users/nanaya/Downloads/skills沉淀模板.xlsx'
const DEFAULT_SOURCE = process.env.SKILL_SOURCE_DIR || '/Users/nanaya/Downloads/skills'
const LOGOS_SOURCE_DIR = path.join(REPO_ROOT, '.workbuddy', 'design', 'skill-logos')
const OUT_DIR = path.join(REPO_ROOT, 'resources', 'skill-catalog', 'v1')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface RawEntry {
  seq: number
  zhName: string
  zhDesc: string
  industryText: string
  dimText: string
  link: string
}

export interface BlockedEntry {
  seq: number
  dir?: string
  reason: string
}
export interface UnresolvedEntry {
  seq: number
  reason: string
}
export interface BuildResult {
  catalog: any
  manifest: any
  published: string[]
  blocking: BlockedEntry[]
  unresolved: UnresolvedEntry[]
}

// ---------------------------------------------------------------------------
// Curated, verified mapping: Excel row number -> package directory (stable id)
// Disambiguation of the three "生产排程" rows uses the download link owner:
//   #6  ComeOnOliver -> production-scheduling-comeonoliver
//   #14 sickn33       -> production-scheduling-sickn33
//   #21 niloykumarbarman -> production-scheduling-niloy
// Sentinel values mark entries that cannot be published without a decision.
// ---------------------------------------------------------------------------
const NO_DIR = '__no_dir__'
const FAA_AGGREGATE = '__faa_aggregate__'
const ENTRY_DIR: Record<number, string> = {
  1: 'ui-ux-pro-max',
  2: NO_DIR, // 航空航天AI总工程师Skills库 — no package directory in Downloads/skills
  3: 'image-to-editable-ppt',
  4: FAA_AGGREGATE, // faa-series — aggregate, no unique root SKILL.md
  5: 'nist-stat-handbook',
  6: 'production-scheduling-comeonoliver',
  7: 'capacity-planner',
  8: 'smart-scheduling-optimization',
  9: 'troubleshoot-print-issues',
  10: '5s-implementation',
  11: 'supplier-risk-agent',
  12: 'statistical-analysis',
  13: 'quality-nonconformance',
  14: 'production-scheduling-sickn33',
  15: 'iso-9001-internal-audit',
  16: 'browser-use',
  17: 'quarry-rock-splitter',
  18: 'patent-quality-review-pro',
  19: 'aircraft-structure-assembler',
  20: 'feishu-task',
  21: 'production-scheduling-niloy',
  22: 'manufacturing-doc-writer',
  23: 'academic-paper',
  24: 'equipment-telematics',
  25: 'curriculum-knowledge-architecture-designer',
  26: 'scholar-search',
  27: 'molecular-dynamics',
  28: 'scientific-brainstorming',
  29: 'mesh-generation',
  30: 'composite-structures',
  31: 'text-to-cad',
  32: 'predictive-maintenance',
  33: NO_DIR, // 投标材料审核-基于自定义规则 — personal creation, no package directory
  34: 'proposal-writer',
  35: 'specification-extractor'
}

// Industry text (from Excel column C) -> scope + codes.
const INDUSTRY_LOOKUP: Record<string, { scope: string; codes: string[] }> = {
  全行业: { scope: 'universal', codes: [] },
  航空航天: { scope: 'specific', codes: ['aerospace'] },
  工程机械: { scope: 'specific', codes: ['construction-machinery'] },
  能源化工: { scope: 'specific', codes: ['energy-chemical'] },
  '': { scope: 'specific', codes: ['uncategorized'] }
}

// Professional-dimension text (Excel column D, comma-separated) -> stable code.
const DIMENSION_LOOKUP: Record<string, string> = {
  研发设计: 'rnd-design',
  生产制造: 'manufacturing',
  运维服务: 'ops-service',
  经营管理: 'business-mgmt'
}

// Logo filename (in .workbuddy/design/skill-logos) per stable id. Only confident,
// verified correspondences are mapped; everything else is left null (first-letter fallback).
const LOGO_MAP: Record<string, string> = {
  'browser-use': 'browser-use.png',
  'feishu-task': 'feishu.png',
  'patent-quality-review-pro': 'patsnap.png',
  'predictive-maintenance': 'aws.png',
  'scholar-search': 'openalex.png'
}

// Accurate English translations for skills whose SKILL.md description is missing or
// entirely in Chinese (zh-CN from the Excel is the source of truth to translate from).
const EN_DESC_OVERRIDE: Record<string, string> = {
  'academic-paper':
    'Systematized literature review: multi-database retrieval, thematic synthesis, and citation-by-citation verification, outputting Markdown and PDF; paired with database skills such as gget and bioservices as academic data sources.',
  'feishu-task':
    "Feishu (Lark) task management tool for creating, querying, and updating tasks and checklists. Use this skill when: (1) creating, querying, or updating tasks; (2) creating or managing task checklists; (3) viewing task lists or checklist items; (4) the user mentions '任务', '待办', 'to-do', '清单', or 'task'; (5) setting task owners, followers, due dates, or adding members; (6) appending task step records (Task steps); (7) uploading task attachments (supports task / task_delivery); (8) registering or updating an agent (register / update_profile).",
  'image-to-editable-ppt':
    'Quickly generate and convert images into element-complete, editable PowerPoint presentations.',
  'manufacturing-doc-writer': 'Use when writing manufacturing process documents and production flow descriptions.',
  'patent-quality-review-pro':
    "Patent application document quality review tool (full-indicator edition). Upload a PDF or Word patent application document; it automatically evaluates all review indicators uniformly (no priority / non-priority tiering) and assists judgment using common decision points from re-examination and invalidation practice, by default generating an HTML 'Patent Application Document Quality Evaluation Form' (main form + appendix 1, with appendices 2/3 as needed); it generates a Word file only when explicitly requested. Supports automatic switching among AHP weighting schemes for the chemistry / mechanical / electrical / general domains. (Patsnap)",
  'production-scheduling-niloy':
    'Provides codified expert knowledge for production scheduling, job sequencing, line balancing, changeover optimization, and bottleneck resolution in discrete and batch manufacturing. Based on the knowledge of a production scheduler with 15+ years of experience. Includes theory of constraints / drum-buffer-rope, SMED quick changeover, OEE analysis, disruption-response frameworks, and ERP / MES interaction patterns. Applies when scheduling production, resolving bottlenecks, optimizing changeovers, responding to disruptions, or balancing manufacturing lines.',
  'smart-scheduling-optimization':
    "Intelligent scheduling optimization based on the NSGA-II multi-objective genetic algorithm, for production scheduling, resource allocation, and multi-objective optimization scenarios. Suitable for needs such as 'optimized production scheduling', 'scheduling algorithms', 'multi-objective optimization', and 'genetic-algorithm scheduling'."
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function cjk(s: string | undefined | null): boolean {
  return typeof s === 'string' && /[一-鿿]/.test(s)
}

export function computeFileSha(p: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

/**
 * Deterministic directory content hash.
 * Walks all regular files (rejects symlinks and non-regular files), sorts relative
 * paths with '/', and folds each (relativePath + NUL + content) into one SHA-256.
 */
export function computeDirectorySha256(dir: string): string {
  const files: string[] = []
  const walk = (cur: string) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name)
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) throw new Error(`symlink rejected: ${p}`)
      if (st.isDirectory()) walk(p)
      else if (st.isFile()) files.push(p)
      else throw new Error(`non-regular file rejected: ${p}`)
    }
  }
  walk(dir)
  const rels = files
    .map((f) => path.relative(dir, f).split(path.sep).join('/'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const h = crypto.createHash('sha256')
  for (const rel of rels) {
    h.update(rel)
    h.update('\0')
    h.update(fs.readFileSync(path.join(dir, rel)))
    h.update('\0')
  }
  return 'sha256:' + h.digest('hex')
}

/** Robust SKILL.md frontmatter parser: YAML first, line-based fallback for malformed files. */
export function parseFrontmatter(content: string): { name?: string; description?: string; version?: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const fm = m[1]
  try {
    const data = YAML.parse(fm)
    if (data && typeof data === 'object') {
      const name = typeof data.name === 'string' ? data.name : undefined
      const version = data.version == null ? undefined : String(data.version).trim() || undefined
      let description: string | undefined
      if (typeof data.description === 'string') description = data.description
      else if (data.description != null) description = String(data.description)
      return { name, description, version }
    }
  } catch {
    // fall through to line-based parsing
  }
  let name: string | undefined
  let description: string | undefined
  let version: string | undefined
  const lines = fm.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const nm = line.match(/^name:\s*(.*)$/)
    if (nm && name === undefined) {
      name = stripQuotes((nm[1] ?? '').trim())
      continue
    }
    const vm = line.match(/^version:\s*(.*)$/)
    if (vm && version === undefined) {
      version = stripQuotes((vm[1] ?? '').trim()) || undefined
      continue
    }
    const dm = line.match(/^description:\s*((\||>|-|\+)(-|\+)?)?\s*(.*)$/)
    if (dm) {
      const indicator = dm[1]
      if (indicator) {
        // block scalar: collect indented lines
        const body: string[] = []
        let j = i + 1
        while (j < lines.length && (/^\s+/.test(lines[j]) || lines[j].trim() === '')) {
          if (lines[j].trim() !== '') body.push(lines[j].replace(/^\s+/, ''))
          j++
        }
        const folded = indicator.startsWith('>')
        description = (folded ? body.join(' ') : body.join('\n')).trim()
        i = j - 1
      } else {
        let val = stripQuotes((dm[4] ?? '').trim())
        // malformed plain scalar that ran into the next key, e.g. "…。license: Apache-2.0"
        const bad = val.match(/。[A-Za-z][\w-]*:\s/)
        if (bad) val = val.slice(0, bad.index! + 1)
        description = val.trim()
      }
    }
  }
  return { name, description, version }
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    const st = fs.lstatSync(s)
    if (st.isSymbolicLink()) throw new Error(`symlink rejected during copy: ${s}`)
    if (st.isDirectory()) copyDir(s, d)
    else if (st.isFile()) fs.copyFileSync(s, d)
    else throw new Error(`unsupported file type during copy: ${s}`)
  }
}

// ---------------------------------------------------------------------------
// Excel reading (read-only; never writes to the source workbook)
// Manual parser built on jszip + fast-xml-parser. We avoid exceljs because its
// shared-string reader crashes on this particular workbook ("Cannot create
// property 'richText' on string ''"). Concatenating runs yields the same text.
// ---------------------------------------------------------------------------
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (entity, hex: string) => {
      const codePoint = Number.parseInt(hex, 16)
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity
    })
    .replace(/&#([0-9]+);/g, (entity, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10)
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function normalizeExcelText(value: unknown, preserveLineBreaks = false): string {
  const decoded = decodeXmlEntities(String(value ?? '')).replace(/\r\n?/g, '\n')

  if (!preserveLineBreaks) return decoded.replace(/\s+/g, ' ').trim()
  return decoded
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

function collectText(node: any): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  if (typeof node !== 'object') return String(node)
  if (node['#text'] != null) return typeof node['#text'] === 'string' ? node['#text'] : collectText(node['#text'])
  if (node.t != null) return collectText(node.t)
  if (node.r != null) return collectText(node.r)
  for (const k of Object.keys(node)) {
    if (k.startsWith('@_')) continue
    const v = node[k]
    if (typeof v === 'object') {
      const r = collectText(v)
      if (r) return r
    }
  }
  return ''
}

export async function readExcelEntries(xlsxPath: string): Promise<RawEntry[]> {
  const buf = await fs.promises.readFile(xlsxPath)
  const zip = await JSZip.loadAsync(buf)

  // shared strings
  const shared: string[] = []
  const ssFile = zip.file('xl/sharedStrings.xml')
  if (ssFile) {
    const xml = await ssFile.async('string')
    const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
    const obj = p.parse(xml)
    const sis = obj.sst?.si
    const arr = Array.isArray(sis) ? sis : sis ? [sis] : []
    for (const si of arr) shared.push(collectText(si))
  }

  // worksheets: prefer sheet1.xml, else the first worksheet file
  const names = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d*\.xml$/i.test(n))
  const sheetName = names.find((n) => /sheet1\.xml$/i.test(n)) ?? names.sort()[0]
  if (!sheetName) throw new Error('no worksheet found in xlsx')
  const sheetXml = await zip.file(sheetName)!.async('string')
  const sp = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const sobj = sp.parse(sheetXml)
  const rows = sobj.worksheet?.sheetData?.row
  const rowArr = Array.isArray(rows) ? rows : rows ? [rows] : []

  const entries: RawEntry[] = []
  for (const row of rowArr) {
    const cells = row.c
    const cellArr = Array.isArray(cells) ? cells : cells ? [cells] : []
    const map: Record<string, string> = {}
    for (const c of cellArr) {
      const ref: string = c['@_r'] ?? c.r ?? ''
      if (!ref) continue
      const col = ref.replace(/[0-9]/g, '')
      const t: string = c['@_t'] ?? c.t ?? ''
      let val = ''
      if (t === 's') {
        const idx = parseInt(String(c.v ?? c['#text'] ?? '0'), 10)
        val = shared[idx] ?? ''
      } else if (t === 'inlineStr') {
        val = collectText(c.is)
      } else {
        val = c.v ?? c['#text'] ?? ''
      }
      map[col] = String(val)
    }
    const seq = Number(normalizeExcelText(map['A']))
    if (!Number.isFinite(seq) || seq <= 0) continue
    const zhName = normalizeExcelText(map['F'])
    if (!zhName) continue // stub rows (e.g. auto-numbered A with no skill name)
    entries.push({
      seq,
      zhName,
      zhDesc: normalizeExcelText(map['H'], true),
      industryText: normalizeExcelText(map['C']),
      dimText: normalizeExcelText(map['D']),
      link: normalizeExcelText(map['J'])
    })
  }
  entries.sort((a, b) => a.seq - b.seq)
  return entries
}

// ---------------------------------------------------------------------------
// Catalog assembly
// ---------------------------------------------------------------------------
const INDUSTRIES = [
  {
    code: 'aerospace',
    sortOrder: 10,
    isEnabled: true,
    translations: { 'zh-CN': { name: '航空航天' }, 'en-US': { name: 'Aerospace' } }
  },
  {
    code: 'construction-machinery',
    sortOrder: 20,
    isEnabled: true,
    translations: { 'zh-CN': { name: '工程机械' }, 'en-US': { name: 'Construction Machinery' } }
  },
  {
    code: 'energy-chemical',
    sortOrder: 30,
    isEnabled: true,
    translations: { 'zh-CN': { name: '能源化工' }, 'en-US': { name: 'Energy and Chemical' } }
  },
  {
    code: 'uncategorized',
    sortOrder: 40,
    isEnabled: true,
    translations: { 'zh-CN': { name: '待分类' }, 'en-US': { name: 'Uncategorized' } }
  }
]
const PROFESSIONAL_DIMENSIONS = [
  {
    code: 'rnd-design',
    sortOrder: 10,
    isEnabled: true,
    translations: { 'zh-CN': { name: '研发设计' }, 'en-US': { name: 'Research and Design' } }
  },
  {
    code: 'manufacturing',
    sortOrder: 20,
    isEnabled: true,
    translations: { 'zh-CN': { name: '生产制造' }, 'en-US': { name: 'Manufacturing' } }
  },
  {
    code: 'ops-service',
    sortOrder: 30,
    isEnabled: true,
    translations: { 'zh-CN': { name: '运维服务' }, 'en-US': { name: 'Operations and Service' } }
  },
  {
    code: 'business-mgmt',
    sortOrder: 40,
    isEnabled: true,
    translations: { 'zh-CN': { name: '经营管理' }, 'en-US': { name: 'Business Management' } }
  }
]

export function buildCatalog(
  rawEntries: RawEntry[],
  opts: {
    sourceSkillsDir: string
    logosSourceDir: string
    outDir: string
    entryDirMap?: Record<number, string>
    enDescOverride?: Record<string, string>
    logoMap?: Record<string, string>
  }
): BuildResult {
  const entryDirMap = opts.entryDirMap ?? ENTRY_DIR
  const enDescOverride = opts.enDescOverride ?? EN_DESC_OVERRIDE
  const logoMap = opts.logoMap ?? LOGO_MAP
  const { sourceSkillsDir, logosSourceDir, outDir } = opts

  const packagesDir = path.join(outDir, 'packages')
  const logosDir = path.join(outDir, 'logos')
  fs.mkdirSync(packagesDir, { recursive: true })
  fs.mkdirSync(logosDir, { recursive: true })

  const skills: any[] = []
  const published: string[] = []
  const blocking: BlockedEntry[] = []
  const unresolved: UnresolvedEntry[] = []

  for (const e of rawEntries) {
    const dir = entryDirMap[e.seq]
    if (dir === undefined) {
      unresolved.push({ seq: e.seq, reason: 'no directory mapping for this Excel row' })
      continue
    }
    if (dir === NO_DIR) {
      unresolved.push({
        seq: e.seq,
        reason: 'no installable package directory available (not present in source skills)'
      })
      continue
    }
    if (dir === FAA_AGGREGATE) {
      blocking.push({
        seq: e.seq,
        dir,
        reason:
          'aggregate directory: contains many sub-skills and no unique root SKILL.md; needs a human decision on how to split into publishable skills'
      })
      continue
    }

    const srcDir = path.join(sourceSkillsDir, dir)
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      blocking.push({ seq: e.seq, dir, reason: 'package directory missing in source' })
      continue
    }
    // exactly one root SKILL.md
    const rootSkills = fs.readdirSync(srcDir).filter((f) => f === 'SKILL.md')
    if (rootSkills.length !== 1) {
      blocking.push({
        seq: e.seq,
        dir,
        reason: `expected exactly one root SKILL.md, found ${rootSkills.length}`
      })
      continue
    }

    // hash (also rejects symlinks / non-regular files)
    let dirHash: string
    try {
      dirHash = computeDirectorySha256(srcDir)
    } catch (err) {
      blocking.push({ seq: e.seq, dir, reason: `content hash rejected: ${(err as Error).message}` })
      continue
    }

    // copy package
    const outPkg = path.join(packagesDir, dir)
    fs.rmSync(outPkg, { recursive: true, force: true })
    copyDir(srcDir, outPkg)

    // extract en-US name/description from SKILL.md
    const fm = parseFrontmatter(fs.readFileSync(path.join(srcDir, 'SKILL.md'), 'utf8'))
    const enName = fm.name && !cjk(fm.name) ? fm.name : dir
    const enDesc =
      fm.description && fm.description.trim() && !cjk(fm.description) ? fm.description : enDescOverride[dir]
    if (!enDesc) {
      blocking.push({
        seq: e.seq,
        dir,
        reason: 'no English description available and no translation provided (refusing to guess)'
      })
      continue
    }

    // industry + dimensions
    const ind = INDUSTRY_LOOKUP[e.industryText] ?? INDUSTRY_LOOKUP['']
    const dimCodes = e.dimText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((d) => DIMENSION_LOOKUP[d])
      .filter(Boolean)

    // logo
    let logo: any = null
    const logoFile = logoMap[dir]
    if (logoFile) {
      const lp = path.join(logosSourceDir, logoFile)
      if (fs.existsSync(lp)) {
        fs.copyFileSync(lp, path.join(logosDir, logoFile))
        logo = { type: 'snapshot', location: `logos/${logoFile}`, sha256: computeFileSha(lp) }
      }
    }

    skills.push({
      id: dir,
      industryScope: ind.scope,
      industryCodes: ind.codes,
      professionalDimensionCodes: dimCodes,
      logo,
      artifact: { type: 'directory', location: `packages/${dir}`, version: fm.version ?? 'unknown', sha256: dirHash },
      status: 'published',
      sortOrder: e.seq,
      translations: {
        'zh-CN': { name: e.zhName, description: e.zhDesc },
        'en-US': { name: enName, description: enDesc }
      }
    })
    published.push(dir)
  }

  skills.sort((a, b) => a.sortOrder - b.sortOrder)

  const catalog = {
    schemaVersion: 1,
    revision: 1,
    defaultLocale: 'zh-CN',
    supportedLocales: ['zh-CN', 'en-US'],
    industries: INDUSTRIES,
    professionalDimensions: PROFESSIONAL_DIMENSIONS,
    skills
  }

  const catalogJson = JSON.stringify(catalog, null, 2) + '\n'
  const catalogHash = 'sha256:' + crypto.createHash('sha256').update(catalogJson).digest('hex')
  fs.writeFileSync(path.join(outDir, 'catalog.json'), catalogJson)

  const manifest = {
    schemaVersion: 1,
    revision: 1,
    generatedAt: '2026-09-09T00:00:00Z',
    minAppVersion: '1.0.0',
    files: { 'catalog.json': catalogHash }
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  return { catalog, manifest, published, blocking, unresolved }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main() {
  const xlsx = DEFAULT_XLSX
  const source = DEFAULT_SOURCE
  if (!fs.existsSync(xlsx)) {
    console.error(`[skill-catalog-build] Excel not found: ${xlsx}`)
    process.exit(2)
  }
  if (!fs.existsSync(source)) {
    console.error(`[skill-catalog-build] source skills dir not found: ${source}`)
    process.exit(2)
  }
  const entries = await readExcelEntries(xlsx)
  const res = buildCatalog(entries, {
    sourceSkillsDir: source,
    logosSourceDir: LOGOS_SOURCE_DIR,
    outDir: OUT_DIR
  })

  console.log('=== skill-catalog v1 build report ===')
  console.log(`published : ${res.published.length}`)
  res.published.forEach((id) => console.log(`  + ${id}`))
  console.log(`blocking  : ${res.blocking.length}`)
  res.blocking.forEach((b) => console.log(`  ! seq#${b.seq} ${b.dir ?? ''} — ${b.reason}`))
  console.log(`unresolved: ${res.unresolved.length}`)
  res.unresolved.forEach((u) => console.log(`  ? seq#${u.seq} — ${u.reason}`))
  console.log(`outputs   : ${OUT_DIR}`)
}

// When run directly (tsx / node), execute main. Guard against test imports.
const invoked = process.argv[1] || ''
const isMain = invoked.endsWith('skill-catalog-build.ts') || invoked.endsWith('skill-catalog-build.js')
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
