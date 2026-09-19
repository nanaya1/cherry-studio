/**
 * [enterprise] T0 企业扩展插件入口
 * 聚合 OrgAuthManager / OrgSkillCatalog / OrgMcpCatalog，注册为主进程服务。
 * C1/C2/C6 扩展：启动时执行 startupScan + compareAndSync（静默自动更新/停用标记/连接器同步）。
 */
import { BaseService, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { loggerService } from '@logger'
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
    // schema/handler 各自的注册表已在模块加载时静态并入；
    // 这里做启动扫描（C1 自动更新 / C2 停用标记 / C6 连接器同步）。
    // 未登录时扫描内部自行跳过（catalog 拉取失败静默返回）。
    try {
      const [skillScan, connectorScan] = await Promise.allSettled([
        this.skills.startupScan(),
        this.connectors.compareAndSync()
      ])
      if (skillScan.status === 'fulfilled' && (skillScan.value.updated.length || skillScan.value.disabled.length)) {
        logger.info('org skill startup scan', skillScan.value)
      }
      if (connectorScan.status === 'fulfilled') {
        const { installed, updated, disabled } = connectorScan.value
        if (installed.length || updated.length || disabled.length) {
          logger.info('org connector sync', { installed, updated, disabled })
        }
      }
    } catch (error) {
      logger.warn('enterprise startup scan failed', { error: String(error) })
    }
    return
  }
}
