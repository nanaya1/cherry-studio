import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import type { AgentRuntimeEvent, AgentRuntimeUserInput } from '@main/ai/runtime/types'

import { parseStructuredAction } from './structuredAction/structuredActionProtocol'

// 安全诊断只携带白名单 finishReason 与有限非负整数 token 计数，绝不引用正文或原始用量对象。
const logger = loggerService.withContext('IndustrialVideoStructuredConnection')

// 结构化诊断 finishReason 白名单；任何未识别值一律归 unknown，不得假装可判定截断等语义。
export type IndustrialVideoStructuredFinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | 'unknown'

const INDUSTRIAL_VIDEO_FINISH_REASONS: ReadonlySet<string> = new Set<IndustrialVideoStructuredFinishReason>([
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
  'unknown'
])

// 模型可选回传的诊断；token 计数仅允许有限非负整数，缺失或非法一律丢弃。
export interface IndustrialVideoStructuredDiagnostics {
  finishReason?: IndustrialVideoStructuredFinishReason
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

function sanitizeNonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

// 将任意（可能恶意的）原始诊断收敛为严格白名单形状，缺失或非法值丢弃而非透传。
export function createIndustrialVideoStructuredDiagnostics(input: {
  finishReason?: unknown
  inputTokens?: unknown
  outputTokens?: unknown
  totalTokens?: unknown
}): IndustrialVideoStructuredDiagnostics {
  const finishReason =
    typeof input.finishReason === 'string' && INDUSTRIAL_VIDEO_FINISH_REASONS.has(input.finishReason)
      ? (input.finishReason as IndustrialVideoStructuredFinishReason)
      : 'unknown'
  return {
    finishReason,
    inputTokens: sanitizeNonNegativeInt(input.inputTokens),
    outputTokens: sanitizeNonNegativeInt(input.outputTokens),
    totalTokens: sanitizeNonNegativeInt(input.totalTokens)
  }
}

/**
 * One step of the conversation the model sees: the user's request, a tool result, or a host
 * correction. Kept as plain strings so the production model wrapper can map them onto provider
 * messages without depending on the renderer's part shape.
 */
export interface StructuredTranscriptEntry {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  tool?: string
  args?: Record<string, unknown>
  toolCallId?: string
}

/** Decoupled, testable model boundary — production wires this to {@link AiService.generateText}. */
export interface IndustrialVideoStructuredModel {
  generateText(input: {
    system: string
    transcript: readonly StructuredTranscriptEntry[]
    signal?: AbortSignal
  }): Promise<{ text: string; diagnostics?: IndustrialVideoStructuredDiagnostics }>
}

/**
 * Trusted tool boundary. Production routes white-listed `ivideo_*` actions through the existing
 * {@link IndustrialVideoService} methods inside the session's `withExecution` token, so the model
 * can never call a tool the host did not authorize or execute an action outside the trusted
 * contract. Failures surface as `ok: false` and are never reported as a successful action.
 */
export interface IndustrialVideoStructuredToolExecutor {
  execute(
    tool: string,
    args: Record<string, unknown>,
    token: Readonly<{ sessionId: string; epoch: number }>,
    signal?: AbortSignal
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string; retryable?: boolean }>
}

export interface IndustrialVideoStructuredConnectionDeps {
  sessionId: string
  executionToken: Readonly<{ sessionId: string; epoch: number }>
  model: IndustrialVideoStructuredModel
  toolExecutor: IndustrialVideoStructuredToolExecutor
  allowedTools: ReadonlySet<string>
  loadInitialTranscript?: (input: AgentRuntimeUserInput) => StructuredTranscriptEntry[]
  afterTool?: (tool: string, signal: AbortSignal, emit: (event: AgentRuntimeEvent) => void) => Promise<unknown>
  /** 独立业务编排入口，仅显式dedicated-flow绑定注入；旧structured循环保持不变。 */
  runBusinessTurn?: (input: {
    userText: string
    signal: AbortSignal
    model: IndustrialVideoStructuredModel
    execute: (tool: string, args: Record<string, unknown>) => Promise<unknown>
    review: () => Promise<unknown>
  }) => Promise<string>
  /** System instruction that forces the strict single-action / final-reply JSON contract. */
  systemPrompt: string
  /** 合法结构化步骤的硬上限；协议纠正独立且每轮最多一次。 */
  stepCap: number
  /** Extract the user-visible text of an admitted user message. */
  extractUserText: (input: AgentRuntimeUserInput) => string
}

/**
 * Independent industrial-video connection adapter for the `structured-action` execution mode.
 *
 * It is a self-contained {@link AgentRuntimeConnection}: it drives the model one strict-JSON step
 * at a time, executes only white-listed tools through the trusted executor, and ends the turn on a
 * final reply. It deliberately does NOT delegate to the Claude Code driver — general/native/legacy
 * sessions keep their existing path; this adapter only serves industrial sessions bound to
 * `structured-action`. The model's plain-text capability is used (no model-name special-casing):
 * the system prompt constrains the output to the protocol and the host parses it.
 */
export class IndustrialVideoStructuredConnection {
  readonly events: AsyncIterable<AgentRuntimeEvent>
  readonly usageCapture = { owner: 'provider-calls' } as const

