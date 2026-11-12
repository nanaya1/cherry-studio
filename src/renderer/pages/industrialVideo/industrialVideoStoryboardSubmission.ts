import type { IndustrialVideoProductionRecord } from '@shared/data/cache/cacheValueTypes'

const rootKeys = ['video_title', 'video_subtitle', 'worker_look', 'end_notes', 'scenes']
const sceneKeys = [
  'id',
  'scene_uid',
  'title',
  'duration',
  'prompt',
  'prompt_en',
  'warning',
  'category',
  'camera',
  'state_after',
  'continuity_group',
  'continuity_reset',
  'location_id',
  'story_beat',
  'transition_to_next',
  'media_refs',
  'narration'
]

function pick(input: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(Object.entries(input).filter(([key]) => keys.includes(key)))
}

// 服务端返回快照包含只读元数据；提交只接受 storyboard_schema 中的字段。
export function projectStoryboardSubmission(input: { video_title: string; scenes: Record<string, unknown>[] }) {
  return {
    ...pick(input, rootKeys),
    video_title: input.video_title,
    scenes: input.scenes.map((scene) => ({
      ...pick(scene, sceneKeys),
      ...(Array.isArray(scene.narration)
        ? { narration: scene.narration.map((item) => pick(item, ['text', 'start', 'end'])) }
        : {})
    }))
  }
}

export function canResubmitAfterStoryboardError(
  record:
    | Pick<IndustrialVideoProductionRecord, 'run' | 'state' | 'jobId' | 'unknownSubmissions' | 'rounds'>
    | null
    | undefined,
  job?: Record<string, unknown> | null
): boolean {
  if (!record || record.state !== 'failed' || !record.run || record.jobId || record.unknownSubmissions.length)
    return false
  if (['queued', 'running'].includes(String(job?.status))) return false
  const last = record.rounds.at(-1)
  // record.jobId 已在顶部判空；末轮若已生成 jobId 则不应再手工重提交。
  return (
    last?.operation === 'storyboard_submit' && last.run === record.run && last.outcome === 'error' && last.jobId == null
  )
}
