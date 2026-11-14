import { toMeacoworkToolRuntimeName } from '@shared/ai/meacoworkTools'

export const INDUSTRIAL_VIDEO_TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  [toMeacoworkToolRuntimeName('ivideo_run_create')]: '创建视频项目',
  [toMeacoworkToolRuntimeName('ivideo_parse')]: '解析制作资料',
  [toMeacoworkToolRuntimeName('ivideo_context')]: '获取制作依据',
  [toMeacoworkToolRuntimeName('ivideo_full_script_task_get')]: '获取全文生成任务',
  [toMeacoworkToolRuntimeName('ivideo_full_script_task_submit')]: '提交全文生成稿',
  [toMeacoworkToolRuntimeName('ivideo_storyboard_task_get')]: '获取分镜生成任务',
  [toMeacoworkToolRuntimeName('ivideo_storyboard_stage_task_get')]: '获取分镜阶段任务',
  [toMeacoworkToolRuntimeName('ivideo_storyboard_stage_submit')]: '提交分镜阶段结果',
  [toMeacoworkToolRuntimeName('ivideo_cowork_review_get')]: '获取全文与分镜审核内容',
  [toMeacoworkToolRuntimeName('ivideo_storyboard_get')]: '读取分镜脚本',
  [toMeacoworkToolRuntimeName('ivideo_storyboard_submit')]: '提交脚本与分镜',
  [toMeacoworkToolRuntimeName('ivideo_review_snapshot_get')]: '准备脚本与分镜审核',
  [toMeacoworkToolRuntimeName('ivideo_status')]: '查询制作进度',
  [toMeacoworkToolRuntimeName('ivideo_estimate')]: '估算制作费用',
  [toMeacoworkToolRuntimeName('ivideo_start')]: '启动视频生成',
  [toMeacoworkToolRuntimeName('ivideo_download')]: '下载视频文件'
}
