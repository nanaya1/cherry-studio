import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
/**
 * [enterprise] T0 企业扩展 - 技能目录：企业下发 → hash 校验 → 复用 SkillService 安装
 * 生命周期事件上报（install/exec）走 OrgApiClient。
 * C1/C2/C4 扩展：启动扫描自动更新、停用拦截（TTL 缓存）、删除上报、状态记录（OrgStateStore）。
 */
import { createReadStream } from 'node:fs'
// import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { application } from '@application'
import { agentGlobalSkillService } from '@data/services/AgentGlobalSkillService'
import { loggerService } from '@logger'
import {
  extractZip,
  assertSkillDirectoryWithinLimits,
  validateRepositorySkillDirectory
} from '@main/ai/skills/skillArchive'
import { profileSwitchFence } from '@main/core/profiles'

import { javaResourceKey, parseJavaResourceKey } from './JavaResourceIdentity'
import { getOrgApiBaseUrl } from './OrgApiClient'
import type { OrgAuthManager } from './OrgAuthManager'
import { orgStateStore } from './OrgStateStore'
import type { OrgSkillCatalogItem, OrgSkillFacet, RawOrgSkillFacet } from './types'

const execFileAsync = promisify(execFile)
const logger = loggerService.withContext('OrgSkillCatalog')

/** C2 目录缓存 TTL：企业停用技能后最多 5 分钟生效到"不注入新会话" */
// const CATALOG_TTL_MS = 5 * 60 * 1000 // 分组目录不可跨请求复用旧授权结果

/**
 * [enterprise] 归一化服务端 tags/categories：线上为纯字符串数组（["规范"]），
 * 管理台文档样例为对象数组（{code,name,…}）。字符串形态用值本身兼任 code/name，
 * 去重键才稳定；无法提取名称的项丢弃。
 */
function normalizeFacets(raw: RawOrgSkillFacet[] | undefined): OrgSkillFacet[] {
  if (!Array.isArray(raw)) return []
  const facets: OrgSkillFacet[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) facets.push({ code: item, name: item })
    } else if (item && typeof item.name === 'string' && item.name.trim()) {
      facets.push({ code: typeof item.code === 'string' && item.code ? item.code : item.name, name: item.name })
    }
  }
  return facets
}

export class OrgSkillCatalog {
  // 原 5 分钟目录缓存已停用：服务端可在 userId 不变时调整 group_id，复用缓存会短暂泄露旧分组目录。
  // private catalogCache: { at: number; items: OrgSkillCatalogItem[] } | null = null

  // [enterprise] 测试可注入点（生产恒为 promisify(execFile)）
  protected tarExtract: typeof execFileAsync = execFileAsync

  constructor(private readonly auth: OrgAuthManager) {}

  // MEA:enterprise-java-resources 文件标识仅留在主进程，渲染层使用稳定资源键。
  async listResources() {
    await this.auth.revalidateAuthority()
    const lease = this.auth.acquireLease()
    const items = await this.auth.apiClient.javaResources.listSkills()
    this.auth.assertLease(lease)
    const result = await Promise.all(
      items.map(async ({ packageFileCode: _package, iconFileCode, ...item }) => {
        void _package
        return {
          ...item,
          resourceKey: javaResourceKey(lease.issuerId, 'skill', item.id),
          iconUrl: iconFileCode ? await this.auth.apiClient.javaResources.readIcon(iconFileCode) : null
        }
      })
    )
    this.auth.assertLease(lease)
    return result
  }

  async refreshResourceAuthority(): Promise<void> {
    await this.auth.revalidateAuthority()
    const lease = this.auth.acquireLease()
    try {
      const items = await this.auth.apiClient.javaResources.listSkills()
      this.auth.assertLease(lease)
      profileSwitchFence.assertWritable()
      orgStateStore.reconcileJavaResources(
        'skill',
        items.map((item) => javaResourceKey(lease.issuerId, 'skill', item.id)),
        lease
      )
    } catch (error) {
      this.auth.assertLease(lease)
      profileSwitchFence.assertWritable()
      orgStateStore.reconcileJavaResources('skill', [], lease, false)
      throw error
    }
  }

