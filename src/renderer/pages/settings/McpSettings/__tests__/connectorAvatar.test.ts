import { describe, expect, it } from 'vitest'

import { getConnectorFallbackStyle, getConnectorInitial } from '../connectorAvatar'

describe('connectorAvatar', () => {
  it('按 Unicode 字符取连接器名称首字', () => {
    expect(getConnectorInitial('  filesystem')).toBe('F')
    expect(getConnectorInitial('天气服务')).toBe('天')
    expect(getConnectorInitial('')).toBe('?')
  })

  it('同名连接器始终使用相同回退样式', () => {
    expect(getConnectorFallbackStyle('filesystem')).toBe(getConnectorFallbackStyle('filesystem'))
    expect(getConnectorFallbackStyle('filesystem')).not.toBe('')
  })
})
