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
  'remoteKnowledge.list': async () => application.get('RemoteKnowledgeService').list(),
  'remoteKnowledge.create': async ({ draft }) => application.get('RemoteKnowledgeService').create(draft),
  'remoteKnowledge.update': async ({ id, patch }) => application.get('RemoteKnowledgeService').update(id, patch),
  'remoteKnowledge.delete': async ({ id }) => {
    application.get('RemoteKnowledgeService').delete(id)
  },
  'remoteKnowledge.test_connection': async ({ id, config }) =>
    application.get('RemoteKnowledgeService').testConnection({ id, config }),
  'remoteKnowledge.list_bases': async ({ id }) => application.get('RemoteKnowledgeService').listRemoteBases(id)
}
