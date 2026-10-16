import path from 'node:path'

import { session, type Session } from 'electron'

// eslint-disable-next-line barrel/closed -- session 工具也被 profiles 启动流程使用，避免循环加载。
import { getProfileLaunchContext } from '@main/core/profiles/ProfileRuntimeContext'

export function getBusinessSession(): Session {
  const context = getProfileLaunchContext()
  return context?.mode === 'business'
    ? session.fromPath(path.join(context.profileRoot, 'sessionData'))
    : session.defaultSession
}
