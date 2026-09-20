import { shell } from 'electron'

import { loggerService } from '@logger'
// import { application } from '@application' // [enterprise] copy 模式不再调用旧托管上报函数
import { skillService } from '@main/ai/skills/SkillService'
import type { skillRequestSchemas } from '@shared/ipc/schemas/skill'
import type { IpcHandlersFor } from '@shared/ipc/types'
import type { SkillResult } from '@shared/types/skill'

const logger = loggerService.withContext('skillHandlers')

// [enterprise] copy 模式不再按组织来源处理卸载，保留旧托管上报逻辑便于回滚。
// async function reportOrgSkillDeletedIfManaged(skillId: string): Promise<void> {
//   try {
//     const { orgStateStore } = await import('@main/enterprise/OrgStateStore')
//     const entry = Object.entries(orgStateStore.snapshot()).find(([, s]) => s.skillId === skillId)
//     if (!entry) return
//     const plugin = application.getExisting('EnterprisePlugin')
//     if (!plugin) return
//     await plugin.skills.reportDeleted(entry[0])
//   } catch (error) {
//     logger.warn('[enterprise] org skill deleted report skipped', { skillId, error: String(error) })
//   }
// }

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
  // [enterprise] copy 模式：组织安装后等同本地技能，卸载不再进入组织生命周期。
  // 'skill.uninstall': ({ skillId }) =>
  //   toSkillResult(async () => {
  //     await reportOrgSkillDeletedIfManaged(skillId)
  //     return skillService.uninstall(skillId)
  //   }, 'Failed to uninstall skill'),
  'skill.uninstall': ({ skillId }) => toSkillResult(() => skillService.uninstall(skillId), 'Failed to uninstall skill'),
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
