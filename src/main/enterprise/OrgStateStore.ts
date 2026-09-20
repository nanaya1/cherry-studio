/**
 * [enterprise] C1/C3/C5 org 本地状态持久化
 * 记录企业下发技能的安装快照（version/contentHash/skillId/folderName/enabled），
 * 供启动扫描比对自动更新（C1）、安装/启用分离（C5）、登出不可用标记（C3）。
 * 存储位置与 OrgCredentialStore 同目录（<Skills>/../enterprise/org-state.json）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { application } from '@application'
import { loggerService } from '@logger'

const logger = loggerService.withContext('OrgStateStore')

const skillStateSchema = z.object({
  version: z.string(),
  contentHash: z.string(),
  skillId: z.string(),
  folderName: z.string(),
  /** C5 安装/启用分离：安装后默认 true（用户可手动关）；企业停用拦截走 listDisabled，与此独立 */
  enabled: z.boolean().default(true)
})

export type OrgSkillState = z.infer<typeof skillStateSchema>

const connectorStateSchema = z.object({
  mcpId: z.string(),
  baseUrl: z.string()
})

export type OrgConnectorState = z.infer<typeof connectorStateSchema>

const fileSchema = z.object({
  skills: z.record(z.string(), skillStateSchema).default({}),
  // [enterprise] C6 连接器本地映射：slug → { mcpId, baseUrl }
  connectors: z.record(z.string(), connectorStateSchema).default({}),
  /** C3 登出时置 true：所有 org 资源标记"组织不可用"，重登恢复 */
  unavailable: z.boolean().default(false),
  // [enterprise] C4 删除墓碑：slug → 删除时的 contentHash。
  // startupScan C1 据此防复活：同 hash 不重装（用户删过），hash 变化（企业推新版）清墓碑重装。
  deletedSkills: z.record(z.string(), z.string()).default({}),
  // [enterprise] C4 连接器删除墓碑：slug → 删除时的 baseUrl。
  // compareAndSync 据此防复活：同 baseUrl 不自动重装（用户删过），企业推新 baseUrl 视为重新下发清墓碑。
  deletedConnectors: z.record(z.string(), z.string()).default({})
})

function stateFile(): string {
  // 与 OrgCredentialStore.credFile 同规则：必须延迟到调用时取路径
  return join(application.getPath('feature.agents.skills'), '..', 'enterprise', 'org-state.json')
}

export class OrgStateStore {
  private data: z.infer<typeof fileSchema> | null = null

  // [enterprise] 惰性初始化：模块加载早于 application.initPathRegistry()（OrgCredentialStore
  // 同款坑），构造函数里立即 load() 会在启动时抛错 → state 被静默重置为空 →
  // startupScan C1 误判「本地无记录」把已删技能全部重装。改为首次数据访问时才读文件。
  private ensureLoaded(): void {
    if (this.data === null) this.data = this.load()
  }

  private load(): z.infer<typeof fileSchema> {
    try {
      const filePath = stateFile()
      if (!existsSync(filePath)) return fileSchema.parse({})
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')))
      if (!parsed.success) {
        logger.warn('org state file corrupted, resetting')
        return fileSchema.parse({})
      }
      return parsed.data
    } catch (error) {
      logger.warn('failed to read org state file', { error: String(error) })
      return fileSchema.parse({})
    }
  }

  private persist(): void {
    const filePath = stateFile()
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 })
  }

  get(slug: string): OrgSkillState | undefined {
    this.ensureLoaded()
    return this.data!.skills[slug]
  }

  snapshot(): Record<string, OrgSkillState> {
    this.ensureLoaded()
    return { ...this.data!.skills }
  }

  upsert(slug: string, state: Omit<OrgSkillState, 'enabled'> & { enabled?: boolean }): void {
    this.ensureLoaded()
    const parsed = skillStateSchema.parse({ enabled: true, ...state })
    this.data!.skills[slug] = parsed
    this.persist()
  }

  remove(slug: string): void {
    this.ensureLoaded()
    delete this.data!.skills[slug]
    this.persist()
  }

  // [enterprise] C4 删除墓碑：记录 slug 删除时的 contentHash 并持久化（幂等，重复标记以后一次为准）
  markDeleted(slug: string, contentHash: string): void {
    this.ensureLoaded()
    this.data!.deletedSkills[slug] = contentHash
    this.persist()
  }

  // [enterprise] C4 墓碑查询：返回删除时记录的 contentHash（无墓碑返回 undefined）
  deletedHash(slug: string): string | undefined {
    this.ensureLoaded()
    return this.data!.deletedSkills[slug]
  }

  // [enterprise] C4 清除墓碑（企业推新版重新下发时由 startupScan 调用）
  clearDeleted(slug: string): void {
    this.ensureLoaded()
    delete this.data!.deletedSkills[slug]
    this.persist()
  }

  setEnabled(slug: string, enabled: boolean): void {
    this.ensureLoaded()
    const current = this.data!.skills[slug]
    if (!current) return
    this.data!.skills[slug] = { ...current, enabled }
    this.persist()
  }

  /** C3：登出标记组织不可用（org 技能保留本地但提示不可用） */
  markUnavailable(): void {
    this.ensureLoaded()
    this.data!.unavailable = true
    this.persist()
  }

  /** [enterprise] C6 连接器映射写入 */
  upsertConnector(slug: string, state: OrgConnectorState): void {
    this.ensureLoaded()
    this.data!.connectors[slug] = connectorStateSchema.parse(state)
    this.persist()
  }

  /** [enterprise] C6 连接器映射读取 */
  getConnector(slug: string): OrgConnectorState | undefined {
    this.ensureLoaded()
    return this.data!.connectors[slug]
  }

  snapshotConnectors(): Record<string, OrgConnectorState> {
    this.ensureLoaded()
    return { ...this.data!.connectors }
  }

  removeConnector(slug: string): void {
    this.ensureLoaded()
    delete this.data!.connectors[slug]
    this.persist()
  }

  // [enterprise] C4 连接器墓碑：记录 slug 删除时的 baseUrl 并持久化（幂等，重复标记以后一次为准）
  markConnectorDeleted(slug: string, baseUrl: string): void {
    this.ensureLoaded()
    this.data!.deletedConnectors[slug] = baseUrl
    this.persist()
  }

  // [enterprise] C4 连接器墓碑查询：返回删除时记录的 baseUrl（无墓碑返回 undefined）
  deletedConnectorBaseUrl(slug: string): string | undefined {
    this.ensureLoaded()
    return this.data!.deletedConnectors[slug]
  }

  // [enterprise] C4 清除连接器墓碑（企业推新 baseUrl 或用户手动重装时调用）
  clearConnectorDeleted(slug: string): void {
    this.ensureLoaded()
    delete this.data!.deletedConnectors[slug]
    this.persist()
  }

  /** C3：重新登录恢复 */
  markAvailable(): void {
    this.ensureLoaded()
    this.data!.unavailable = false
    this.persist()
  }

  snapshotUnavailable(): boolean {
    this.ensureLoaded()
    return this.data!.unavailable
  }
}

/** [enterprise] 企业模块共用单例（进程内一份 state）；惰性初始化，见 ensureLoaded 注释 */
export const orgStateStore = new OrgStateStore()
