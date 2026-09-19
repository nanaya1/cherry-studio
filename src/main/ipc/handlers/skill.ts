import { shell } from 'electron'

import { loggerService } from '@logger'
import { application } from '@application'
import { skillService } from '@main/ai/skills/SkillService'
import type { skillRequestSchemas } from '@shared/ipc/schemas/skill'
import type { IpcHandlersFor } from '@shared/ipc/types'
import type { SkillResult } from '@shared/types/skill'

const logger = loggerService.withContext('skillHandlers')

/**
 * [enterprise] C4：若 skillId 对应 org 来源技能（state 里有记录且 skillId 匹配），
 * 先上报 deleted 生命周期事件并清 state。上报失败仅告警，绝不阻塞本地卸载。
 * EnterprisePlugin 未就绪/未启用时静默跳过。
 */
async function reportOrgSkillDeletedIfManaged(skillId: string): Promise<void> {
  try {
    const { orgStateStore } = await import('@main/enterprise/OrgStateStore')
    const entry = Object.entries(orgStateStore.snapshot()).find(([, s]) => s.skillId === skillId)
    if (!entry) return // 非 org 技能，走原逻辑
    const plugin = application.getOptional('EnterprisePlugin')
    if (!plugin) return // enterprise 插件未注册（测试/未启用环境）
    await plugin.skills.reportDeleted(entry[0])
  } catch (error) {
    logger.warn('[enterprise] org skill deleted report skipped', { skillId, error: String(error) })
  }
}

/**
 * Skill handlers delegating to the `skillService` direct-import singleton. Legacy routes keep
 * their `SkillResult` envelope until their callers migrate; new routes return data directly so
 * IpcApi owns error serialization. Skill_ReadFile / Skill_ListFiles stay on legacy IPC.
 */
async function toSkillResult<T>(op: () => Promise<T>, failMessage: string): Promise<SkillResult<T>> {
  try {
    return { success: true, data: await op() }
  } catch (error) {
    logger.error(failMessage, error as Error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export const skillHandlers: IpcHandlersFor<typeof skillRequestSchemas> = {
  'skill.install': ({ installSource }) =>
    toSkillResult(() => skillService.install({ installSource }), 'Failed to install skill'),
  // [enterprise] C4：卸载前判断是否 org 技能 → 上报 deleted 事件（失败不阻塞本地卸载）
  'skill.uninstall': ({ skillId }) =>
    toSkillResult(async () => {
      await reportOrgSkillDeletedIfManaged(skillId)
      // 原逻辑：skillService.uninstall(skillId)（未改动，仅外包 enterprise 上报）
      return skillService.uninstall(skillId)
    }, 'Failed to uninstall skill'),
  'skill.install_from_zip': ({ zipFilePath }) =>
    toSkillResult(() => skillService.installFromZip({ zipFilePath }), 'Failed to install skill from ZIP'),
  'skill.install_from_directory': ({ directoryPath }) =>
    toSkillResult(() => skillService.installFromDirectory({ directoryPath }), 'Failed to install skill from directory'),
  'skill.list_catalog': (query) => skillService.listCatalog(query),
  'skill.list_local': ({ workdir }) =>
    toSkillResult(() => skillService.listLocal(workdir), 'Failed to list local plugins'),
  'skill.reconcile': () => skillService.reconcileSkills(),
  'skill.discover_system': () => skillService.discoverSystem(),
  'skill.import_system': ({ directoryPath }) => skillService.importSystem({ directoryPath }),
  'skill.folder.open': async ({ skillId }, { senderId }) => {
    if (!senderId) throw new Error('Skill folders can only be opened from a managed window')

    const skill = await skillService.getById(skillId)
    if (!skill) throw new Error(`Skill not found: ${skillId}`)

    const errorMessage = await shell.openPath(skillService.getInstalledSkillDirectory(skill))
    if (errorMessage) throw new Error(`Failed to open skill folder: ${errorMessage}`)
  },
  'skill.icons.resolve': ({ skillIds }) => skillService.resolveIconUrls(skillIds)
}
