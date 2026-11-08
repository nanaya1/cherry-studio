import { normalizeMeacoworkToolRuntimeName, toMeacoworkToolRuntimeName } from '@shared/ai/meacoworkTools'

const INDUSTRIAL_VIDEO_TOOLS: ReadonlySet<string> = new Set(
  [
    'ivideo_run_create',
    'ivideo_context',
    'ivideo_storyboard_get',
    'ivideo_storyboard_submit',
    'ivideo_review_snapshot_get',
    'ivideo_parse',
    'ivideo_estimate',
    'ivideo_start',
    'ivideo_status',
    'ivideo_download'
  ].map(toMeacoworkToolRuntimeName)
)

export const INDUSTRIAL_VIDEO_PRODUCTION_PROMPT = `## 工业视频受控制作
模型负责理解素材、澄清需求、规划与修改脚本和完整分镜。解析、素材登记、审核、生成、配音字幕、合成及产物管理只能通过工业视频业务服务完成；不得用本地命令、代码、技能、子代理或外部生成服务替代。
查询与解释不需要创建制作任务。制作时获取最新 context 并提交完整分镜，读取真实审核快照，由用户在可信控件确认当前版本。可信审核通过后保持已审核参数不变，直接 start 一次，不调用 estimate，不增加费用确认。结果未知时只查询，不重复提交。
成片默认在线预览，仅在用户明确要求下载时调用 ivideo_download。不能提供的能力应明确说明，不下载原片到本地剪辑。`

export const INDUSTRIAL_VIDEO_BOUNDARY_REASON =
  '工业视频会话只能通过工业视频业务工具制作视频；禁止本地命令、代码执行、外部生成服务、技能及子代理。请使用已有素材与工业视频服务，缺少能力时明确说明。'

export function assertIndustrialVideoRuntime(featureKind: string | undefined, runtime: string): void {
  if (featureKind === 'industrial-video' && runtime !== 'claude-code') {
    throw new Error('工业视频当前仅支持已接入执行防线的 Claude Code 运行时，请切换运行时后重试。')
  }
}

export function isIndustrialVideoToolAllowed(toolName: string): boolean {
  return toolName === 'AskUserQuestion' || INDUSTRIAL_VIDEO_TOOLS.has(normalizeMeacoworkToolRuntimeName(toolName))
}
