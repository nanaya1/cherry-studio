import * as z from 'zod'

import { IpcError } from '@shared/ipc/errors/IpcError'

import snapshot from './storyboard.schema.json'

export const storyboardSchema: Record<string, unknown> = snapshot

function objectConstantSchema(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    required: Object.keys(value),
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? objectConstantSchema(item as Record<string, unknown>)
          : { const: item }
      ])
    )
  }
}

export function storyboardValidator(schema: Record<string, unknown>): z.ZodType {
  const normalized = JSON.parse(JSON.stringify(schema), (key, value) => {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (typeof value.minLength === 'number' || typeof value.maxLength === 'number')
    ) {
      // MEA:industrial-video 用码点正则替代 Zod UTF-16 长度，保留原 pattern/组合分支约束。
      const { minLength, maxLength, ...rest } = value
      const point = '(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|[^\\uD800-\\uDBFF])'
      return {
        ...rest,
        allOf: [
          ...(rest.allOf ?? []),
          {
            type: 'string',
            pattern: `^${point}{${minLength ?? 0},${maxLength ?? ''}}(?![\\s\\S])`
          }
        ]
      }
    }
    if (key === 'propertyNames' && Array.isArray(value?.enum)) {
      return { type: 'string', pattern: `^(?:${value.enum.join('|')})$` }
    }
    if (value?.const !== null && typeof value?.const === 'object' && !Array.isArray(value.const)) {
      // Zod literal 对对象比较引用；展开为严格结构，保留相邻 Schema 约束。
      return { ...value, const: undefined, allOf: [...(value.allOf ?? []), objectConstantSchema(value.const)] }
    }
    return value
  })
  return z.fromJSONSchema(normalized)
}

// Zod's JSON Schema converter omits these three structural constraints.
function validateCollections(schema: Record<string, unknown>, value: unknown, path: string, issues: string[]): void {
  // JSON Schema 的 minLength 不按 .trim() 计算，纯空白串会误判为满足长度约束；
  // 对声明了 minLength>=1 的字符串字段补一道空白核查（仅当声明长度约束时生效）。
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && schema.minLength >= 1 && value.trim().length === 0) {
      issues.push(`${path}: 不能仅含空白字符（minLength ${schema.minLength}）`)
    }
    return
  }
  if (Array.isArray(value)) {
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      issues.push(`${path}: uniqueItems，数组值不得重复`)
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) =>
        validateCollections(schema.items as Record<string, unknown>, item, `${path}[${index}]`, issues)
      )
    }
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (typeof schema.minProperties === 'number' && entries.length < schema.minProperties)
      issues.push(`${path}: minProperties，至少 ${schema.minProperties} 个对象，不能用空对象占位`)
    if (typeof schema.maxProperties === 'number' && entries.length > schema.maxProperties)
      issues.push(`${path}: maxProperties，最多 ${schema.maxProperties} 个对象`)
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    for (const [key, item] of entries) {
      const child = properties[key] ?? schema.additionalProperties
      if (child && typeof child === 'object') validateCollections(child, item, `${path}.${key}`, issues)
    }
  }
}

export function validateStageCapacity(task: Record<string, unknown>, output: Record<string, unknown>): void {
  const context = task.context as Record<string, unknown> | undefined
  const reject = (message: string): never => {
    throw new IpcError(
      'IVIDEO_STAGE_CAPACITY_INVALID',
      `客户端容量检查未通过，尚未提交保存：${message}。保留候选并停止，等待用户明确重试。`
    )
  }
  if (task.stage === 'outline') {
    const entities = output.entities as { attributes?: unknown[] }[] | undefined
    if (Array.isArray(entities) && entities.reduce((sum, entity) => sum + (entity.attributes?.length ?? 0), 0) > 24)
      reject('跨实体跟踪物理属性总数不得超过24项')
    const scenes = output.scenes as { narration_segment_ids?: string[] }[] | undefined
    if (Array.isArray(scenes) && scenes.some((scene) => Array.isArray(scene.narration_segment_ids))) {
      const parts = context?.document_segments as { id: string; text: string }[] | undefined
      if (!Array.isArray(parts) || parts.some((part) => typeof part.id !== 'string' || typeof part.text !== 'string'))
        reject('任务缺少完整document_segments，无法核对单镜头旁白容量，不猜测文本')
      const byId = new Map(parts!.map((part) => [part.id, part.text]))
      scenes.forEach((scene, index) => {
        const ids = scene.narration_segment_ids ?? []
        if (ids.some((id) => !byId.has(id))) reject(`镜头${index + 1}引用了任务中不存在的全文片段`)
        const length = Array.from(ids.map((id) => byId.get(id)!).join('')).length
        if (length > 800) reject(`镜头${index + 1}派生旁白${length}字符，超过800字符/每200字符一行最多4行`)
      })
    }
  }
  if (task.stage === 'copy' && Array.isArray(context?.narration_lines) && context.narration_lines.length > 4)
    reject('服务端派生旁白超过4行')
}

