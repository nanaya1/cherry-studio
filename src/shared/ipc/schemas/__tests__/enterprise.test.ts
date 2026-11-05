import { describe, expect, it } from 'vitest'

import { enterpriseRequestSchemas, verificationStatusSchema } from '../enterprise'

describe('enterprise IPC schemas', () => {
  const listSkills = enterpriseRequestSchemas['enterprise.skills.list'].input

  it('Java带横杠实例ID可穿过技能安装、卸载与连接器安装IPC', () => {
    const instance = '9a38eaa8-d367-41b3-b8e2-90cebef54422'
    for (const route of [
      'enterprise.skills.install_resource',
      'enterprise.skills.remove_resource',
      'enterprise.connectors.install_resource'
    ] as const) {
      const type = route.startsWith('enterprise.skills.') ? 'skill' : 'mcp'
      const input = enterpriseRequestSchemas[route].input
      expect(input.safeParse({ resourceKey: `java-resource:${instance}:${type}:7` }).success).toBe(true)
      expect(input.safeParse({ resourceKey: `java-resource:../outside:${type}:7` }).success).toBe(false)
    }
  })

  it.each(['生产实例', 'MEA-prod-01', 'a:b', '../outside', ' a ', 'a\nb'])(
    '非UUID实例通过编码保持IPC身份：%s',
    (instance) => {
      for (const route of [
        'enterprise.skills.install_resource',
        'enterprise.skills.remove_resource',
        'enterprise.connectors.install_resource'
      ] as const) {
        const type = route.startsWith('enterprise.skills.') ? 'skill' : 'mcp'
        expect(
          enterpriseRequestSchemas[route].input.safeParse({
            resourceKey: `java-resource:${encodeURIComponent(instance)}:${type}:7`
          }).success
        ).toBe(true)
      }
    }
  )

  it('Java 连接器安装只接受带资源类型与当前来源的稳定键', () => {
    const input = enterpriseRequestSchemas['enterprise.connectors.install_resource'].input
    expect(input.safeParse({ resourceKey: `java-resource:${'a'.repeat(32)}:mcp:1` }).success).toBe(true)
    for (const value of [
      { slug: 'same' },
      { resourceKey: `java-resource:${'a'.repeat(32)}:skill:1` },
      { resourceKey: `java-resource:${'a'.repeat(32)}:mcp:9007199254740993` },
      { resourceKey: 'invalid' }
    ])
      expect(input.safeParse(value).success).toBe(false)
  })

  it('Java 技能安装拒绝slug、连接器键和失真整数', () => {
    const input = enterpriseRequestSchemas['enterprise.skills.install_resource'].input
    expect(input.safeParse({ resourceKey: `java-resource:${'a'.repeat(32)}:skill:1` }).success).toBe(true)
    for (const value of [
      { slug: 'same' },
      { resourceKey: `java-resource:${'a'.repeat(32)}:mcp:1` },
      { resourceKey: `java-resource:${'a'.repeat(32)}:skill:9007199254740993` }
    ]) {
      expect(input.safeParse(value).success).toBe(false)
    }
  })

  it('validates account-owned verification revisions and authoritative block reasons', () => {
    const status = { owner: 'profile:runtime', revision: 2, state: 'blocked', reason: 'credentials-invalid' }
    expect(verificationStatusSchema.parse(status)).toEqual(status)
    expect(verificationStatusSchema.safeParse({ ...status, revision: -1 }).success).toBe(false)
    expect(verificationStatusSchema.safeParse({ ...status, revision: 1.5 }).success).toBe(false)
    expect(verificationStatusSchema.safeParse({ ...status, reason: 'network-error' }).success).toBe(false)
    expect(verificationStatusSchema.safeParse({ ...status, generation: 5 }).success).toBe(false)
    expect(enterpriseRequestSchemas['enterprise.verification.get'].output.parse(status)).toEqual(status)
    expect(enterpriseRequestSchemas['enterprise.verification.retry'].output.parse(undefined)).toBeUndefined()
  })

  it('accepts both legacy no-input calls and force refresh calls', () => {
    expect(listSkills.safeParse(undefined).success).toBe(true)
    expect(listSkills.safeParse({}).success).toBe(true)
    expect(listSkills.safeParse({ force: true }).success).toBe(true)
  })
})
