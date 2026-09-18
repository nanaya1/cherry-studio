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
  'enterprise.connectors.list': async () => ({
    connectors: await application.get('EnterprisePlugin').connectors.list()
  }),
  'enterprise.connectors.install': async ({ slug }) => {
    await application.get('EnterprisePlugin').connectors.install(slug)
    return { ok: true }
  }
}
