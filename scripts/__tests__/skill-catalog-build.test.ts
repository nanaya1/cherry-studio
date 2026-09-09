import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  buildCatalog,
  type BuildResult,
  cjk,
  computeDirectorySha256,
  parseFrontmatter,
  type RawEntry,
  readExcelEntries
} from '../skill-catalog-build'

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'resources', 'skill-catalog', 'v1')

function sha256File(p: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

function walkForSymlinks(dir: string): string[] {
  const found: string[] = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name)
      if (fs.lstatSync(p).isSymbolicLink()) found.push(p)
      else if (e.isDirectory()) stack.push(p)
    }
  }
  return found
}

describe('computeDirectorySha256', () => {
  let tmp: string
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-hash-'))
  })
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('is deterministic and includes relative path + content', () => {
    const d = path.join(tmp, 'skill')
    fs.mkdirSync(path.join(d, 'refs'), { recursive: true })
    fs.writeFileSync(path.join(d, 'SKILL.md'), '# hi\n')
    fs.writeFileSync(path.join(d, 'refs', 'a.md'), 'alpha')
    const h1 = computeDirectorySha256(d)
    const h2 = computeDirectorySha256(d)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/)
    // changing content changes hash
    fs.writeFileSync(path.join(d, 'refs', 'a.md'), 'beta')
    expect(computeDirectorySha256(d)).not.toBe(h1)
    // reordering files must not change hash (sorted by rel path)
    const d2 = path.join(tmp, 'skill2')
    fs.mkdirSync(path.join(d2, 'refs'), { recursive: true })
    fs.writeFileSync(path.join(d2, 'refs', 'a.md'), 'beta')
    fs.writeFileSync(path.join(d2, 'SKILL.md'), '# hi\n')
    expect(computeDirectorySha256(d2)).toBe(computeDirectorySha256(d))
  })

  it('rejects symlinks', () => {
    const d = path.join(tmp, 'withlink')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'SKILL.md'), '# ok\n')
    const linkTarget = path.join(tmp, 'target.txt')
    fs.writeFileSync(linkTarget, 'x')
    fs.symlinkSync(linkTarget, path.join(d, 'evil'))
    expect(() => computeDirectorySha256(d)).toThrow(/symlink/i)
  })
})

describe('parseFrontmatter', () => {
  it('parses a simple name/description', () => {
    const fm = '---\nname: browser-use\ndescription: "Direct browser control."\n---\n# Body'
    const r = parseFrontmatter(fm)
    expect(r.name).toBe('browser-use')
    expect(r.description).toBe('Direct browser control.')
  })

  it('parses YAML block scalars (| and >)', () => {
    const fm = '---\nname: x\ndescription: |\n  line one\n  line two\nother: v\n---\n'
    const r = parseFrontmatter(fm)
    expect(r.description).toContain('line one')
    expect(r.description).toContain('line two')
  })

  it('recovers from a malformed description that runs into the next key', () => {
    // production-scheduling-niloy style: missing newline before `license:`
    const fm = '---\nname: production-scheduling\ndescription: 中文描述。license: Apache-2.0\nversion: 1.0.0\n---\n'
    const r = parseFrontmatter(fm)
    expect(r.name).toBe('production-scheduling')
    expect(r.description).toBe('中文描述。')
    expect(r.description).not.toContain('license:')
  })
})

describe('cjk helper', () => {
  it('detects Chinese characters', () => {
    expect(cjk('中文')).toBe(true)
    expect(cjk('English text')).toBe(false)
    expect(cjk('NSGA-II multi-objective')).toBe(false)
  })
})

