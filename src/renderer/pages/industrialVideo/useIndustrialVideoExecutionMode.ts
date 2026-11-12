import { useEffect, useState } from 'react'

import { ipcApi } from '@renderer/ipc'
import type { IndustrialVideoExecutionMode } from '@shared/ai/industrialVideoExecutionMode'
// import type { IndustrialVideoProductionRecord } from '@shared/data/cache/cacheValueTypes'

// MEA:industrial-video 统一工具链不再读取旧模式绑定，保留记录读取失败时的阻断。
export function useIndustrialVideoExecutionMode(sessionId?: string) {
  const [binding, setBinding] = useState<{
    sessionId: string
    mode: IndustrialVideoExecutionMode
    error?: string
  } | null>(null)
  useEffect(() => {
    if (!sessionId) return
    let active = true
    void ipcApi.request('industrial_video.get_records', { sessionId }).then(
      () => {
        if (active)
          setBinding({
            sessionId,
            // mode: (record as IndustrialVideoProductionRecord | null)?.execution_mode ?? 'native'
            mode: 'native'
          })
      },
      (cause) => {
        if (active) setBinding({ sessionId, mode: 'native', error: String(cause) })
      }
    )
    return () => {
      active = false
    }
  }, [sessionId])
  return {
    mode: binding?.sessionId === sessionId ? binding?.mode : undefined,
    ready: !sessionId || (binding?.sessionId === sessionId && !binding.error),
    error: binding?.sessionId === sessionId ? binding?.error : undefined
  }
}
