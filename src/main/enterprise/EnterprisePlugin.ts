/**
 * [enterprise] T0 企业扩展插件入口
 * 聚合 OrgAuthManager / OrgSkillCatalog / OrgMcpCatalog，注册为主进程服务。
 */
import { BaseService, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { OrgAuthManager } from './OrgAuthManager'
import { OrgMcpCatalog } from './OrgMcpCatalog'
import { OrgSkillCatalog } from './OrgSkillCatalog'

@Injectable('EnterprisePlugin')
@ServicePhase(Phase.WhenReady)
export class EnterprisePlugin extends BaseService {
  // [enterprise] 登录管理器（PKCE + 系统浏览器 + meacowork://auth 深链回调）
  readonly auth = new OrgAuthManager()
  readonly skills = new OrgSkillCatalog(this.auth)
  readonly connectors = new OrgMcpCatalog(this.auth)

  protected async onInit(): Promise<void> {
    // schema/handler 各自的注册表已在模块加载时静态并入；
    // 这里只做启动日志，T0 无需额外初始化。
    return
  }
}