  private readonly deps: IndustrialVideoStructuredConnectionDeps
  private readonly abortController = new AbortController()
  private readonly eventQueue: AgentRuntimeEvent[] = []
  private readonly eventWaiters: Array<() => void> = []
  private eventDone = false
  private processing: Promise<void> | null = null
  private readonly pendingInputs: string[] = []
  private transcript: StructuredTranscriptEntry[] = []
  private stepCount = 0
  private readonly textId: string

  private readonly emit = (event: AgentRuntimeEvent): void => {
    if (this.eventDone || this.abortController.signal.aborted) return
    this.eventQueue.push(event)
    const waiter = this.eventWaiters.shift()
    if (waiter) waiter()
  }

  constructor(deps: IndustrialVideoStructuredConnectionDeps) {
    this.deps = deps
    this.textId = `s-${Math.abs(hashString(deps.sessionId))}`
    this.events = this.createEventIterator()
  }

  send(input: AgentRuntimeUserInput): void {
    if (this.abortController.signal.aborted) return
    if (this.eventDone) return
    if (!this.processing && this.transcript.length === 0) {
      this.transcript = this.deps.loadInitialTranscript?.(input) ?? []
    }
    this.pendingInputs.push(this.deps.extractUserText(input))
    void this.kick()
  }

  /** Mode is frozen at creation; the connection's spawn config never drifts, so it is always current. */
  async reconcile(): Promise<'current'> {
    return 'current'
  }

  close(): void {
    if (this.abortController.signal.aborted) return
    this.abortController.abort()
    this.finishEvents()
  }

  private async kick(): Promise<void> {
    if (this.processing) return
    this.processing = this.run()
      .catch((error) => {
        this.emit({ type: 'error', error })
        this.finishEvents()
      })
      .finally(() => {
        this.processing = null
      })
    await this.processing
  }

