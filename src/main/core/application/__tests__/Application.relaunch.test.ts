import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Application } from '../Application'

vi.unmock('@application')
const platform = vi.hoisted(() => ({ isDev: false, isLinux: false, isMac: false, isPortable: false, isWin: false }))
vi.mock('@main/core/platform', () => platform)

describe('packaged application relaunch', () => {
  beforeEach(() => {
    Object.assign(platform, { isDev: false, isLinux: false, isMac: false, isPortable: false, isWin: false })
    Object.assign(app, { isPackaged: true, relaunch: vi.fn(), releaseSingleInstanceLock: vi.fn(), exit: vi.fn() })
    ;(Application as unknown as { instance: Application | null }).instance = null
    vi.spyOn(process, 'argv', 'get').mockReturnValue([process.execPath, '--original-launch'])
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it.each(['isMac', 'isWin'] as const)('uses the running executable and preserves arguments on %s', (os) => {
    platform[os] = true
    Application.getInstance().relaunch()
    expect(app.relaunch).toHaveBeenCalledWith({ execPath: process.execPath, args: ['--original-launch'] })
    expect(app.releaseSingleInstanceLock).toHaveBeenCalledTimes(1)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('uses the portable launcher instead of its temporary extracted executable', () => {
    Object.assign(platform, { isWin: true, isPortable: true })
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', 'C:\\MEA Cowork\\MEA portable.exe')
    Application.getInstance().relaunch()
    expect(app.relaunch).toHaveBeenCalledWith({
      execPath: 'C:\\MEA Cowork\\MEA portable.exe',
      args: []
    })
  })

  it('preserves caller options without mutating the supplied arguments', () => {
    platform.isLinux = true
    vi.stubEnv('APPIMAGE', '/opt/MEA Cowork.AppImage')
    const options = { args: ['--custom'] }
    Application.getInstance().relaunch(options)
    expect(app.relaunch).toHaveBeenCalledWith({
      execPath: '/opt/MEA Cowork.AppImage',
      args: ['--appimage-extract-and-run', '--custom']
    })
    expect(options).toEqual({ args: ['--custom'] })
  })

  it('allows retry when Electron rejects scheduling the relaunch', () => {
    const application = Application.getInstance()
    vi.mocked(app.relaunch).mockImplementationOnce(() => {
      throw new Error('launch failed')
    })
    expect(() => application.relaunch()).toThrow('launch failed')
    expect(application.isRelaunching).toBe(false)
    expect(app.exit).not.toHaveBeenCalled()
    application.relaunch()
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('marks relaunch before scheduling it and does not schedule twice', () => {
    const application = Application.getInstance()
    vi.mocked(app.relaunch).mockImplementation(() => {
      expect(application.isRelaunching).toBe(true)
    })
    application.relaunch()
    application.relaunch()
    expect(app.relaunch).toHaveBeenCalledTimes(1)
  })
})
