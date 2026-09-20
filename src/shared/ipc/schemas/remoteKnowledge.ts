import * as z from 'zod'

import {
  CreateRemoteKnowledgeServiceSchema,
  RemoteKnowledgeBaseInfoSchema,
  RemoteKnowledgeServiceInfoSchema,
  RemoteTestConnectionResultSchema,
  UpdateRemoteKnowledgeServiceSchema
} from '@shared/data/types/remoteKnowledge'

import { defineRoute } from '../define'

/**
 * Remote knowledge IPC schemas — caller-facing configuration operations on remote
 * knowledge services, each delegating to the stateful RemoteKnowledgeService in main.
 *
 * Only a Request block: remote knowledge pushes nothing main→renderer (base listings
 * are pulled on demand when the user opens the binding picker), so there is no Event
 * block (unlike window.ts/selection.ts).
 *
 * Inputs reuse the canonical remote-knowledge zod schemas from
 * `@shared/data/types/remoteKnowledge` so a DTO-shape drift is a compile error here.
 */
export const remoteKnowledgeRequestSchemas = {
  'remoteKnowledge.list': defineRoute({
    input: z.void(),
    output: z.array(RemoteKnowledgeServiceInfoSchema)
  }),
  'remoteKnowledge.create': defineRoute({
    input: z.strictObject({ draft: CreateRemoteKnowledgeServiceSchema }),
    output: RemoteKnowledgeServiceInfoSchema
  }),
  'remoteKnowledge.update': defineRoute({
    input: z.strictObject({ id: z.string().trim().min(1), patch: UpdateRemoteKnowledgeServiceSchema }),
    output: RemoteKnowledgeServiceInfoSchema
  }),
  'remoteKnowledge.delete': defineRoute({
    input: z.strictObject({ id: z.string().trim().min(1) }),
    output: z.void()
  }),
  // Probe a saved service (by id) or an unsaved draft (by config). Failures come
  // Probe a saved service (by id) or an unsaved draft (by config) — exactly one of
  // the two. Failures come back as {ok:false, error} data — never thrown — so the
  // UI renders them inline.
  'remoteKnowledge.test_connection': defineRoute({
    input: z
      .strictObject({
        id: z.string().trim().min(1).optional(),
        config: CreateRemoteKnowledgeServiceSchema.optional()
      })
      .refine((v) => Boolean(v.id) !== Boolean(v.config), {
        message: 'Provide exactly one of id or config'
      }),
    output: RemoteTestConnectionResultSchema
  }),
  // Enumerate bases exposed by one service, or all enabled services when id omitted.
  'remoteKnowledge.list_bases': defineRoute({
    input: z.strictObject({ id: z.string().trim().min(1).optional() }),
    output: z.array(RemoteKnowledgeBaseInfoSchema)
  })
}