  private async run(): Promise<void> {
    while (this.pendingInputs.length > 0 && !this.abortController.signal.aborted) {
      const userText = this.pendingInputs.shift()!
      if (userText.trim()) this.transcript.push({ role: 'user', content: userText })
      // await this.runTurn()
      if (this.deps.runBusinessTurn) {
        const reply = await this.deps.runBusinessTurn({
          userText,
          signal: this.abortController.signal,
          model: this.deps.model,
          execute: async (tool, args) => {
            this.abortController.signal.throwIfAborted()
            const toolCallId = randomUUID()
            this.emit({
              type: 'chunk',
              chunk: { type: 'tool-input-available', toolCallId, toolName: tool, input: args }
            })
            const result = await this.deps.toolExecutor.execute(
              tool,
              args,
              this.deps.executionToken,
              this.abortController.signal
            )
            if (!result.ok) {
              this.emit({ type: 'chunk', chunk: { type: 'tool-output-error', toolCallId, errorText: result.error } })
              throw new Error(result.error)
            }
            this.emit({ type: 'chunk', chunk: { type: 'tool-output-available', toolCallId, output: result.result } })
            return result.result
          },
          review: async () =>
            this.deps.afterTool?.(
              'mcp__meacowork-tools__ivideo_review_snapshot_get',
              this.abortController.signal,
              this.emit
            )
        })
        this.abortController.signal.throwIfAborted()
        this.emit({ type: 'chunk', chunk: { type: 'text-start', id: this.textId } })
        this.emit({ type: 'chunk', chunk: { type: 'text-delta', id: this.textId, delta: reply } })
        this.emit({ type: 'chunk', chunk: { type: 'text-end', id: this.textId } })
      } else await this.runTurn()
      if (this.abortController.signal.aborted) break
    }
    // A turn may have produced no reply (e.g. aborted) — still close the turn cleanly.
    this.emit({ type: 'turn-complete' })
    this.finishEvents()
  }

  private async runTurn(): Promise<void> {
    let correctionUsed = false
    while (!this.abortController.signal.aborted) {
      if (this.stepCount >= this.deps.stepCap) {
        this.emit({
          type: 'error',
          error: new Error('structured-action step cap exceeded; refusing to continue')
        })
        return
      }
      let text: string
      let result: Awaited<ReturnType<IndustrialVideoStructuredModel['generateText']>>
      try {
        result = await this.deps.model.generateText({
          system: this.deps.systemPrompt,
          transcript: this.transcript,
          signal: this.abortController.signal
        })
        text = result.text
      } catch (error) {
        if (this.abortController.signal.aborted) return
        // A model failure must not be reported as a successful action.
        this.emit({ type: 'error', error })
        return
      }
      // A stop/close fired during generation must not start a tool.
      if (this.abortController.signal.aborted) return

      const parsed = parseStructuredAction(text, this.deps.allowedTools)
      if (!parsed.ok) {
        this.recordParseDiagnostics({ text, diagnostics: result.diagnostics, reason: parsed.reason, correctionUsed })
        if (correctionUsed) {
          this.emit({
            type: 'error',
            error: new Error(`结构化输出纠正失败（reason: ${parsed.reason}），已用完 1 次纠正，停止执行。`)
          })
          return
        }
        correctionUsed = true
        // 仅回传解析器的固定 reason，不记录或回显未经解析的敏感回复。
        this.transcript.push({
          role: 'system',
          // content: `输出不符合协议（reason: ${parsed.reason}）：必须仅输出单个严格 JSON 动作或最终答复，工具名必须逐字使用工具契约中的 name。仅允许本次纠正。`
          content:
            `输出不符合协议（reason: ${parsed.reason}）：必须仅输出单个严格 JSON 动作或最终答复，工具名必须逐字使用工具契约中的 name。` +
            (parsed.reason === 'not_json'
              ? '请重新输出完整对象，检查 action、args 及外层对象全部闭合；动作结构为 {"action":{"tool":"工具契约中的完整 name","args":{}}}，将真实参数完整放入 args。不要只输出补丁或缺失字符，不要使用省略号或 Markdown 代码围栏。'
              : '') +
            '仅允许本次纠正。'
        })
        continue
      }
      this.stepCount++

      if (parsed.action.kind === 'reply') {
        this.transcript.push({ role: 'assistant', content: parsed.action.text })
        this.emit({ type: 'chunk', chunk: { type: 'text-start', id: this.textId } })
        this.emit({ type: 'chunk', chunk: { type: 'text-delta', id: this.textId, delta: parsed.action.text } })
        this.emit({ type: 'chunk', chunk: { type: 'text-end', id: this.textId } })
        return
      }

      // Single tool action — execute only through the trusted executor.
      const { tool, args } = parsed.action
      const toolCallId = randomUUID()
      this.transcript.push({ role: 'assistant', content: text, tool, args, toolCallId })
      this.emit({ type: 'chunk', chunk: { type: 'tool-input-available', toolCallId, toolName: tool, input: args } })
      let exec: Awaited<ReturnType<IndustrialVideoStructuredToolExecutor['execute']>>
      try {
        exec = await this.deps.toolExecutor.execute(tool, args, this.deps.executionToken, this.abortController.signal)
      } catch (error) {
        if (this.abortController.signal.aborted) return
        const errorText = error instanceof Error ? error.message : String(error)
        this.transcript.push({ role: 'tool', content: errorText, toolCallId })
        this.emit({ type: 'chunk', chunk: { type: 'tool-output-error', toolCallId, errorText } })
        throw error
      }
      if (this.abortController.signal.aborted) return
      if (!exec.ok) {
        this.transcript.push({ role: 'tool', content: exec.error, toolCallId })
        this.emit({ type: 'chunk', chunk: { type: 'tool-output-error', toolCallId, errorText: exec.error } })
        if (exec.retryable === true) continue
        this.emit({ type: 'error', error: new Error(`工具执行失败：${exec.error}`) })
        return
      }
      this.emit({ type: 'chunk', chunk: { type: 'tool-output-available', toolCallId, output: exec.result } })
      this.transcript.push({
        role: 'tool',
        toolCallId,
        content: typeof exec.result === 'string' ? exec.result : JSON.stringify(exec.result)
      })
      const review = await this.deps.afterTool?.(parsed.action.tool, this.abortController.signal, this.emit)
      if (this.abortController.signal.aborted) return
      if (review !== undefined) this.transcript.push({ role: 'system', content: JSON.stringify(review) })
    }
  }

