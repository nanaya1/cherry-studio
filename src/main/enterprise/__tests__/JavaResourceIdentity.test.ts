import { describe, expect, it } from 'vitest'

import { javaResourceFolderName, javaResourceKey, parseJavaResourceKey } from '../JavaResourceIdentity'

const server = '11111111111141118111111111111111'

describe('Java资源身份', () => {
  it('接受线上Java返回的带横杠实例ID，且不改写其身份', () => {
    const instance = '9a38eaa8-d367-41b3-b8e2-90cebef54422'
    for (const type of ['skill', 'mcp'] as const) {
      const key = javaResourceKey(instance, type, '7')
      expect(parseJavaResourceKey(key)).toEqual({ serverInstanceId: instance, resourceType: type, resourceId: '7' })
      expect(javaResourceFolderName(key)).not.toBe(
        javaResourceFolderName(javaResourceKey(instance.replaceAll('-', ''), type, '7'))
      )
    }
  })

  it.each(['生产实例', 'MEA-prod-01', '../outside', 'a:b', 'a\nb', ' a ', 'x%2Fy'])(
    '非UUID实例原值可往返且不会进入目录路径：%s',
    (instance) => {
      const key = javaResourceKey(instance, 'skill', '7')
      expect(parseJavaResourceKey(key)).toEqual({ serverInstanceId: instance, resourceType: 'skill', resourceId: '7' })
      expect(javaResourceFolderName(key)).toMatch(/^java-skill-[a-f0-9]{64}$/)
      expect(key).toBe(`java-resource:${encodeURIComponent(instance)}:skill:7`)
    }
  )

  it.each(['', ' ', '\n'])('拒绝空白实例标识：%s', (instance) => {
    expect(() => javaResourceKey(instance, 'skill', '7')).toThrow('服务实例标识无效')
    expect(parseJavaResourceKey(`java-resource:${instance}:skill:7`)).toBeNull()
  })
  it.each([
    'java-resource:a%2fb:skill:7',
    'java-resource:%41:skill:7',
    'java-resource:%:skill:7',
    'java-resource:a:b:skill:7',
    'java-resource::skill:7',
    'java-resource:%20:skill:7'
  ])('拒绝非规范或空白编码键：%s', (key) => {
    expect(parseJavaResourceKey(key)).toBeNull()
  })

  it('编码后的分隔符和百分号属于不同实例，不互相认领', () => {
    const first = javaResourceKey('a:b', 'skill', '7')
    const second = javaResourceKey('a%3Ab', 'skill', '7')
    expect(first).not.toBe(second)
    expect(javaResourceFolderName(first)).not.toBe(javaResourceFolderName(second))
    expect(parseJavaResourceKey(first)?.serverInstanceId).toBe('a:b')
    expect(parseJavaResourceKey(second)?.serverInstanceId).toBe('a%3Ab')
  })

  it('同名资源按真实ID隔离，不依赖slug和名称', () => {
    const first = javaResourceKey(server, 'skill', '7')
    const second = javaResourceKey(server, 'skill', '8')
    expect(first).not.toBe(second)
    expect(javaResourceFolderName(first)).not.toBe(javaResourceFolderName(second))
    expect(parseJavaResourceKey(first)).toEqual({ serverInstanceId: server, resourceType: 'skill', resourceId: '7' })
  })

  it('不同服务和不同资源类型不能碰撞', () => {
    const keys = [
      javaResourceKey(server, 'skill', '7'),
      javaResourceKey(server, 'mcp', '7'),
      javaResourceKey('22222222222242228222222222222222', 'skill', '7')
    ]
    expect(new Set(keys).size).toBe(3)
    expect(new Set(keys.map(javaResourceFolderName)).size).toBe(3)
  })

  it.each(['0', '-1', '01', '1/../../etc', '9007199254740992', '1.5'])('拒绝非法或失真资源ID：%s', (value) => {
    expect(() => javaResourceKey(server, 'skill', value)).toThrow('资源ID')
  })

  it('资源键只能解析本次原生来源，不认领本地URL或旧slug标识', () => {
    expect(parseJavaResourceKey('org-skill:same-name')).toBeNull()
    expect(parseJavaResourceKey('https://example.test/local')).toBeNull()
    expect(parseJavaResourceKey(null)).toBeNull()
  })

  it('目录名仅包含跨平台安全字符且按同一身份稳定生成', () => {
    const key = javaResourceKey(server, 'skill', '7')
    const folder = javaResourceFolderName(key)
    expect(folder).toMatch(/^java-skill-[a-f0-9]{64}$/)
    expect(javaResourceFolderName(key)).toBe(folder)
    expect(() => javaResourceFolderName('../outside')).toThrow()
  })
})