describe('buildCatalog (fixture, no external deps)', () => {
  let tmp: string
  let sourceDir: string
  let logosDir: string
  let outDir: string
  let result: BuildResult

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-build-'))
    sourceDir = path.join(tmp, 'source')
    logosDir = path.join(tmp, 'logos-src')
    outDir = path.join(tmp, 'out')
    fs.mkdirSync(path.join(sourceDir, 'alpha', 'refs'), { recursive: true })
    fs.writeFileSync(
      path.join(sourceDir, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: English description for alpha.\n---\n'
    )
    fs.writeFileSync(path.join(sourceDir, 'alpha', 'refs', 'a.md'), 'data')
    // aggregate: no root SKILL.md, has two sub-skills
    fs.mkdirSync(path.join(sourceDir, 'agg', 'sub1'), { recursive: true })
    fs.mkdirSync(path.join(sourceDir, 'agg', 'sub2'), { recursive: true })
    fs.writeFileSync(path.join(sourceDir, 'agg', 'sub1', 'SKILL.md'), '# s1')
    fs.writeFileSync(path.join(sourceDir, 'agg', 'sub2', 'SKILL.md'), '# s2')
    fs.mkdirSync(logosDir, { recursive: true })
    fs.writeFileSync(path.join(logosDir, 'alpha.png'), 'PNGDATA')

    const entries: RawEntry[] = [
      { seq: 1, zhName: '阿尔法', zhDesc: '阿尔法描述', industryText: '航空航天', dimText: '研发设计', link: '' },
      { seq: 2, zhName: '聚合', zhDesc: '聚合描述', industryText: '全行业', dimText: '研发设计', link: '' },
      { seq: 3, zhName: '无包', zhDesc: '无包描述', industryText: '全行业', dimText: '研发设计', link: '' },
      { seq: 4, zhName: 'FAA总包', zhDesc: 'faa', industryText: '航空航天', dimText: '研发设计', link: '' }
    ]

    result = buildCatalog(entries, {
      sourceSkillsDir: sourceDir,
      logosSourceDir: logosDir,
      outDir,
      entryDirMap: { 1: 'alpha', 2: 'agg', 3: '__no_dir__', 4: '__faa_aggregate__' },
      enDescOverride: {},
      logoMap: { alpha: 'alpha.png' }
    })
  })
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('publishes only the strictly-verifiable skill', () => {
    expect(result.published).toEqual(['alpha'])
    expect(result.unresolved.map((u) => u.seq)).toContain(3)
    const blockedSeqs = result.blocking.map((b) => b.seq)
    expect(blockedSeqs).toContain(2)
    expect(blockedSeqs).toContain(4)
  })

  it('emits catalog.json + manifest.json with manifest bound to catalog hash', () => {
    const catalogPath = path.join(outDir, 'catalog.json')
    const manifestPath = path.join(outDir, 'manifest.json')
    expect(fs.existsSync(catalogPath)).toBe(true)
    expect(fs.existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    expect(manifest.files['catalog.json']).toBe(sha256File(catalogPath))
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
    expect(catalog.schemaVersion).toBe(1)
    expect(catalog.revision).toBe(1)
    expect(catalog.skills).toHaveLength(1)
  })

  it('artifact hash matches a recomputation and packages are copied without symlinks', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(outDir, 'catalog.json'), 'utf8'))
    const skill = catalog.skills[0]
    const pkgDir = path.join(outDir, skill.artifact.location)
    expect(fs.existsSync(pkgDir)).toBe(true)
    expect(skill.artifact.sha256).toBe(computeDirectorySha256(pkgDir))
    expect(walkForSymlinks(pkgDir)).toHaveLength(0)
    // aggregate dir must NOT be copied
    expect(fs.existsSync(path.join(outDir, 'packages', 'agg'))).toBe(false)
  })

  it('logo is copied and hashed when a mapping exists', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(outDir, 'catalog.json'), 'utf8'))
    const skill = catalog.skills[0]
    expect(skill.logo).not.toBeNull()
    expect(skill.logo.location).toBe('logos/alpha.png')
    const logoPath = path.join(outDir, skill.logo.location)
    expect(fs.existsSync(logoPath)).toBe(true)
    expect(skill.logo.sha256).toBe(sha256File(logoPath))
  })

  it('translations contain zh-CN and en-US with no empty description', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(outDir, 'catalog.json'), 'utf8'))
    const t = catalog.skills[0].translations
    expect(t['zh-CN'].name).toBe('阿尔法')
    expect(t['en-US'].name).toBe('alpha')
    expect(t['en-US'].description.length).toBeGreaterThan(0)
  })
})

describe('readExcelEntries', () => {
  it('reads the real sedimentation template without modifying it', async () => {
    const xlsx = '/Users/nanaya/Downloads/skills沉淀模板.xlsx'
    if (!fs.existsSync(xlsx)) return // skip when source not present
    const entries = await readExcelEntries(xlsx)
    // 35 numbered rows exist
    expect(entries.length).toBe(35)
    const seqs = entries.map((e) => e.seq).sort((a, b) => a - b)
    expect(seqs[0]).toBe(1)
    expect(seqs[seqs.length - 1]).toBe(35)
  })
})

describe('generated v1 snapshot (resources/skill-catalog/v1)', () => {
  const present = fs.existsSync(SNAPSHOT_DIR)

  it('exists (run `pnpm tsx scripts/skill-catalog-build.ts` first)', () => {
    expect(present).toBe(true)
  })

  if (present) {
    const catalog = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'catalog.json'), 'utf8'))
    const manifest = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'manifest.json'), 'utf8'))

    it('manifest binds the catalog hash', () => {
      expect(manifest.files['catalog.json']).toBe(sha256File(path.join(SNAPSHOT_DIR, 'catalog.json')))
    })

    it('has 32 published skills, every one with a verifiable artifact', () => {
      expect(catalog.skills).toHaveLength(32)
      for (const s of catalog.skills) {
        expect(s.status).toBe('published')
        const pkgDir = path.join(SNAPSHOT_DIR, s.artifact.location)
        expect(fs.existsSync(pkgDir), `package dir ${s.artifact.location}`).toBe(true)
        const rootSkills = fs.readdirSync(pkgDir).filter((f) => f === 'SKILL.md')
        expect(rootSkills, `unique root SKILL.md in ${s.id}`).toHaveLength(1)
        expect(s.artifact.sha256).toBe(computeDirectorySha256(pkgDir))
        expect(walkForSymlinks(pkgDir)).toHaveLength(0)
        // translations present for default locale
        expect(s.translations['zh-CN'].name.length).toBeGreaterThan(0)
        expect(s.translations['zh-CN'].description.length).toBeGreaterThan(0)
        expect(s.translations['en-US'].description.length).toBeGreaterThan(0)
      }
    }, 120_000)

    it('industryScope is consistent with industryCodes', () => {
      const codes = new Set(catalog.industries.map((i: any) => i.code))
      for (const s of catalog.skills) {
        if (s.industryScope === 'universal') expect(s.industryCodes).toEqual([])
        else for (const c of s.industryCodes) expect(codes.has(c)).toBe(true)
        for (const c of s.professionalDimensionCodes) {
          expect(catalog.professionalDimensions.map((d: any) => d.code).includes(c)).toBe(true)
        }
      }
    })

    it('logos are copied, hashed, and verified', () => {
      for (const s of catalog.skills) {
        if (!s.logo) continue
        const p = path.join(SNAPSHOT_DIR, s.logo.location)
        expect(fs.existsSync(p), `logo ${s.logo.location}`).toBe(true)
        expect(s.logo.sha256).toBe(sha256File(p))
      }
    })
  }
})
