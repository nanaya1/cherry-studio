import { application } from '@application'
import type { remoteKnowledgeRequestSchemas } from '@shared/ipc/schemas/remoteKnowledge'
import type { IpcHandlersFor } from '@shared/ipc/types'

/**
 * Thin adapters for the remote-knowledge request routes: each one translates a parsed
 * route call into a `RemoteKnowledgeService` method (business logic stays in that
 * service). These routes act on shared business data, not the caller's window, so
 * they ignore `IpcContext` (contrast window.ts).
 */
export const remoteKnowledgeHandlers: IpcHandlersFor<typeof remoteKnowledgeRequestSchemas> = {
  'remote_knowledge.service.list': async () => application.get('RemoteKnowledgeService').list(),
  'remote_knowledge.service.create': async ({ draft }) => application.get('RemoteKnowledgeService').create(draft),
  'remote_knowledge.service.update': async ({ id, patch }) =>
    application.get('RemoteKnowledgeService').update(id, patch),
  'remote_knowledge.service.delete': async ({ id }) => {
    application.get('RemoteKnowledgeService').delete(id)
  },
  'remote_knowledge.service.test_connection': async ({ id, config }) =>
    application.get('RemoteKnowledgeService').testConnection({ id, config }),
  'remote_knowledge.base.list': async ({ id }) => application.get('RemoteKnowledgeService').listRemoteBases(id)
}
