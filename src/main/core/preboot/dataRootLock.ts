import lockfile from 'proper-lockfile'

let lockedDataRoot: string | undefined

/**
 * 数据根互斥锁：与 Electron userData 无关，保证同一 dataRoot 只有一个活着的写者。
 * 持锁句柄放在独立模块里，让 Application 的退出路径也能释放而不引入循环依赖。
 */
export function acquireDataRootLock(instanceRoot: string, onCompromised?: (error: Error) => void): boolean {
  try {
    lockfile.lockSync(instanceRoot, {
      realpath: false,
      // proper-lockfile 的同步 API 不支持 retries，否则会在加锁前抛出 ESYNC。
      // retries: { retries: 15, factor: 1, minTimeout: 100, maxTimeout: 400, randomize: true },
      onCompromised
    })
    lockedDataRoot = instanceRoot
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return false
    throw error
  }
}

/** 幂等释放：will-quit、relaunch、forceExit 都会调用。 */
export function releaseDataRootLock(): void {
  const root = lockedDataRoot
  if (!root) return
  lockedDataRoot = undefined
  try {
    lockfile.unlockSync(root, { realpath: false })
  } catch {
    // 锁已被判 stale 或被其他进程接管，忽略
  }
}
