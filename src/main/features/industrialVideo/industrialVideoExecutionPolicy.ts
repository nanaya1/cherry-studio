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
查询与解释不需要创建制作任务。制作时获取最新 context 并提交完整分镜，再调用 ivideo_review_snapshot_get 获取服务端工作台链接。返回链接和引导语后必须结束本轮，不再调用工具、不使用 AskUserQuestion 审核，不在首次准备轮自动生成。全文、分镜编辑和审核及成本确认均在服务端网页完成。用户下一轮明确发送「开始生成视频」时调用 ivideo_start，由工业服务核验当前 run 的服务端最新状态；条件不足则返回工作台并结束本轮，不自动批准。不得覆盖网页已保存的设置。结果未知时只查询，不重复提交。
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
