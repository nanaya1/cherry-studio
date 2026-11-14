import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@application', () => ({
  application: {
    getPath: () => '/mock/feature.industrialVideoWorkbench.preload_file'
  }
}))

import { IndustrialVideoWorkbenchSecurity } from './industrialVideoWorkbenchSecurity'

describe('industrial workbench security', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('accepts only a registered server entry in its isolated partition', () => {
    const policy = new IndustrialVideoWorkbenchSecurity()
    const url = 'https://video.example/workbench?run=run-a&token=secret'
    const partition = policy.register('session-a', 'run-a', url, 'https://video.example')
    expect(policy.allowsEntry(partition, url)).toBe(true)
    expect(policy.allowsEntry(partition, 'https://evil.example/workbench?run=run-a')).toBe(false)
    expect(policy.allowsEntry(partition, 'https://video.example/workbench?run=other')).toBe(false)
    expect(policy.allowsEntry('industrial-video-workbench:unknown:run-a', url)).toBe(false)
    expect(() => policy.register('s', 'r', 'https://evil.example/workbench?run=r', 'https://video.example')).toThrow()
    expect(policy.allowsRequest(partition, 'file:///etc/passwd')).toBe(false)
    expect(policy.allowsRequest(partition, 'https://evil.example/app.js')).toBe(false)
    expect(policy.allowsRequest(partition, 'https://video.example/assets/app.js')).toBe(true)
  })
  it('locks down guest preferences and injects only the dedicated bridge preload', () => {
    const policy = new IndustrialVideoWorkbenchSecurity()
    const url = 'https://video.example/workbench?run=r&token=secret'
    const partition = policy.register('s', 'r', url, 'https://video.example')
    const event = { preventDefault: vi.fn() }
    const prefs = { preload: '/unsafe.js', nodeIntegration: true } as Record<string, unknown>
    expect(policy.attach(event, prefs, { partition, src: url })).toBe(true)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(prefs).toMatchObject({ nodeIntegration: false, sandbox: true, contextIsolation: true, webSecurity: true })
    expect(prefs.preload).toBe('/mock/feature.industrialVideoWorkbench.preload_file')
    policy.attach(event, {}, { partition, src: '' })
    expect(event.preventDefault).not.toHaveBeenCalled()
    policy.attach(event, {}, { partition: 'industrial-video-workbench:unknown:r', src: url })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(policy.attach(event, {}, { partition: 'unrelated', src: url })).toBe(false)
  })
})