  // 仅记录与解析失败相关的白名单元数据；正文、前缀后缀、完整 usage、error.message 与响应对象一律不入日志。
  private recordParseDiagnostics(params: {
    text: string
    diagnostics: IndustrialVideoStructuredDiagnostics | undefined
    reason: string
    correctionUsed: boolean
  }): void {
    const diagnostics = createIndustrialVideoStructuredDiagnostics(params.diagnostics ?? {})
    let jsonErrorPosition: number | undefined
    try {
      JSON.parse(params.text)
    } catch (error) {
      // 仅从解析错误提取位置数字，绝不记录 error.message 或正文。
      if (error instanceof Error) {
        const match = /position (\d+)/i.exec(error.message)
        if (match) jsonErrorPosition = Number(match[1])
      }
    }
    const trimmed = params.text.trim()
    const context: {
      reason: string
      step: number
      correctionUsed: boolean
      textLength: number
      startsWithObject: boolean
      endsWithObject: boolean
      finishReason: IndustrialVideoStructuredFinishReason
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
      jsonErrorPosition?: number
    } = {
      reason: params.reason,
      step: this.stepCount,
      correctionUsed: params.correctionUsed,
      textLength: params.text.length,
      startsWithObject: trimmed.startsWith('{'),
      endsWithObject: trimmed.endsWith('}'),
      finishReason: diagnostics.finishReason ?? 'unknown',
      inputTokens: diagnostics.inputTokens,
      outputTokens: diagnostics.outputTokens,
      totalTokens: diagnostics.totalTokens
    }
    if (jsonErrorPosition !== undefined) context.jsonErrorPosition = jsonErrorPosition
    logger.warn('industrial-video structured parse failed', context)
  }

  private async *createEventIterator(): AsyncGenerator<AgentRuntimeEvent> {
    while (true) {
      if (this.eventQueue.length === 0) {
        if (this.eventDone) return
        await new Promise<void>((resolve) => this.eventWaiters.push(resolve))
        continue
      }
      yield this.eventQueue.shift()!
    }
  }

  private finishEvents(): void {
    if (this.eventDone) return
    this.eventDone = true
    const waiter = this.eventWaiters.shift()
    if (waiter) waiter()
  }
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return hash
}
