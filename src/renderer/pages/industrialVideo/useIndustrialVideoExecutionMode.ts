import { useEffect, useState } from 'react'

import { ipcApi } from '@renderer/ipc'
import type { IndustrialVideoExecutionMode } from '@shared/ai/industrialVideoExecutionMode'
import type { IndustrialVideoProductionRecord } from '@shared/data/cache/cacheValueTypes'

// MEA:industrial-video 分流只信任 main 绑定；读取完成前不得挂载会自动推进的专用编排。
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
      (record) => {
        if (active)
          setBinding({
            sessionId,
            mode: (record as IndustrialVideoProductionRecord | null)?.execution_mode ?? 'native'
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
