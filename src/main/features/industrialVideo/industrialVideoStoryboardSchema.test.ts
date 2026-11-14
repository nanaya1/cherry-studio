import { describe, expect, it } from 'vitest'

import { IpcError } from '@shared/ipc/errors/IpcError'

import {
  storyboardSchema,
  validateFullScript,
  validateStageCapacity,
  validateStoryboard,
  validateStateInvariants
} from './industrialVideoStoryboardSchema'

describe('阶段容量与Unicode计长', () => {
  it('字符串长度按码点，嵌套数组及anyOf仍保留上下限与其他约束', () => {
    const schema = {
      type: 'object',
      properties: {
        values: {
          type: 'array',
          items: {
            anyOf: [{ type: 'string', minLength: 2, maxLength: 2 }, { const: { from: 'before' } }]
          }
        }
      },
      required: ['values']
    }
    expect(() => validateStoryboard(schema, { values: ['😀𠀀', { from: 'before' }] })).not.toThrow()
    expect(() => validateStoryboard(schema, { values: ['😀'] })).toThrow()
    expect(() => validateStoryboard(schema, { values: ['😀𠀀a'] })).toThrow()
    expect(() => validateStoryboard(schema, { values: ['a\nb'] })).toThrow()
    expect(() => validateStoryboard(schema, { values: [42] })).toThrow()
  })
  const task = { stage: 'outline', context: { document_segments: [{ id: 't1', text: '😀'.repeat(800) }] } }
  const output = {
    entities: [{ attributes: Array(24).fill('condition') }],
    scenes: [{ narration_segment_ids: ['t1'] }]
  }
  it('800码点恰好4行与24项总属性接受且不修改候选', () => {
    const original = structuredClone(output)
    expect(() => validateStageCapacity(task, output)).not.toThrow()
    expect(output).toEqual(original)
  })
  it('801码点旁白在本地阻断，报告800字符及4行限制', () => {
    expect(() =>
      validateStageCapacity({ ...task, context: { document_segments: [{ id: 't1', text: 'a'.repeat(801) }] } }, output)
    ).toThrow('800')
  })
  it('跨片段拼接计长保留空格标点，不按单片段分别放行', () => {
    const segmented = {
      ...task,
      context: {
        document_segments: [
          { id: 'a', text: 'a'.repeat(400) },
          { id: 'b', text: ' '.repeat(400) + '!' }
        ]
      }
    }
    expect(() =>
      validateStageCapacity(segmented, { ...output, scenes: [{ narration_segment_ids: ['a', 'b'] }] })
    ).toThrow('801')
  })
  it('长度正则不能拆代理对绕过上下限，原pattern仍生效', () => {
    const schema = {
      type: 'object',
      properties: { text: { type: 'string', minLength: 2, maxLength: 2, pattern: '^😀' } }
    }
    expect(() => validateStoryboard(schema, { text: '😀' })).toThrow()
    expect(() => validateStoryboard(schema, { text: '😀a' })).not.toThrow()
    expect(() => validateStoryboard(schema, { text: 'ab' })).toThrow()
    expect(() => validateStoryboard(schema, { text: '😀a\n' })).toThrow()
  })
  it('跨实体合计25属性在本地阻断', () => {
    expect(() =>
      validateStageCapacity(task, { ...output, entities: [...output.entities, { attributes: ['state'] }] })
    ).toThrow('24')
  })
  it('缺片段上下文或未知片段明确阻断，不猜测文本', () => {
    expect(() => validateStageCapacity({ stage: 'outline', context: {} }, output)).toThrow()
    expect(() => validateStageCapacity(task, { ...output, scenes: [{ narration_segment_ids: ['missing'] }] })).toThrow()
  })
  it('copy使用服务端narration_lines检查4行上限，state不做outline假设', () => {
    expect(() =>
      validateStageCapacity({ stage: 'copy', context: { narration_lines: Array(5).fill({ text: 'a' }) } }, {})
    ).toThrow('4')
    expect(() => validateStageCapacity({ stage: 'state', context: {} }, {})).not.toThrow()
  })
})

describe('状态任务不变量一致性', () => {
  const output = (before: Record<string, unknown>, after: Record<string, unknown>) => ({
    state_transition: { before, after, invariant_keys: ['screen'] }
  })
  it('拒绝把显示内容变化混入声明不变的完好状态', () => {
    expect(() =>
      validateStateInvariants({}, output({ screen: '完整，未显示模型' }, { screen: '完整，显示模型' }))
    ).toThrow('screen')
  })
  it('接受原值引用及完全相同的状态，不改写候选', () => {
    const candidate = output({ screen: '完整' }, { screen: { from: 'before' } })
    const original = structuredClone(candidate)
    expect(() => validateStateInvariants({}, candidate)).not.toThrow()
    expect(candidate).toEqual(original)
    expect(() => validateStateInvariants({}, output({ screen: '完整' }, { screen: '完整' }))).not.toThrow()
  })
  it('连续镜头使用服务端locked_before而非候选伪造的before', () => {
    expect(() =>
      validateStateInvariants(
        { context: { locked_before: { screen: '完整' } } },
        output({ screen: '破损' }, { screen: '破损' })
      )
    ).toThrow('screen')
  })
})

// 全文 output_schema 的 text 字段通常携带动态 minLength/maxLength（由服务端按任务返回）。
const fullScriptSchema = (extra: Record<string, unknown> = {}) =>
  ({
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string', minLength: 1, maxLength: 10 }, ...extra }
  }) as unknown as Record<string, unknown>

