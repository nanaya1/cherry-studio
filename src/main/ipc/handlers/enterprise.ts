import { application } from '@application'
import type { enterpriseRequestSchemas } from '@shared/ipc/schemas/enterprise'
import type { IpcHandlersFor } from '@shared/ipc/types'

// [enterprise] T0 企业扩展 IPC 处理器。实现主体在 @main/enterprise/*。
export const enterpriseHandlers: IpcHandlersFor<typeof enterpriseRequestSchemas> = {
  'enterprise.status.get': async () => application.get('EnterprisePlugin').auth.getStatus(),
  'enterprise.login.start': async () => application.get('EnterprisePlugin').auth.startLogin(),
  'enterprise.session.logout': async () => {
    application.get('EnterprisePlugin').auth.logout()
    return { ok: true }
  },
  'enterprise.skills.list': async () => ({ skills: await application.get('EnterprisePlugin').skills.list() }),
  'enterprise.skills.install': async ({ slug }) => {
    await application.get('EnterprisePlugin').skills.install(slug)
    return { ok: true }
  },
  'enterprise.skills.reportExec': async ({ slug, detail }) => {
    application.get('EnterprisePlugin').skills.reportExec(slug, detail)
    return { ok: true }
  },
  // [enterprise] C2 停用拦截：返回当前已停用/已下架的 org 技能 slug
  'enterprise.skills.listDisabled': async () => ({
    disabled: await application.get('EnterprisePlugin').skills.listDisabled()
  }),
  // [enterprise] C4 删除上报：用户卸载 org 技能时上报 deleted（幂等 record）并清 state
  'enterprise.skills.reportDeleted': async ({ slug }) => {
    await application.get('EnterprisePlugin').skills.reportDeleted(slug)
    return { ok: true }
  },
  // [enterprise] C3 组织可用性查询（登出标记 / 重登恢复）
  'enterprise.status.orgUnavailable': async () => {
    const { orgStateStore } = await import('@main/enterprise/OrgStateStore')
    return { unavailable: orgStateStore.snapshotUnavailable() }
  },
  'enterprise.connectors.list': async () => ({
    connectors: await application.get('EnterprisePlugin').connectors.list()
  }),
  'enterprise.connectors.install': async ({ slug }) => {
    await application.get('EnterprisePlugin').connectors.install(slug)
    return { ok: true }
  }
}
