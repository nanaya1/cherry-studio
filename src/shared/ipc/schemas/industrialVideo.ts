import * as z from 'zod'

import { defineRoute } from '../define'
import { uint8ArraySchema } from './common'

/**
 * Industrial-video IPC schemas — a TYPED ALLOWLIST of the only operations the
 * renderer may ask the main process to perform against the trusted
 * industrial-video service.
 *
 * There is deliberately NO generic `call(operation, args)` route: the renderer
 * cannot hand the main process an arbitrary `operation` string, and each route's
 * input schema restricts the fields that may be forwarded (e.g. the renderer can
 * only request the `parse` / `video` / `assemble` stages via dedicated routes —
 * it cannot smuggle in `stage: 'all'` or `'plan'`, or undocumented settings.
 * `with_audio` and narration are independent settings in the HTTP contract.
 *
 * Inputs are zod values (renderer → main, untrusted, always parsed). Outputs are
 * the success payload only; on any failure the handler throws an `IpcError`
 * (category preserved in `data`) so the renderer gets `{ ok: false, error }`.
 */

// ── Shared input fragments ──

/** Explicit, user-selected text handle. No inferring text from anything else. */
const ivTextItemSchema = z
  .object({
    text: z.string().min(1),
    title: z.string().optional()
  })
  .strict()

/** Explicit, user-selected media handle (server `name` + required caption). */
const ivMediaItemSchema = z
  .object({
    name: z.string().min(1),
    caption: z.string().min(1)
  })
  .strict()

/** Explicit, user-selected logo handle. Never synthesized from source text. */
const ivLogoItemSchema = z
  .object({
    name: z.string().min(1),
    brand_kind: z.enum(['company', 'product']).optional()
  })
  .strict()

const ivStoryboardSchema = z
  .object({
    video_title: z.string().min(1),
    scenes: z.array(z.record(z.string(), z.unknown()))
  })
  .passthrough()

const sessionIdField = z.string().trim().min(1)

/**
 * Fixed voice enum (COWORK_HTTP_GUIDE §17.1). Six Chinese neural voices — the
 * request contract is fixed; the client never queries a voice/score list. The
 * server rejects any other value with 422.
 */
const ivVoiceSchema = z.enum([
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaoyiNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunjianNeural',
  'zh-CN-YunyangNeural',
  'zh-CN-YunxiaNeural'
])

/**
 * Planning / audio output settings (COWORK_HTTP_GUIDE §17). These are the only
 * project-output knobs the renderer may submit; each is optional and null/omitted
 * means "inherit the currently-saved setting" on the server. They are forwarded
 * verbatim (snake_case) to `video_start` for the `parse`/`video`/`estimate` stages.
 */
export const ivNarrativeStyleSchema = z.enum([
  'auto',
  'industrial',
  'modern',
  'technology',
  'wuxia',
  'historical',
  'ceo_drama',
  'humor',
  'emotional'
])

const ivSettingsShape = {
  targetDurationS: z.number().int().min(1).max(600).nullable().optional(),
  resolution: z.enum(['720P', '1080P']).nullable().optional(),
  ttsEnabled: z.boolean().nullable().optional(),
  subtitleEnabled: z.boolean().nullable().optional(),
  backgroundMusicEnabled: z.boolean().nullable().optional(),
  withAudio: z.boolean().nullable().optional(),
  expectedSettingsVersion: z.number().int().nonnegative().nullable().optional(),
  narrativeStyle: ivNarrativeStyleSchema.nullable().optional()
}

/** Shared receipt fields the server returns alongside `effective_settings` (§17.2). */
const ivSettingsReceiptShape = {
  effectiveSettings: z.record(z.string(), z.unknown()).nullable().optional(),
  settingsVersion: z.number().nullable().optional(),
  settingsPersisted: z.boolean().optional(),
  settingsChanged: z.boolean().optional(),
  requiresReplan: z.boolean().optional(),
  approvalInvalidated: z.boolean().optional()
}

export const industrialVideoReviewReceiptSchema = z
  .object({
    review_version: z.string().refine((value) => value.trim().length > 0),
    generation_allowed: z.boolean(),
    remaining_blockers: z.array(z.unknown())
  })
  .passthrough()

export const industrialVideoReviewDocumentsSchema = industrialVideoReviewReceiptSchema.extend({
  script: z.string(),
  storyboard: z.record(z.string(), z.unknown())
})

export const industrialVideoReviewSourcesSchema = industrialVideoReviewReceiptSchema.extend({
  sources: z.array(z.unknown()),
  source_text: z.string()
})