export function validateStateInvariants(task: Record<string, unknown>, output: Record<string, unknown>): void {
  const transition = output.state_transition as Record<string, unknown> | undefined
  const keys = transition?.invariant_keys
  if (!Array.isArray(keys) || keys.length === 0) return
  const context = task.context as Record<string, unknown> | undefined
  const before = (context?.locked_before ?? transition?.before) as Record<string, unknown> | undefined
  const after = transition?.after as Record<string, unknown> | undefined
  for (const key of keys) {
    const value = after?.[key]
    const reference =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      (value as Record<string, unknown>).from === 'before'
    if (
      !before ||
      !Object.hasOwn(before, key) ||
      !after ||
      !Object.hasOwn(after, key) ||
      (!reference && value !== before[key])
    ) {
      throw new IpcError(
        'IVIDEO_STATE_INVARIANT_INVALID',
        `客户端状态检查未通过，尚未提交保存：不变量 ${key} 的 before/after 不一致或缺失。保持不变的属性应引用 {"from":"before"}；不要把显示内容等变化混入完好状态。保留候选并停止，等待用户明确重试，不自动删改不变量或重提。`
      )
    }
  }
}

export function validateStoryboard(schema: Record<string, unknown>, candidate: unknown): void {
  try {
    if (schema.type !== 'object' || !schema.properties) throw new Error('服务端未提供完整 storyboard_schema')
    const result = storyboardValidator(schema).safeParse(candidate)
    const issues = result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    validateCollections(schema, candidate, 'storyboard', issues)
    if (issues.length) throw new Error(issues.join('；'))
  } catch (error) {
    throw new IpcError(
      'IVIDEO_STORYBOARD_SCHEMA_INVALID',
      `分镜结构校验失败：${error instanceof Error ? error.message : String(error)}。请由当前选中模型按最新上下文修正；不得原样重提。`
    )
  }
}

// 全文长度按 JSON Schema / 服务端 Unicode 码点计数，避免 UTF-16 误拒合法正文。
export function validateFullScript(schema: Record<string, unknown>, text: string): void {
  if (schema.type !== 'object' || !schema.properties) {
    throw new IpcError('IVIDEO_FULL_SCRIPT_SCHEMA_INVALID', '服务端未提供完整 full_script output_schema。')
  }
  const textSchema = (schema.properties as Record<string, Record<string, unknown>>)?.text
  const length = Array.from(text).length
  if (textSchema && typeof textSchema === 'object') {
    if (typeof textSchema.maxLength === 'number' && length > textSchema.maxLength) {
      const excess = length - textSchema.maxLength
      throw new IpcError(
        'IVIDEO_FULL_SCRIPT_SCHEMA_INVALID',
        `全文 text 超出动态上限：上限 ${textSchema.maxLength} 字符，实际 ${length} 字符，超出 ${excess} 字符。客户端校验未通过，尚未提交保存；候选稿不变。请等待用户明确要求重试后重新获取任务，由当前选中模型按最新上下文修正，不得原样重提或截断。`
      )
    }
    if (typeof textSchema.minLength === 'number' && textSchema.minLength >= 1 && length < textSchema.minLength) {
      throw new IpcError(
        'IVIDEO_FULL_SCRIPT_SCHEMA_INVALID',
        `全文 text 不足动态下限：下限 ${textSchema.minLength} 字符，实际 ${length} 字符。客户端校验未通过，尚未提交保存；请等待用户明确要求重试后按最新任务修正，不得原样重提。`
      )
    }
  }
  try {
    const structuralSchema = structuredClone(schema)
    const properties = structuralSchema.properties as Record<string, Record<string, unknown>>
    if (properties.text) {
      delete properties.text.minLength
      delete properties.text.maxLength
    }
    const result = storyboardValidator(structuralSchema).safeParse({ text })
    const issues = result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    validateCollections(schema, { text }, 'full_script', issues)
    if (issues.length) throw new Error(issues.join('；'))
  } catch (error) {
    throw new IpcError(
      'IVIDEO_FULL_SCRIPT_SCHEMA_INVALID',
      `全文结构校验失败：${error instanceof Error ? error.message : String(error)}。请由当前选中模型按最新上下文修正；不得原样重提。`
    )
  }
}