  installedResourceKeys(): string[] {
    return agentGlobalSkillService
      .listAll()
      .map((skill) => skill.sourceUrl)
      .filter((key): key is string => parseJavaResourceKey(key)?.resourceType === 'skill')
  }

  async installResource(resourceKey: string): Promise<void> {
    profileSwitchFence.assertWritable()
    const source = parseJavaResourceKey(resourceKey)
    if (source?.resourceType !== 'skill') throw new Error('技能来源标识无效')
    await this.auth.revalidateAuthority()
    const lease = this.auth.acquireLease()
    if (source.serverInstanceId !== lease.issuerId) throw new Error('技能来源与当前服务不符')
    const items = await this.auth.apiClient.javaResources.listSkills()
    this.auth.assertLease(lease)
    const item = items.find((entry) => entry.id === source.resourceId)
    if (!item) throw new Error('技能不存在或无权访问')
    const { bytes } = await this.auth.apiClient.javaResources.readFile(item.packageFileCode)
    this.auth.assertLease(lease)
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    if (contentHash !== item.contentHash) throw new Error('技能包摘要校验失败')
    const tempRoot = application.getPath('feature.agents.skills.install.temp')
    await mkdir(tempRoot, { recursive: true })
    const workDir = await mkdtemp(join(tempRoot, 'java-skill-'))
    try {
      const zipPath = join(workDir, 'package.zip')
      const extractDir = join(workDir, 'extract')
      await writeFile(zipPath, bytes)
      await mkdir(extractDir)
      await extractZip(zipPath, extractDir)
      const entries = await readdir(extractDir, { withFileTypes: true })
      let skillDir: string
      if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
        skillDir = extractDir
      } else if (entries.length === 1 && entries[0].isDirectory() && entries[0].name === item.slug) {
        skillDir = join(extractDir, entries[0].name)
      } else {
        throw new Error('技能包必须包含唯一的根目录或标识目录 SKILL.md')
      }
      const tree = await readdir(extractDir, { withFileTypes: true, recursive: true })
      if (tree.some((entry) => entry.isSymbolicLink())) throw new Error('技能包不允许符号链接')
      if (tree.filter((entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md').length !== 1) {
        throw new Error('技能包包含多个技能或缺少 SKILL.md')
      }
      await validateRepositorySkillDirectory(extractDir, skillDir)
      await assertSkillDirectoryWithinLimits(skillDir)
      const assertAuthority = () => {
        this.auth.assertLease(lease)
        profileSwitchFence.assertWritable()
      }
      assertAuthority()
      const { skillService } = await import('@main/ai/skills/SkillService')
      const installed = await skillService.installJavaResource(skillDir, resourceKey, assertAuthority, {
        displayName: item.name,
        displayNameEn: '',
        description: item.description,
        descriptionEn: ''
      })
      assertAuthority()
      orgStateStore.upsert(resourceKey, {
        skillId: installed.id,
        folderName: installed.folderName,
        version: item.version,
        contentHash
      })
      orgStateStore.recordSkillEntitlement(resourceKey, {
        issuerId: lease.issuerId,
        groupId: lease.groupId,
        tenantId: lease.tenantId,
        generation: lease.generation,
        resourceId: item.id,
        entitlement: 'active'
      })
      try {
        await this.auth.apiClient.javaResources.reportLifecycle({
          id: item.id,
          eventId: randomUUID().replaceAll('-', ''),
          event: 'install',
          version: item.version,
          contentHash
        })
      } catch {
        logger.warn('技能安装完成，生命周期上报失败')
      }
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }

  // MEA:enterprise-java-resources 显式激活才计入 exec，目录展示及普通文件读取不计入。
  async activateResource(
    resourceKey: string,
    agentId: string,
    signal?: AbortSignal
  ): Promise<{ content: string; directory: string }> {
    signal?.throwIfAborted()
    const source = parseJavaResourceKey(resourceKey)
    if (source?.resourceType !== 'skill' || !agentId) throw new Error('技能来源标识无效')
    await this.auth.revalidateAuthority()
    const lease = this.auth.acquireLease()
    const visible = await this.auth.apiClient.javaResources.listSkills()
    signal?.throwIfAborted()
    this.auth.assertLease(lease)
    if (!visible.some((item) => item.id === source.resourceId)) throw new Error('技能无权访问')
    if (source.serverInstanceId !== lease.issuerId) throw new Error('技能来源与当前服务不符')
    const { skillService } = await import('@main/ai/skills/SkillService')
    const state = orgStateStore.get(resourceKey)
    const local = (await skillService.list({ agentId })).find(
      (skill) => skill.id === state?.skillId && skill.sourceUrl === resourceKey && skill.isEnabled
    )
    if (!state || !local) throw new Error('技能未启用或无权访问')
    const directory = skillService.getInstalledSkillDirectory(local)
    const content = await readFile(join(directory, 'SKILL.md'), { encoding: 'utf8', signal })
    signal?.throwIfAborted()
    this.auth.assertLease(lease)
    if (!orgStateStore.isSkillAllowed(resourceKey, lease)) throw new Error('技能无权访问')
    try {
      await this.auth.apiClient.javaResources.reportLifecycle({
        id: source.resourceId,
        eventId: randomUUID().replaceAll('-', ''),
        event: 'exec',
        version: state.version,
        contentHash: state.contentHash
      })
    } catch {
      logger.warn('技能激活生命周期上报失败')
    }
    signal?.throwIfAborted()
    this.auth.assertLease(lease)
    if (!orgStateStore.isSkillAllowed(resourceKey, lease)) throw new Error('技能无权访问')
    return { content, directory }
  }

  async removeResource(resourceKey: string): Promise<void> {
    profileSwitchFence.assertWritable()
    const source = parseJavaResourceKey(resourceKey)
    if (source?.resourceType !== 'skill') throw new Error('技能来源标识无效')
    const state = orgStateStore.get(resourceKey)
    const local = agentGlobalSkillService.listAll().find((skill) => skill.id === state?.skillId)
    if (!state || !local || local.sourceUrl !== resourceKey) throw new Error('技能来源与本地记录不符')
    const { skillService } = await import('@main/ai/skills/SkillService')
    await skillService.uninstall(local.id)
    orgStateStore.remove(resourceKey)
  }

  async list(force = false): Promise<OrgSkillCatalogItem[]> {
    void force
    // 原 TTL/stale-cache 逻辑停用：分组由服务端根据 token 实时解析，目录每次都必须重新鉴权裁剪。
    // if (!force && this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.items
    await this.auth.revalidateAuthority()
    const lease = this.auth.acquireLease()
    const { skills } = await this.auth.apiClient.listSkills()
    this.auth.assertLease(lease)
    return skills.map((skill) => {
      let iconUrl: string | null = null
      if (skill.iconUrl?.startsWith('/api/skill-icons/')) {
        const parsed = new URL(skill.iconUrl, getOrgApiBaseUrl())
        if (parsed.origin === new URL(getOrgApiBaseUrl()).origin) iconUrl = parsed.toString()
      }
      // [enterprise] tags/categories 双形态归一化（见 normalizeFacets），渲染层恒拿到 {code,name}
      const categories = normalizeFacets(skill.categories)
      const tags = normalizeFacets(skill.tags)
      return { ...skill, iconUrl, categories, tags }
    })
  }

  /**
   * [enterprise] C2 停用拦截查询：返回当前已停用/已下架的 org 技能 slug 列表。
   * 渲染层在构建新会话技能注入时调用，命中者不注入。
   * 目录不可达时默认禁用已有企业技能，避免离线复用旧组权限。
   */
  async listDisabled(): Promise<string[]> {
    const local = orgStateStore.snapshot()
    try {
      const catalog = await this.list()
      const active = new Set(catalog.map((s) => s.slug))
      return Object.entries(local)
        .filter(([slug, state]) => !active.has(slug) || !state.enabled)
        .map(([slug]) => slug)
    } catch {
      return Object.keys(local)
    }
  }

  /**
   * [enterprise] C1 启动扫描：对比本地 state 与服务端目录 contentHash，
   * 不一致者静默重装（SkillService 同 origin 覆盖更新）；目录缺失者标记停用（C2）。
   * 供 EnterprisePlugin.onInit 调用；任何单项失败不阻塞其余项。
   */
  async startupScan(): Promise<{ updated: string[]; disabled: string[] }> {
    const updated: string[] = []
    const disabled: string[] = []
    let catalog: OrgSkillCatalogItem[]
    try {
      catalog = await this.list()
    } catch (error) {
      logger.warn('startupScan skipped: catalog unreachable', { error: String(error) })
      return { updated, disabled }
    }

    const lease = this.auth.acquireLease()
    const remote = new Map(catalog.map((s) => [s.slug, s]))
    const local = orgStateStore.snapshot()

    // C1：远端有 & hash 变化 → 重装。
    // [enterprise] C4 防复活：有删除墓碑且 hash 与远端一致 → 用户明确删过，跳过；
    // hash 不一致（企业推了新版）→ 用户删除意图失效，清墓碑重新下发。
    for (const [slug, item] of remote) {
      const state = local[slug]
      const tombstoneHash = orgStateStore.deletedHash(slug)
      if (!state && tombstoneHash !== undefined) {
        if (tombstoneHash === item.contentHash) continue
        orgStateStore.clearDeleted(slug)
      }
      if (state && state.contentHash === item.contentHash) continue
      try {
        await this.downloadAndInstall(slug, item, lease)
        updated.push(slug)
      } catch (error) {
        logger.warn('startupScan auto-update failed', { slug, error: String(error) })
      }
    }

    // C2：本地有 & 远端没有 → 标记停用（保留文件，提示"可删除"）
    for (const slug of Object.keys(local)) {
      this.auth.assertLease(lease)
      profileSwitchFence.assertWritable()
      if (!remote.has(slug)) {
        orgStateStore.setEnabled(slug, false)
        disabled.push(slug)
      } else {
        // [enterprise] C2：远端还在 → 恢复启用标记（上轮可能被误停）
        const state = local[slug]
        if (state && !state.enabled) orgStateStore.setEnabled(slug, true)
      }
    }

    if (updated.length || disabled.length) {
      logger.info('startupScan done', { updated, disabled })
    }
    return { updated, disabled }
  }

  /** 安装企业技能：下载（服务端校验）→ 解包 → SkillService.installSkillDir(source='org') → 上报 */
  async install(slug: string): Promise<void> {
    profileSwitchFence.assertWritable()
    const lease = this.auth.acquireLease()
    await this.downloadAndInstall(slug, undefined, lease)
  }

  /** [enterprise] 将旧托管技能就地转成 local；ID、文件和 Agent 关联不变。 */
  migrateLegacyCopies(): number {
    const legacy = agentGlobalSkillService.listAll().filter((skill) => skill.source === 'org')
    for (const skill of legacy) agentGlobalSkillService.update(skill.id, { source: 'local' })
    return legacy.length
  }

  /** [enterprise] copy 模式按本地资源来源标识判断安装状态，不依赖组织托管 state。 */
  installedSlugs(): string[] {
    return agentGlobalSkillService
      .listAll()
      .map((skill) => skill.sourceUrl?.match(/^org-skill:(.+)$/)?.[1])
      .filter((slug): slug is string => Boolean(slug))
  }

  /**
   * [enterprise] C1 下载 + 安装 + state 记录 + install 上报（install 与 startupScan 共用）。
   */
  private async downloadAndInstall(
    slug: string,
    knownItem?: OrgSkillCatalogItem,
    lease = this.auth.acquireLease()
  ): Promise<void> {
    const item = knownItem ?? (await this.list()).find((s) => s.slug === slug)
    if (!item) throw new Error(`企业技能不存在: ${slug}`)

    const workDir = join(tmpdir(), `org-skill-${slug}-${Date.now()}`)
    const tarballPath = join(workDir, `${slug}.tar.gz`)
    const extractDir = join(workDir, 'extract')

    try {
      await mkdir(extractDir, { recursive: true })
      await this.downloadWithHash(item, tarballPath)
      await this.tarExtract('tar', ['-xzf', tarballPath, '-C', extractDir])

      // tarball 结构：<slug>/SKILL.md
      const skillDir = join(extractDir, slug)
      // [enterprise] copy 模式：组织仅提供下载目录，安装后作为普通本地技能管理。
      // 显示名修复：SKILL.md frontmatter 的 name 通常是 slug 形态（org-code-review），
      // 必须把服务端目录的 name/description 作为 displayName 传入，否则「我安装的」
      // 列表显示的是 slug 而不是企业命名（与技能市场 catalog 链路同一机制）。
      // SkillService 未进服务注册表，用导出单例 + 断言访问（installSkillDir 为私有）
      this.auth.assertLease(lease)
      profileSwitchFence.assertWritable()
      const { skillService } = await import('@main/ai/skills/SkillService')
      const installed = await (
        skillService as unknown as {
          installSkillDir: (
            dir: string,
            source: string,
            sourceUrl: string | null,
            provenance?: {
              catalogDisplayMetadata?: {
                displayName: string
                displayNameEn: string
                description: string
                descriptionEn: string
              }
            }
          ) => Promise<{ id?: string; folderName?: string }>
        }
      ).installSkillDir(skillDir, 'local', `org-skill:${slug}`, {
        catalogDisplayMetadata: {
          displayName: item.name,
          displayNameEn: '',
          description: item.description,
          descriptionEn: ''
        }
      })

      orgStateStore.recordSkillEntitlement(slug, {
        issuerId: lease.issuerId,
        groupId: lease.groupId,
        resourceId: slug,
        entitlement: 'active',
        generation: lease.generation
      })
      // [enterprise] copy 模式不再写托管快照或墓碑；本地技能表即安装状态来源。
      // orgStateStore.upsert(slug, {
      //   version: item.version,
      //   contentHash: item.contentHash,
      //   skillId: String(installed.id ?? ''),
      //   folderName: installed.folderName ?? slug
      // })
      // orgStateStore.clearDeleted(slug)

      await this.auth.apiClient.reportLifecycle(slug, 'install', { version: item.version })
      logger.info('org skill installed', { slug, version: item.version, id: (installed as { id?: string }).id })
    } catch (error) {
      logger.error('org skill install failed', error as Error, { slug })
      throw error
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * [enterprise] C4 删除上报：用户卸载 org 技能时调用（由 skill.uninstall IPC 拦截层触发）。
   * 上报失败不阻塞本地卸载；state 记录同步清除，并写入删除墓碑（slug → 删除时 hash），
   * 供 startupScan C1 防复活：同 hash 不自动重装，企业推新版（hash 变化）时清墓碑重装。
   */
  async reportDeleted(slug: string): Promise<void> {
    try {
      await this.auth.apiClient.reportLifecycle(slug, 'deleted', { slug })
    } finally {
      // [enterprise] 墓碑取删除时的 hash；安装记录已被卸载链路删除也要兜底清掉
      const deletedHash = orgStateStore.get(slug)?.contentHash
      if (deletedHash) orgStateStore.markDeleted(slug, deletedHash)
      orgStateStore.remove(slug)
    }
  }

  /** 技能执行上报（T0 埋点：AgentPage 触发技能时由渲染层调 IPC 上报） */
  reportExec(slug: string, detail: Record<string, unknown> = {}) {
    return this.auth.apiClient.reportLifecycle(slug, 'exec', detail)
  }

  /** 下载 + sha256 边下边校验，不匹配即抛错（复用 OrgApiClient 逻辑太绕，这里独立实现） */
  private async downloadWithHash(item: OrgSkillCatalogItem, destPath: string): Promise<void> {
    // 原匿名下载停用：下载端点与目录读取使用同一分组鉴权，必须携带有效会话。
    // const session = await this.auth.getValidSession().catch(() => null)
    const session = await this.auth.getValidSession()
    if (!session) throw new Error('未登录')

    const baseUrl = new URL(this.baseUrl())
    const downloadUrl = new URL(item.downloadUrl, baseUrl)
    if (downloadUrl.origin !== baseUrl.origin || !downloadUrl.pathname.startsWith('/api/library-items/')) {
      throw new Error('技能包下载地址无效')
    }
    const res = await fetch(downloadUrl, {
      headers: { authorization: `Bearer ${session.accessToken}` }
    })
    if (!res.ok || !res.body) throw new Error(`技能包下载失败 (${res.status})`)

    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      hash.update(Buffer.from(value))
    }
    const actual = hash.digest('hex')
    if (actual !== item.contentHash) {
      throw new Error(`技能包校验失败：期望 ${item.contentHash.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`)
    }
    await writeFile(destPath, Buffer.concat(chunks))
    // 防止未使用警告
    void createReadStream
  }

  private baseUrl() {
    return getOrgApiBaseUrl()
  }
}