const ivReviewInputShape = {
  sessionId: sessionIdField,
  run: z.string().trim().min(1),
  reviewType: z.enum(['sources', 'script_and_storyboard']).default('script_and_storyboard')
}

export const industrialVideoControlSchema = z.object({
  epoch: z.number().int().nonnegative(),
  phase: z.enum(['idle', 'active', 'stopping', 'stopped', 'reconcile_required']),
  stopRequested: z.boolean()
})

// ── Request: renderer → main calls (zod values, always parsed) ──
export const industrialVideoRequestSchemas = {
  'industrial_video.stop': defineRoute({
    input: z.object({ sessionId: sessionIdField }).strict(),
    output: industrialVideoControlSchema
  }),
  'industrial_video.review_snapshot_get': defineRoute({
    input: z.object(ivReviewInputShape).strict(),
    output: z.union([industrialVideoReviewDocumentsSchema, industrialVideoReviewSourcesSchema])
  }),
  // 确认只经独立用户 IPC 触发；不得注册为 Agent 审批工具。
  'industrial_video.review_confirm': defineRoute({
    input: z
      .object({
        ...ivReviewInputShape,
        expectedReviewVersion: z.string().refine((value) => value.trim().length > 0)
      })
      .strict(),
    output: industrialVideoReviewReceiptSchema
  }),
  /**
   * Whether the trusted service is configured (base URL + token present). This is
   * the only route that does NOT require a session — the renderer asks first, then
   * surfaces a clear "not configured" state instead of a silent failure.
   */
  'industrial_video.config_status': defineRoute({
    input: z.void(),
    output: z.object({ configured: z.boolean() })
  }),

  /**
   * Generate a unique `run` directory name. No project is created or reserved.
   */
  'industrial_video.run_create': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        baseName: z.string().trim().min(1),
        prefix: z.string().trim().min(1).nullable().optional()
      })
      .strict(),
    output: z.object({ run: z.string() })
  }),

  /**
   * Ingest the user's explicit text / media / logo handles into the service
   * (`video_start` stage `parse`). Returns the async `job_id`.
   */
  'industrial_video.parse': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1).nullable().optional(),
        texts: z.array(ivTextItemSchema).nullable().optional(),
        media: z.array(ivMediaItemSchema).nullable().optional(),
        logo: ivLogoItemSchema.nullable().optional(),
        voice: ivVoiceSchema.optional(),
        aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(),
        style: z.enum(['marketing', 'training']).optional(),
        ...ivSettingsShape
      })
      .strict(),
    output: z.object({
      jobId: z.string(),
      effectiveSettings: z.record(z.string(), z.unknown()).nullable().optional(),
      settingsVersion: z.number().nullable().optional()
    })
  }),

  /**
   * Read the planning context / fingerprints for a run (`planning_context_get`).
   */
  'industrial_video.planning_context_get': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1)
      })
      .strict(),
    output: z.record(z.string(), z.unknown())
  }),

  /**
   * Read the current storyboard for a run (`storyboard_get`).
   */
  'industrial_video.storyboard_get': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1),
        full: z.boolean().optional()
      })
      .strict(),
    output: z.record(z.string(), z.unknown())
  }),

  /**
   * Submit the user-confirmed storyboard draft (`storyboard_submit`).
   */
  'industrial_video.storyboard_submit': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1),
        storyboard: ivStoryboardSchema,
        expectedInputFingerprint: z.string(),
        expectedStoryboardSha256: z.string()
      })
      .strict(),
    output: z.object({ submitted: z.boolean(), reviewRequired: z.boolean() })
  }),

  /**
   * Generate video for a confirmed script (`video_start` stage `video`). Always
   * submits a real task and returns a `job_id`. The fee/range pre-check is the
   * separate `estimate` route (estimate_only returns no job and must not require one).
   */
  'industrial_video.video_start': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1),
        voice: ivVoiceSchema.optional(),
        aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(),
        style: z.enum(['marketing', 'training']).optional(),
        ...ivSettingsShape
      })
      .strict(),
    output: z.object({ jobId: z.string(), ...ivSettingsReceiptShape })
  }),

  /**
   * Fee / range pre-check before a paid submit (`video_start` with `estimate_only`).
   * Read-only: returns the server `estimate` object, requires NO `job_id`, and never
   * changes the persisted production state. Distinct from `video_start` so old
   * task-submitting callers keep expecting a job.
   */
  'industrial_video.estimate': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1),
        voice: ivVoiceSchema.optional(),
        aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(),
        style: z.enum(['marketing', 'training']).optional(),
        ...ivSettingsShape
      })
      .strict(),
    output: z.object({ estimate: z.record(z.string(), z.unknown()), ...ivSettingsReceiptShape })
  }),

  /**
   * Assemble from valid cached clips only (`video_start` stage `assemble`).
   */
  'industrial_video.assemble': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1)
      })
      .strict(),
    output: z.object({ jobId: z.string() })
  }),

  /**
   * Poll a job's status / blocking reason (`job_get`).
   */
  'industrial_video.job_get': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        jobId: z.string().trim().min(1),
        waitS: z.number().int().nonnegative().optional(),
        tailLines: z.number().int().nonnegative().optional()
      })
      .strict(),
    output: z.record(z.string(), z.unknown())
  }),

  /**
   * Force-regenerate a single failed scene (`scene_retry`).
   */
  'industrial_video.scene_retry': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1),
        sceneId: z.number().int()
      })
      .strict(),
    output: z.record(z.string(), z.unknown())
  }),

  /**
   * Read the quality gate / approval report (`qa_get`).
   */
  'industrial_video.qa_get': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1)
      })
      .strict(),
    output: z.record(z.string(), z.unknown())
  }),

  /**
   * (Re)build the web preview page for a finished run (`preview_create`).
   */
  'industrial_video.preview_create': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1),
        force: z.boolean().optional()
      })
      .strict(),
    output: z.record(z.string(), z.unknown())
  }),

  /**
   * Read an intermediate artifact (parsed text, facts, quality report, status.json…).
   * Read-only: never changes production state.
   */
  'industrial_video.artifact_read': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1),
        path: z.string().trim().min(1),
        maxChars: z.number().int().nonnegative().optional()
      })
      .strict(),
    output: z.record(z.string(), z.unknown())
  }),

  /**
   * Download one artifact file into the session's trusted workspace directory.
   *
   * The renderer supplies only `sessionId` / `run` / `path` (the server artifact
   * path) and an optional `expectedSize` (cross-checked against Content-Length).
   * It NEVER supplies a destination directory — the main process derives the real
   * workspace path from the trusted WorkspaceService by `workspaceId`, and the
   * service base URL + token come from the MAIN env only. The download is a
   * controlled side-effect: it writes the file but must NOT mutate the persisted
   * industrial-video production record (no round appended, no state change).
   */
  'industrial_video.save_artifact': defineRoute({
    input: z
      .object({ sessionId: sessionIdField, run: z.string().trim().min(1), path: z.string().trim().min(1) })
      .strict(),
    output: z.object({ filePath: z.string(), size: z.number() }).nullable()
  }),

  'industrial_video.download_artifact': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1),
        path: z.string().trim().min(1),
        expectedSize: z.number().int().nonnegative().optional()
      })
      .strict(),
    output: z.object({ filePath: z.string(), size: z.number() })
  }),

  /**
   * List tasks handled by the server (read-only) so the host can reconcile an
   * outcome-unknown submission by exact `job_id` — it must NOT auto-claim a run's
   * task. No session-owned mutation happens here.
   */
  'industrial_video.job_list': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        limit: z.number().int().nonnegative().optional()
      })
      .strict(),
    output: z.record(z.string(), z.unknown())
  }),

  /**
   * User-initiated cancellation of a specific job. The job must belong to this
   * session (matched by `job_id`, never inferred from `run`). The host persists the
   * cancel but never cancels on process/renderer exit.
   */
  'industrial_video.job_cancel': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        jobId: z.string().trim().min(1)
      })
      .strict(),
    output: z.record(z.string(), z.unknown())
  }),

  /**
   * Upload an explicit image/video material with a required caption. The host only
   * forwards an explicit `contentBase64` (or a previously-returned handle `name`);
   * it never lets the renderer hand the server an arbitrary `url` to fetch. Returns
   * the `name` handle usable by `parse`.
   */
  'industrial_video.media_upload': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        caption: z.string().trim().min(1),
        contentBase64: z.string().trim().min(1),
        name: z.string().trim().min(1).nullable().optional(),
        kind: z.enum(['image', 'video']).optional()
      })
      .strict(),
    output: z.object({ name: z.string() })
  }),

  /**
   * Upload the user's explicit brand logo (never derived/OCR-rebuilt). Only an
   * explicit `contentBase64` or a prior handle `name` is forwarded; no arbitrary URL.
   */
  'industrial_video.logo_upload': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        contentBase64: z.string().trim().min(1),
        name: z.string().trim().min(1).nullable().optional(),
        brandKind: z.enum(['company', 'product']).optional()
      })
      .strict(),
    output: z.object({ name: z.string() })
  }),

  /**
   * Read the persisted production record for a session (host-owned state the
   * renderer can use to restore the workflow after a restart or navigation).
   * Rounds are *production versions* (each carries its `version`, `run`, `jobId` and
   * `state`), not a flat HTTP log; the history of `run`/`jobId` is preserved.
   */
  /**
   * Upload a raw material file (image/video) as raw bytes. This is the canonical
   * new entry point: it POSTs the bytes verbatim to the service root `/upload`
   * (NOT `/api/video/...`), returns the server `name` handle usable by `parse`,
   * and never changes the host-owned production record. The token is held in the
   * main process only — the output is exactly `{ name }`, so no token / server
   * path ever reaches the renderer. Keep the old `media_upload` / `logo_upload`
   * JSON routes for backward compatibility; they are separate, base64 paths.
   */
  'industrial_video.upload': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        name: z.string().trim().min(1),
        content: uint8ArraySchema
      })
      .strict(),
    output: z.object({ name: z.string() })
  }),

  /**
   * Persist the review snapshot (script + storyboard) to the session's trusted
   * workspace as real `脚本.md` / `分镜脚本.md` files so the user can edit them
   * with the ordinary file preview's auto-save conflict detection. Write-only and
   * side-effect-local: it NEVER mutates the persisted production record (no round
   * appended, no state change). Reuses the same workspace resolution as
   * `download_artifact` (`getWorkspacePath`).
   */
  'industrial_video.snapshot_save': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1),
        script: z.string(),
        storyboard: z.string()
      })
      .strict(),
    output: z.object({ scriptPath: z.string(), storyboardPath: z.string() })
  }),

  'industrial_video.get_records': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField
      })
      .strict(),
    output: z
      .object({
        sessionId: z.string(),
        version: z.number(),
        run: z.string().nullable(),
        jobId: z.string().nullable(),
        state: z.string(),
        rounds: z.array(
          z.object({
            version: z.number(),
            operation: z.string(),
            run: z.string().nullable(),
            jobId: z.string().nullable(),
            state: z.string(),
            requestId: z.string(),
            at: z.number(),
            outcome: z.enum(['intended', 'ok', 'error', 'unknown']),
            detail: z.record(z.string(), z.unknown()).optional()
          })
        ),
        unknownSubmissions: z.array(
          z.object({
            version: z.number(),
            operation: z.string(),
            run: z.string().nullable(),
            jobId: z.string().nullable(),
            state: z.string(),
            requestId: z.string(),
            at: z.number(),
            outcome: z.enum(['intended', 'ok', 'error', 'unknown'])
          })
        ),
        control: industrialVideoControlSchema.optional(),
        updatedAt: z.number()
      })
      .nullable()
  }),

  /**
   * 打开服务端工作台（只读）。准备完脚本分镜后由主进程调用，返回可信工作台链接，
   * 供用户在工作台内完成脚本/分镜的审核与重规划（网页内部由服务端负责，主进程不管理）。
   * 真实响应字段名（如 workbench_url）可能与契约不同，service 层统一 normalize 为 workbench_url。
   * 校验 run 归属绑定：未显式传入时取当前会话已绑定 run；run 与实际归属不符则拒绝。
   */
  'industrial_video.workbench_open': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1).nullable().optional(),
        embed: z.boolean().optional()
      })
      .strict(),
    output: z
      .object({
        workbench_url: z.string(),
        run: z.string(),
        raw: z.record(z.string(), z.unknown()).optional()
      })
      .passthrough()
  }),

  /**
   * 读取服务端工作台最新状态（只读）。按当前 run 获取真实状态机与批准情况，由主进程在
   * 下次“生成”意图时读取，作为是否 submit 一次的可信依据。service 层消费真实契约字段：
   * generation_status（状态机）、needs_script_sync / document.needs_sync（同步）、
   * approved（来自真实批准读取接口 review_snapshot_get 的 generation_allowed + remaining_blockers），
   * approved_verified 表示批准是否经真实读取确认；认证不可用时 approved=false 且 approved_verified=false，
   * blockers 报告真实缺口。raw 始终保留供核对。
   */
  'industrial_video.workbench_get': defineRoute({
    input: z
      .object({
        sessionId: sessionIdField,
        run: z.string().trim().min(1)
      })
      .strict(),
    output: z
      .object({
        run: z.string(),
        generation_status: z.string(),
        needs_script_sync: z.boolean(),
        document_needs_sync: z.boolean(),
        approved: z.boolean(),
        approved_verified: z.boolean(),
        generatable: z.boolean(),
        blockers: z.array(z.string()),
        raw: z.record(z.string(), z.unknown())
      })
  })
}
