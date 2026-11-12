import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

interface StructuredSettingsDeps {
  call: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<CallToolResult>
  getRecord: () =>
    | {
        run: string | null
        state: string
        jobId?: string | null
        rounds: readonly {
          run?: string | null
          jobId?: string | null
          operation?: string
          outcome?: string
          state?: string
        }[]
        unknownSubmissions: readonly unknown[]
      }
    | null
    | undefined
  assertExecution: () => void
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function receipt(result: CallToolResult): Record<string, unknown> {
  const text = result.content.filter((part) => part.type === 'text')
  if (text.length !== 1 || text[0].type !== 'text') throw new Error('缺少正式设置回执')
  const data = object(JSON.parse(text[0].text))
  if (!data || data.ok !== true) throw new Error('无效的正式设置回执')
  return data
}

// MEA:industrial-video 仅 structured 执行轮次持有设置意图，不从历史对话或自然语言推断。
export function createIndustrialVideoStructuredSettingsExecutor(deps: StructuredSettingsDeps) {
  const intents = new Map<string, Record<string, unknown>>()
  const unverified = new Set<string>()

  function assertBound(run: unknown, signal?: AbortSignal) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    deps.assertExecution()
    const record = deps.getRecord()
    if (typeof run !== 'string' || !record || record.run !== run) throw new Error('工业任务归属已变化或未绑定')
    if (record.unknownSubmissions.length) throw new Error('存在未知写结果，只允许查询，不得重新提交')
    return record
  }

  function verify(run: string, settings: unknown) {
    const actual = object(settings)
    for (const [key, value] of Object.entries(intents.get(run) ?? {})) {
      if (!actual || actual[key] !== value) throw new Error('生效设置与本轮明确提交的参数不符，停止后续制作')
    }
  }

  return async (tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> => {
    const settingsAction = ['ivideo_parse', 'ivideo_estimate', 'ivideo_start'].includes(tool)
    const downstream = ['ivideo_storyboard_submit', 'ivideo_review_snapshot_get', 'ivideo_start'].includes(tool)
    const run = args.run as string
    if (!settingsAction && !(downstream && intents.has(run))) return deps.call(tool, args, signal)
    const record = assertBound(run, signal)
    if (downstream && unverified.has(run)) throw new Error('本轮生效设置尚未核验，停止后续制作')
    if (
      tool === 'ivideo_parse' &&
      record.state === 'done' &&
      record.jobId &&
      record.rounds.some(
        (round) =>
          round.run === run &&
          round.jobId === record.jobId &&
          round.outcome === 'ok' &&
          ['video_start', 'assemble'].includes(round.operation ?? '')
      )
    ) {
      throw new Error('已完成任务请先明确创建返修 run，不能继承旧设置版本')
    }
    const initialParse =
      tool === 'ivideo_parse' &&
      record.state === 'idle' &&
      args.expectedSettingsVersion === undefined &&
      record.rounds.some((round) => round.run === run && round.operation === 'run_create' && round.outcome === 'ok') &&
      !record.rounds.some((round) => round.run === run && round.operation === 'parse')
    // 服务端首次 parse 才初始化 run；新建回执不能用于提前查询规划上下文。
    const contextResult = initialParse ? undefined : await deps.call('ivideo_context', { run }, signal)
    assertBound(run, signal)
    if (contextResult?.isError) return contextResult
    const context = contextResult ? receipt(contextResult) : {}
    if (context.run !== undefined && context.run !== run) throw new Error('正式 context 归属不符')
    if (downstream) verify(run, context.effective_settings)
    let boundArgs = args
    if (settingsAction) {
      const effective = object(context.effective_settings)
      const version = context.settings_version ?? effective?.settings_version
      if (version === undefined && initialParse && args.expectedSettingsVersion === undefined) {
        boundArgs = args
      } else {
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
          throw new Error('正式 context 缺少有效设置版本，不得猜测')
        }
        if (args.expectedSettingsVersion !== undefined && args.expectedSettingsVersion !== version) {
          throw new Error('设置版本冲突，拒绝覆盖模型显式版本或重试写入')
        }
        boundArgs = { ...args, expectedSettingsVersion: version }
      }
    }
    if (tool === 'ivideo_parse') {
      const intent = { ...intents.get(run) }
      if (args.targetDurationS !== undefined) intent.target_duration_s = args.targetDurationS
      if (args.ttsEnabled !== undefined) intent.tts_enabled = args.ttsEnabled
      intents.set(run, intent)
      unverified.add(run)
    } else if (tool === 'ivideo_start') {
      const intent = intents.get(run)
      if (
        intent &&
        ((args.targetDurationS !== undefined &&
          'target_duration_s' in intent &&
          args.targetDurationS !== intent.target_duration_s) ||
          (args.ttsEnabled !== undefined && 'tts_enabled' in intent && args.ttsEnabled !== intent.tts_enabled))
      ) {
        throw new Error('生效设置意图不能在启动时被覆盖')
      }
    }
    assertBound(run, signal)
    const result = await deps.call(tool, boundArgs, signal)
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    deps.assertExecution()
    if (result.isError) return result
    if (tool === 'ivideo_parse') {
      assertBound(run, signal)
      const data = receipt(result)
      if (data.run !== undefined && data.run !== run) throw new Error('parse 回执归属已变化')
      verify(run, data.effectiveSettings)
      unverified.delete(run)
    }
    return result
  }
}
