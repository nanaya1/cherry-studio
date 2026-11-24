import { useCallback, useEffect, useState } from 'react'

/** MEA:enterprise-knowledge-page 键变化立即隐藏旧结果；失败不伪装为空，迟到响应不能回填新页面。 */
export function useInspectionQuery<T>(load: () => Promise<T>) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ load: typeof load; revision: number; data?: T; error?: string }>()
  useEffect(() => {
    // 每次请求使用独立闭包；切换条件或卸载后，旧结果不再写回。
    let active = true
    setState(undefined)
    void load().then(
      (data) => {
        if (active) setState({ load, revision, data })
      },
      (error: unknown) => {
        if (active) setState({ load, revision, error: error instanceof Error ? error.message : String(error) })
      }
    )
    return () => {
      active = false
    }
  }, [load, revision])
  const current = state?.load === load && state.revision === revision ? state : undefined
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  return { data: current?.data, error: current?.error, loading: !current, reload }
}
