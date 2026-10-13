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
  // [enterprise] installedSlugs：随目录返回已装状态（对话框据此标记「已安装」）
  // force：UI 手动刷新穿透目录 TTL 缓存
  'enterprise.skills.list': async ({ force }) => {
    const plugin = application.get('EnterprisePlugin')
    return { skills: await plugin.skills.list(force === true), installedSlugs: plugin.skills.installedSlugs() }
  },
  'enterprise.skills.install': async ({ slug }) => {
    await application.get('EnterprisePlugin').skills.install(slug)
    return { ok: true }
  },
  'enterprise.skills.reportExec': async ({ slug, detail }) => {
    void application.get('EnterprisePlugin').skills.reportExec(slug, detail)
    return { ok: true }
  },
  // [enterprise] copy 模式：已安装副本不受目录停用影响。
  // 'enterprise.skills.listDisabled': async () => ({
  //   disabled: await application.get('EnterprisePlugin').skills.listDisabled()
  // }),
  'enterprise.skills.listDisabled': async () => ({ disabled: [] }),
  // [enterprise] copy 模式保留旧路由兼容已打开窗口，但不再上报或写删除墓碑。
  // 'enterprise.skills.reportDeleted': async ({ slug }) => {
  //   await application.get('EnterprisePlugin').skills.reportDeleted(slug)
  //   return { ok: true }
  // },
  'enterprise.skills.reportDeleted': async () => ({ ok: true }),
  // [enterprise] copy 模式：登出不影响已安装副本，旧 unavailable 状态不再生效。
  // 'enterprise.status.orgUnavailable': async () => {
  //   const { orgStateStore } = await import('@main/enterprise/OrgStateStore')
  //   return { unavailable: orgStateStore.snapshotUnavailable() }
  // },
  'enterprise.status.orgUnavailable': async () => ({ unavailable: false }),
  'enterprise.connectors.list': async () => ({
    connectors: await application.get('EnterprisePlugin').connectors.list()
  }),
  'enterprise.connectors.install': async ({ slug }) => {
    await application.get('EnterprisePlugin').connectors.install(slug)
    return { ok: true }
  }
}
