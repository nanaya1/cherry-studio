import { loggerService } from '@logger'
/**
 * [enterprise] T0 企业扩展插件入口
 * 聚合 OrgAuthManager / OrgSkillCatalog / OrgMcpCatalog，注册为主进程服务。
 * C1/C2/C6 扩展：启动时执行 startupScan + compareAndSync（静默自动更新/停用标记/连接器同步）。
 */
import { BaseService, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'

import { OrgAuthManager } from './OrgAuthManager'
import { OrgMcpCatalog } from './OrgMcpCatalog'
import { OrgSkillCatalog } from './OrgSkillCatalog'

const logger = loggerService.withContext('EnterprisePlugin')

@Injectable('EnterprisePlugin')
@ServicePhase(Phase.WhenReady)
export class EnterprisePlugin extends BaseService {
  // [enterprise] 登录管理器（PKCE + 系统浏览器 + meacowork://auth 深链回调）
  readonly auth = new OrgAuthManager()
  readonly skills = new OrgSkillCatalog(this.auth)
  readonly connectors = new OrgMcpCatalog(this.auth)

  protected async onInit(): Promise<void> {
    // [enterprise] copy 模式不再更新、停用或自动安装；仅把旧托管记录就地转成本地来源。
    // const [skillScan, connectorScan] = await Promise.allSettled([
    //   this.skills.startupScan(),
    //   this.connectors.compareAndSync()
    // ])
    const migratedSkills = this.skills.migrateLegacyCopies()
    const migratedConnectors = this.connectors.migrateLegacyCopies()
    logger.info('enterprise copy mode ready', { migratedSkills, migratedConnectors })
  }
}