const captureIpcError = (fn: () => unknown): IpcError => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(IpcError)
    return error as IpcError
  }
  throw new Error('expected IpcError but nothing threw')
}

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

describe('阶段状态对象常量', () => {
  const schema = {
    type: 'object',
    required: ['after'],
    additionalProperties: false,
    properties: { after: { anyOf: [{ type: 'string', minLength: 1 }, { const: { from: 'before' } }] } }
  }

  it('接受经过JSON传输的新对象引用，不修改Schema或候选', () => {
    const value = JSON.parse('{"after":{"from":"before"}}')
    const original = JSON.stringify({ schema, value })
    expect(() => validateStoryboard(schema, value)).not.toThrow()
    expect(JSON.stringify({ schema, value })).toBe(original)
  })

  it.each([{ from: 'previous' }, { from: 'before', extra: true }, {}, { wrong: 'before' }, null, ['before']])(
    '拒绝不等于对象常量的引用 %j',
    (after) => {
      expect(() => validateStoryboard(schema, { after })).toThrow()
    }
  )

  it('保留字符串分支及其长度约束', () => {
    expect(() => validateStoryboard(schema, { after: '保持原位' })).not.toThrow()
    expect(() => validateStoryboard(schema, { after: '' })).toThrow()
  })
})

describe('Schema 纯空白字符串校验（minLength>=1）', () => {
  const minSchema = (extra: Record<string, unknown> = {}) =>
    ({
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 }, ...extra },
      required: ['text']
    }) as unknown as Record<string, unknown>

  it('顶层声明 minLength>=1 的字段纯空白被拒', () => {
    expect(() => validateStoryboard(minSchema(), { text: '   ' })).toThrow(/不能仅含空白字符/)
  })

  it('嵌套对象内的 minLength>=1 字段纯空白被拒', () => {
    const schema = {
      type: 'object',
      properties: {
        scene: { type: 'object', properties: { title: { type: 'string', minLength: 2 } }, required: ['title'] }
      }
    } as unknown as Record<string, unknown>
    expect(() => validateStoryboard(schema, { scene: { title: '\t\n ' } })).toThrow(/不能仅含空白字符/)
  })

  it('数组元素内的 minLength>=1 字段纯空白被拒', () => {
    const schema = {
      type: 'object',
      properties: {
        scenes: {
          type: 'array',
          items: { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'] }
        }
      },
      required: ['scenes']
    } as unknown as Record<string, unknown>
    expect(() => validateStoryboard(schema, { scenes: [{ title: '  ' }] })).toThrow(/不能仅含空白字符/)
  })

  it('minLength>=1 的合法非空串通过校验', () => {
    expect(() => validateStoryboard(minSchema(), { text: 'ok' })).not.toThrow()
  })

  it('未声明 minLength 的字段允许纯空白', () => {
    const schema = {
      type: 'object',
      properties: { note: { type: 'string' } }
    } as unknown as Record<string, unknown>
    expect(() => validateStoryboard(schema, { note: '   ' })).not.toThrow()
  })

  it('真实分镜Schema中纯空白 video_title 被拒', () => {
    const value = { ...candidate(), video_title: '   ' }
    expect(() => validateStoryboard(storyboardSchema, value)).toThrow(/不能仅含空白字符/)
  })
})

describe('全文专用本地校验（validateFullScript）', () => {
  it('超长 text 给出动态上限、实际字符与超出数，且为全文专用错误码', () => {
    const text = 'x'.repeat(15)
    const error = captureIpcError(() => validateFullScript(fullScriptSchema(), text))
    expect(error.code).toBe('IVIDEO_FULL_SCRIPT_SCHEMA_INVALID')
    expect(error.message).toContain('上限 10')
    expect(error.message).toContain('实际 15')
    expect(error.message).toContain('超出 5')
    expect(error.message).not.toContain('分镜')
  })

  it('不足动态 minLength 给出下限与实际字符', () => {
    const error = captureIpcError(() =>
      validateFullScript(fullScriptSchema({ text: { type: 'string', minLength: 10, maxLength: 100 } }), 'abc')
    )
    expect(error.code).toBe('IVIDEO_FULL_SCRIPT_SCHEMA_INVALID')
    expect(error.message).toContain('下限 10')
    expect(error.message).toContain('实际 3')
  })

  it('合法的 text 通过完整 schema 校验', () => {
    expect(() => validateFullScript(fullScriptSchema(), '完整全文')).not.toThrow()
  })

  it('保留完整 schema 结构校验：不符合 text 约束给出全文结构失败提示', () => {
    const schema = {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string', pattern: '^[a-z]+$' } }
    } as unknown as Record<string, unknown>
    const error = captureIpcError(() => validateFullScript(schema, 'ABC'))
    expect(error.code).toBe('IVIDEO_FULL_SCRIPT_SCHEMA_INVALID')
    expect(error.message).toContain('全文结构校验失败')
  })

  it('Unicode 长度遵守服务端及 JSON Schema 的码点口径', () => {
    const schema = fullScriptSchema({ text: { type: 'string', minLength: 1, maxLength: 4 } })
    expect(() => validateFullScript(schema, '😀😀😀😀')).not.toThrow()
    const error = captureIpcError(() => validateFullScript(schema, '😀😀😀😀😀'))
    expect(error.message).toContain('上限 4')
    expect(error.message).toContain('实际 5')
    expect(error.message).toContain('超出 1')
  })
})
