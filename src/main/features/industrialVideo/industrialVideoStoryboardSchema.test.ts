import { describe, expect, it } from 'vitest'

import { storyboardSchema, validateStoryboard } from './industrialVideoStoryboardSchema'

const candidate = () => ({
  video_title: '设备检查',
  scenes: [
    {
      id: 1,
      title: '观察设备',
      duration: 5,
      prompt: '观察设备外观并展示设备的现有状态',
      narration: [],
      operation_type: 'inspect',
      granularity: 'component',
      operation_type_options: ['inspect'],
      granularity_options: ['component'],
      scene_uid: 'scene-1',
      media_refs: ['asset-1'],
      media_notes: { 'asset-1': '外观' },
      state_transition: {
        before: { 设备: '静止' },
        after: { 设备: '静止' },
        invariants: { 设备: '静止' },
        action_en: '观察设备',
        contact_en: '无接触',
        verification_en: '设备保持静止',
        source_lines: [1],
        phases: [{ start: 0, end: 5, description_en: '展示设备' }]
      }
    }
  ]
})

describe('服务端完整分镜Schema', () => {
  it('一次列出三个镜头的全部空起止状态', () => {
    // const value = candidate()
    const value = {
      ...candidate(),
      scenes: [1, 2, 3].map((id) => ({
        ...candidate().scenes[0],
        id,
        state_transition: { ...candidate().scenes[0].state_transition, before: {}, after: {} }
      }))
    }
    let message = ''
    try {
      validateStoryboard(storyboardSchema, value)
    } catch (error) {
      message = (error as Error).message
    }
    for (const index of [0, 1, 2]) {
      expect(message).toContain(`scenes[${index}].state_transition.before`)
      expect(message).toContain(`scenes[${index}].state_transition.after`)
    }
  })
  it('允许不提供prompt_en并保留全部合法字段', () => {
    const value = candidate()
    const before = JSON.stringify(value)
    validateStoryboard(storyboardSchema, value)
    expect(JSON.stringify(value)).toBe(before)
  })
  it('拒绝旧六字段、空状态、重复候选和未知字段', () => {
    for (const patch of [
      { state_transition: {} },
      { operation_type_options: ['inspect', 'inspect'] },
      { secret: 'x' },
      { state_transition: null }
    ]) {
      const value = candidate()
      Object.assign(value.scenes[0], patch)
      expect(() => validateStoryboard(storyboardSchema, value)).toThrow()
    }
    const value = candidate()
    Reflect.deleteProperty(value.scenes[0], 'operation_type')
    expect(() => validateStoryboard(storyboardSchema, value)).toThrow()
  })
  it('使用最新运行时Schema而非固定旧版本', () => {
    const schema = structuredClone(storyboardSchema)
    schema.required = [...(schema.required as string[]), 'worker_look']
    expect(() => validateStoryboard(schema, candidate())).toThrow()
  })
})
