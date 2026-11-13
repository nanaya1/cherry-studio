import * as z from 'zod'

import { IpcError } from '@shared/ipc/errors/IpcError'

import snapshot from './storyboard.schema.json'

export const storyboardSchema: Record<string, unknown> = snapshot

export function storyboardValidator(schema: Record<string, unknown>): z.ZodType {
  const normalized = JSON.parse(JSON.stringify(schema), (key, value) => {
    if (key === 'propertyNames' && Array.isArray(value?.enum)) {
      return { type: 'string', pattern: `^(?:${value.enum.join('|')})$` }
    }
    return value
  })
  return z.fromJSONSchema(normalized)
}

// Zod's JSON Schema converter omits these three structural constraints.
function validateCollections(schema: Record<string, unknown>, value: unknown, path: string, issues: string[]): void {
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
      if (child && typeof child === 'object')
        validateCollections(child, item, `${path}.${key}`, issues)
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
