import { describe, expect, it } from 'vitest'

import {
  type DiffEntry,
  computeStoryboardDiff,
  isAllowableModification,
  normalizeAllowedPaths,
  parseStoryboardText,
  validateStoryboard
} from './industrialVideoValidation'

// 最小合规分镜（等价于 MCP storyboard_schema）。
function validStoryboard() {
  return {
    video_title: '测试视频',
    scenes: [
      {
        id: 1,
        title: 'Intro',
        duration: 8,
        prompt: 'A factory floor with robots.',
        prompt_en: 'A factory floor with robots and bright lighting.',
        narration: [{ text: '欢迎来到本工厂', start: 0, end: 3 }]
      }
    ]
  }
}

describe('工业视频分镜校验（等价 MCP schema + 唯一 id + 旁白时间）', () => {
  it('有效 JSON 通过校验', () => {
    const result = validateStoryboard(validStoryboard())
    expect(result.ok).toBe(true)
  })

  it('prompt_en 缺失被拒绝', () => {
    const value = validStoryboard()
    delete (value.scenes[0] as Record<string, unknown>).prompt_en
    const result = validateStoryboard(value)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((message) => message.includes('prompt_en'))).toBe(true)
    }
  })

  it('旁白越界（超过 26 字）被拒绝', () => {
    const value = validStoryboard()
    value.scenes[0].narration = [{ text: '一'.repeat(27), start: 0, end: 3 }]
    const result = validateStoryboard(value)
    expect(result.ok).toBe(false)
  })

  it('旁白时间非法（start >= end）被拒绝', () => {
    const value = validStoryboard()
    value.scenes[0].narration = [{ text: '欢迎', start: 3, end: 3 }]
    const result = validateStoryboard(value)
    expect(result.ok).toBe(false)
  })

  it('旁白结束时间超出镜头时长被拒绝', () => {
    const value = validStoryboard()
    value.scenes[0].narration = [{ text: '欢迎', start: 0, end: 10 }] // duration=8
    const result = validateStoryboard(value)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((message) => message.includes('超出镜头时长'))).toBe(true)
    }
  })

  it('scene/分镜级别未知字段被保留（loose），便于 diff 比较', () => {
    const value = validStoryboard()
    ;(value.scenes[0] as Record<string, unknown>).extra_field = 'should-keep'
    ;(value as Record<string, unknown>).meta = { source: 'mcp' }
    const result = validateStoryboard(value)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.data.scenes[0] as Record<string, unknown>).extra_field).toBe('should-keep')
      expect((result.data as Record<string, unknown>).meta).toEqual({ source: 'mcp' })
    }
  })

  it('重复 id 被拒绝', () => {
    const value = validStoryboard()
    value.scenes.push({ ...value.scenes[0], id: 1, title: 'Dup' })
    const result = validateStoryboard(value)
    expect(result.ok).toBe(false)
  })

  it('解析模型返回的 JSON 文本（含代码围栏）得到分镜', () => {
    const text = '```json\n' + JSON.stringify(validStoryboard()) + '\n```'
    const result = parseStoryboardText(text)
    expect(result.ok).toBe(true)
  })
})

describe('定向修改的允许路径越界控制', () => {
  const before = validStoryboard()
  const after = validStoryboard()
  after.scenes[0].duration = 12 // 仅修改 /scenes/0/duration

  function diffOf(): DiffEntry[] {
    return computeStoryboardDiff(before, after)
  }

  it('限定修改越界：变更落在未开放路径被拒绝并保留原分镜', () => {
    const allowed = normalizeAllowedPaths('/scenes/0/title')
    expect(allowed.ok).toBe(true)
    if (!allowed.ok) return
    const diff = diffOf()
    const verdict = isAllowableModification(diff, allowed.paths)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.rejectedPaths).toContain('/scenes/0/duration')
    }
  })

  it('允许修改：变更落在开放路径被接受', () => {
    const allowed = normalizeAllowedPaths('/scenes/0/duration')
    expect(allowed.ok).toBe(true)
    if (!allowed.ok) return
    const verdict = isAllowableModification(diffOf(), allowed.paths)
    expect(verdict.ok).toBe(true)
  })

  it('允许路径不能为空', () => {
    const result = normalizeAllowedPaths('   \n  ')
    expect(result.ok).toBe(false)
  })

  it('允许路径不能以根路径放开所有字段', () => {
    const result = normalizeAllowedPaths('/')
    expect(result.ok).toBe(false)
  })
})
